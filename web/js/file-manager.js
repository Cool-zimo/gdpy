/**
 * 文件管理器 v2
 * 核心抽象：用户只看到 /drive_home 下的统一文件系统
 * 实际文件可能拆分后散落在多个 GitHub 仓库中
 */
class FileManager {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
        this.currentPath = '/drive_home';
    }

    // ==================== 目录导航 ====================
    setCurrentPath(path) {
        this.currentPath = Storage.normalizePath(path);
    }

    // 兼容旧调用的别名方法
    getBreadcrumb(path) { return this.getBreadcrumbs(path); }
    setCurrentRepo(repo) { /* 统一目录视图不需要当前仓库概念 */ }
    get currentRepo() { return null; }

    getCurrentPath() { return this.currentPath; }

    async listFiles(path = this.currentPath) {
        path = Storage.normalizePath(path);
        return this.storage.listDirectory(path);
    }

    getBreadcrumbs(path = this.currentPath) {
        path = Storage.normalizePath(path);
        const parts = path.substring('/drive_home'.length).split('/').filter(Boolean);
        // ★ 根显示"网盘" —— 与桌面版 textutil.py 的 ROOT_LABEL 一致。
        //   drive_home 是内部实现，不该暴露给用户。
        const crumbs = [{ name: BREADCRUMB_ROOT_LABEL, path: '/drive_home' }];
        let current = '/drive_home';
        parts.forEach(part => {
            current += '/' + part;
            // ★ 长名截断：不截断的话深层长目录名会把面包屑撑爆
            crumbs.push({ name: shortenName(part), path: current });
        });

        // ★ 折叠：超过 BREADCRUMB_MAX 时保留根 + 末尾若干级，中间折叠
        //   不折叠的话，深路径只能靠横向滚动才能看到当前位置
        //   （CSS 是 max-width:45% + overflow-x:auto，当前项经常被滚出视野）
        if (crumbs.length > BREADCRUMB_MAX) {
            const tail = Math.max(1, BREADCRUMB_MAX - 2);
            return [crumbs[0],
                    { name: BREADCRUMB_ELLIPSIS, path: null }]
                   .concat(crumbs.slice(crumbs.length - tail));
        }
        return crumbs;
    }

    // ==================== 智能仓库分配 ====================
    async autoSelectRepo(neededSize) {
        const config = this.storage.getStorageConfig();
        const currentUser = this.storage.getUser()?.login;
        let repos = this.storage.getRepos();

        // ★ 分块超过单仓上限时直接报错，不能走进下面的 autoCreateRepo
        //
        //   否则 canRepoFit 永远 false → 每个分片都 create_repo。
        //   500MB 文件 × 512KB 分片 = 上千次 create_repo，
        //   而且新建的仓库同样装不下 —— 问题没解决只是被放大。
        //
        //   ★ 这个保护此前只在桌面版 Python 侧做过（v0.0.9），
        //     js 侧（线上实际在跑的这份）从来没修 —— 双实现的代价。
        if (neededSize > config.maxRepoSize) {
            throw new Error(
                `单个分块 ${Storage.formatBytes(neededSize)} 超过仓库上限 ` +
                `${Storage.formatBytes(config.maxRepoSize)}，无法上传`);
        }
        
        // 关键修复：只选择 owner 和当前用户匹配的仓库，避免访问其他账号的仓库导致 401
        if (currentUser) {
            const validRepos = repos.filter(r => r.owner === currentUser);
            if (validRepos.length !== repos.length) {
                console.warn(`[FileManager] 过滤掉 ${repos.length - validRepos.length} 个 owner 不匹配的仓库`);
                repos = validRepos;
                this.storage.setRepos(validRepos);
            }
        }

        const defaultRepo = this.storage.getDefaultRepo();
        if (defaultRepo && defaultRepo.owner === currentUser && this.storage.canRepoFit(defaultRepo.owner, defaultRepo.repo, neededSize)) {
            return defaultRepo;
        }

        const otherRepos = repos
            .filter(r => !r.isDefault)
            .sort((a, b) => this.storage.getRepoRemaining(b.owner, b.repo) - this.storage.getRepoRemaining(a.owner, a.repo));
        for (const repo of otherRepos) {
            if (this.storage.canRepoFit(repo.owner, repo.repo, neededSize)) {
                return repo;
            }
        }

        if (config.autoCreateRepo) {
            return await this.autoCreateStorageRepo();
        }

        throw new Error('所有仓库容量不足，且未开启自动创建仓库功能');
    }

    async autoCreateStorageRepo() {
        const config = this.storage.getStorageConfig();
        const date = new Date().toISOString().split('T')[0];
        const random = Math.random().toString(16).substring(2, 6);
        const repoName = `${config.repoNamePrefix}-${date}-${random}`;

        console.log(`[FileManager] 自动创建存储仓库: ${repoName}`);
        const repo = await this.api.createRepository(repoName, true, 'GitHub Drive 自动创建的存储仓库');
        const repoInfo = {
            owner: repo.owner.login,
            repo: repo.name,
            name: repo.name,
            branch: 'main',
            isDefault: this.storage.getRepos().length === 0
        };
        this.storage.addRepo(repoInfo);
        return repoInfo;
    }

    // ==================== 文件上传（支持自动拆分） ====================
    async uploadFile(file, targetPath = this.currentPath, onProgress = null) {
        const config = this.storage.getStorageConfig();
        const virtualPath = Storage.normalizePath(targetPath) + '/' + file.name;
        const totalSize = file.size;
        const chunks = [];

        // ★ 覆盖上传会泄漏旧分片（线上实测：56.2MB / 45 个文件因此丢失）
        //
        //   成因：每次上传都新建随机目录 `mtrand/filename`，
        //   VFS 只指向最新那份，旧目录的 blob 从不删除 ——
        //   save.json 在仓库里累积了 4 份、math_history.json 3 份。
        //
        //   所以这里必须先记住旧记录，等新版本写入成功后再清理。
        //   ★ 顺序不能反：先删旧的、新上传又失败 = 文件彻底没了。
        const oldFile = this.storage.getFile(virtualPath);
        const oldChunks = (oldFile && Array.isArray(oldFile.chunks))
            ? oldFile.chunks.slice() : [];

        console.log(`[FileManager] 上传文件: ${file.name}, 大小: ${Storage.formatBytes(totalSize)}`);

        const needSplit = totalSize > config.minChunkSize;
        const chunkSize = needSplit ? config.chunkSize : totalSize;
        const totalChunks = Math.ceil(totalSize / chunkSize);

        // 模拟进度，避免 0→100% 跳变
        let simulateTimer = null;
        let simulatedPercent = 0;
        
        const startSimulate = (fromPercent, toPercent) => {
            if (!onProgress) return;
            if (simulateTimer) clearInterval(simulateTimer);
            simulatedPercent = fromPercent;
            simulateTimer = setInterval(() => {
                // 模拟进度增长，越接近目标越慢
                const remaining = toPercent - simulatedPercent;
                const step = Math.max(0.3, remaining * 0.08) + Math.random() * 0.5;
                simulatedPercent = Math.min(simulatedPercent + step, toPercent - 0.5);
                onProgress(Math.round(simulatedPercent));
            }, 150);
        };
        
        const stopSimulate = () => {
            if (simulateTimer) { clearInterval(simulateTimer); simulateTimer = null; }
        };

        try {
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, totalSize);
            const chunkBlob = file.slice(start, end);
            const chunkSizeActual = end - start;

            const repo = await this.autoSelectRepo(chunkSizeActual);
            const chunkFileName = totalChunks > 1 ? `${file.name}.${i + 1}` : file.name;
            const chunkPath = `${Date.now().toString(36)}/${chunkFileName}`;

            console.log(`[FileManager] 分片 ${i + 1}/${totalChunks}: ${Storage.formatBytes(chunkSizeActual)} → ${repo.name}/${chunkPath}`);

            // 启动当前分片的模拟进度
            const fromP = (i / totalChunks) * 100;
            const toP = ((i + 1) / totalChunks) * 100;
            startSimulate(fromP, toP);

            const arrayBuffer = await chunkBlob.arrayBuffer();
            if (chunkSizeActual > 1024 * 1024) {
                await this.api.uploadLargeFile(repo.owner, repo.repo, chunkPath, arrayBuffer, `上传分片: ${chunkFileName}`, repo.branch);
            } else {
                const base64 = this.arrayBufferToBase64(arrayBuffer);
                await this.api.createOrUpdateFileBinary(repo.owner, repo.repo, chunkPath, base64, `上传分片: ${chunkFileName}`, repo.branch);
            }

            let sha = '';
            try {
                const fileInfo = await this.api.getFileContents(repo.owner, repo.repo, chunkPath, repo.branch);
                sha = fileInfo.sha || '';
            } catch (e) { /* 忽略 */ }

            chunks.push({
                owner: repo.owner,
                repo: repo.repo,
                path: chunkPath,
                size: chunkSizeActual,
                sha: sha,
                branch: repo.branch
            });

            this.storage.addToRepoUsage(repo.owner, repo.repo, chunkSizeActual);

            stopSimulate();
            if (onProgress) onProgress(Math.round(toP));
        }
        } catch (uploadError) {
            // 上传失败，清理已上传的分片，避免垃圾文件堆积
            console.warn(`[FileManager] 上传失败，正在清理 ${chunks.length} 个已上传分片...`);
            
            // 401/404 错误：可能是仓库列表里有无效仓库（其他账号的或已删除的），自动清理
            if (uploadError.status === 401 || uploadError.status === 404) {
                const currentUser = this.storage.getUser()?.login;
                if (currentUser) {
                    const repos = this.storage.getRepos();
                    const validRepos = repos.filter(r => r.owner === currentUser);
                    if (validRepos.length !== repos.length) {
                        console.warn(`[FileManager] 自动清理 ${repos.length - validRepos.length} 个无效仓库记录`);
                        this.storage.setRepos(validRepos);
                    }
                }
                uploadError.message = uploadError.status === 401 
                    ? 'Token 无效或仓库无权限，已自动清理无效仓库记录，请重试'
                    : '仓库不存在或无权限，已自动清理无效仓库记录，请重试';
            }
            for (const chunk of chunks) {
                try {
                    if (chunk.sha) {
                        await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path, `清理上传失败的分片: ${chunk.path}`, chunk.branch, chunk.sha);
                        this.storage.subtractFromRepoUsage?.(chunk.owner, chunk.repo, chunk.size);
                    }
                } catch (cleanupError) {
                    console.warn(`[FileManager] 清理分片失败: ${chunk.path}`, cleanupError.message);
                }
            }
            console.log(`[FileManager] 已清理 ${chunks.length} 个分片`);
            throw uploadError;
        }

        const fileInfo = this.storage.putFile(virtualPath, {
            name: file.name,
            size: totalSize,
            chunks: chunks
        });

        // ★ 新版本已写入 VFS，此时旧分片才真正成为孤儿，可以安全清理
        if (oldChunks.length) {
            await this._cleanupOrphanChunks(oldChunks, virtualPath);
        }

        console.log(`[FileManager] 上传完成: ${virtualPath}, 共 ${chunks.length} 个分片`);
        return { virtualPath, fileInfo, chunks, split: totalChunks > 1 };
    }

    async uploadFiles(files, targetPath = this.currentPath, onProgress = null) {
        const results = [];
        for (let i = 0; i < files.length; i++) {
            const result = await this.uploadFile(files[i], targetPath, (percent) => {
                if (onProgress) onProgress(i, percent, files.length);
            });
            results.push(result);
        }
        return { count: files.length, results };
    }

    // ==================== 文件下载（自动合并分片） ====================
    async downloadFile(virtualPath, onProgress = null) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        console.log(`[FileManager] 下载文件: ${virtualPath}, 分片数: ${fileInfo.chunks.length}`);

        const parts = [];
        const totalChunks = fileInfo.chunks.length;
        for (let i = 0; i < totalChunks; i++) {
            const chunk = fileInfo.chunks[i];
            console.log(`[FileManager] 下载分片 ${i + 1}/${totalChunks}: ${chunk.repo}/${chunk.path}`);
            const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
            if (content instanceof Uint8Array) {
                parts.push(content);
            } else if (content instanceof ArrayBuffer) {
                parts.push(new Uint8Array(content));
            } else {
                throw new Error('分片数据类型错误');
            }
            if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100), i + 1, totalChunks);
        }
        const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) { merged.set(p, offset); offset += p.length; }
        const mergedBlob = new Blob([merged], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(mergedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileInfo.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        this.storage.addToRecent(virtualPath);
        console.log(`[FileManager] 下载完成: ${fileInfo.name}`);
    }


    // 写入文本文件内容（用于在线编辑器）
    async writeFileContent(virtualPath, content) {
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');
        
        const chunks = this.storage.getFileChunks(virtualPath);
        if (!chunks || chunks.length === 0) throw new Error('文件分片信息不存在');
        
        // 使用第一个分片的仓库信息
        const chunk = chunks[0];
        const fileName = virtualPath.split('/').pop();
        
        // 对于小文件，直接覆盖写入
        if (content.length < 1024 * 1024) { // 小于1MB
            const base64 = btoa(unescape(encodeURIComponent(content)));
            await this.api.createOrUpdateFile(
                chunk.owner, chunk.repo, chunk.path,
                base64,
                `编辑文件: ${fileName}`,
                chunk.branch || 'main',
                chunk.sha || null
            );
            
            // 更新本地文件信息
            this.storage.updateFile(virtualPath, {
                size: new Blob([content]).size,
                modified: new Date().toISOString()
            });
            
            return true;
        }
        
        throw new Error('文件过大，请使用上传功能');
    }

    async getFileContent(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        const parts = [];
        for (const chunk of fileInfo.chunks) {
            const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
            parts.push(content);
        }
        // 合并所有分片的字节，再按 UTF-8 解码为文本
        const totalLen = parts.reduce((sum, p) => sum + (p.length || 0), 0);
        if (totalLen === 0) return '';
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
        }
        return new TextDecoder('utf-8').decode(merged);
    }

    /**
     * 获取文件二进制内容（Blob），用于预览和下载
     */
    async getFileBlob(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');
        if (!fileInfo.chunks || fileInfo.chunks.length === 0) throw new Error('文件分片信息缺失');

        const parts = [];
        for (let i = 0; i < fileInfo.chunks.length; i++) {
            const chunk = fileInfo.chunks[i];
            try {
                const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
                // 确保是 Uint8Array
                if (content instanceof Uint8Array) {
                    parts.push(content);
                } else if (content instanceof ArrayBuffer) {
                    parts.push(new Uint8Array(content));
                } else if (typeof content === 'string') {
                    // base64 字符串，转换
                    const binary = atob(content);
                    const bytes = new Uint8Array(binary.length);
                    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                    parts.push(bytes);
                } else {
                    console.warn('[FileManager] 分片 ' + i + ' 返回未知类型:', typeof content);
                    throw new Error('分片数据类型错误');
                }
            } catch (e) {
                console.error('[FileManager] 下载分片 ' + i + ' 失败:', e);
                throw new Error('下载分片失败: ' + e.message);
            }
        }
        const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
        if (totalLen === 0) throw new Error('文件内容为空');
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
        }
        return new Blob([merged], { type: this.guessMimeType(fileInfo.name) });
    }

    /**
     * 根据文件名猜测 MIME 类型
     */
    guessMimeType(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = {
            pdf: 'application/pdf',
            txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
            css: 'text/css', js: 'application/javascript', json: 'application/json',
            xml: 'application/xml', csv: 'text/csv',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
            svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
            mp4: 'video/mp4', webm: 'video/webm',
            zip: 'application/zip', rar: 'application/vnd.rar',
            '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
            doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        return map[ext] || 'application/octet-stream';
    }

    /**
     * ArrayBuffer 转 base64（用于二进制文件上传）
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    /**
     * 清理孤儿分片（覆盖上传/删除时遗留）
     *
     * ★ 这里**不能抛异常**。调用方（uploadFile）已经成功了，
     *   因为清理旧分片失败就报"上传失败"是错的 —— 文件明明在。
     *   失败的分片记进 pendingOrphanChunks，下次有机会再清。
     */
    async _cleanupOrphanChunks(chunks, why) {
        for (const chunk of chunks) {
            try {
                let sha = chunk.sha;
                try {
                    const fi = await this.api.getFileContents(
                        chunk.owner, chunk.repo, chunk.path, chunk.branch);
                    sha = fi.sha || sha;
                } catch (e) { /* 用记录里的 sha */ }

                if (!sha) {
                    this._pendingOrphan(chunk, why, '无 sha，跳过');
                    continue;
                }
                await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path,
                    `清理孤儿分片: ${chunk.path}`, chunk.branch, sha);
                this.storage.subtractFromRepoUsage?.(
                    chunk.owner, chunk.repo, chunk.size);
            } catch (e) {
                // ★ 不 throw：清理失败不影响主流程，但要留痕
                this._pendingOrphan(chunk, why, e.message);
            }
        }
    }

    _pendingOrphan(chunk, why, err) {
        if (!this.pendingOrphanChunks) this.pendingOrphanChunks = [];
        this.pendingOrphanChunks.push({
            owner: chunk.owner, repo: chunk.repo, path: chunk.path,
            size: chunk.size, why: why, error: err,
            at: new Date().toISOString()
        });
        console.warn(`[FileManager] 孤儿分片清理失败（已记入待清理）: ${chunk.path}`, err);
    }

    // ==================== 文件删除 ====================
    async deleteFile(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        console.log(`[FileManager] 删除文件: ${virtualPath}, 分片数: ${fileInfo.chunks.length}`);

        for (let i = 0; i < fileInfo.chunks.length; i++) {
            const chunk = fileInfo.chunks[i];
            try {
                let sha = chunk.sha;
                try {
                    const fi = await this.api.getFileContents(chunk.owner, chunk.repo, chunk.path, chunk.branch);
                    sha = fi.sha;
                } catch (e) { /* 忽略 */ }

                await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path, `删除分片: ${chunk.path}`, chunk.branch, sha);
                console.log(`[FileManager] 已删除分片 ${i + 1}/${fileInfo.chunks.length}: ${chunk.repo}/${chunk.path}`);
            } catch (e) {
                // ★ 原来是纯 console.warn —— 分片静默留下，
                //   时间一长就变成"界面看不到但占容量"的孤儿数据。
                //   现在记进 pendingOrphanChunks，可被扫描/重试发现。
                this._pendingOrphan(chunk, virtualPath, e.message);
            }
        }

        this.storage.deleteFile(virtualPath);
        console.log(`[FileManager] 文件已从 VFS 删除: ${virtualPath}`);
    }

    // ==================== 文件夹操作 ====================
    async createFolder(folderName, targetPath = this.currentPath) {
        const virtualPath = Storage.normalizePath(targetPath) + '/' + folderName;
        if (this.storage.exists(virtualPath)) {
            throw new Error('文件夹已存在');
        }
        this.storage.putFolder(virtualPath);
        console.log(`[FileManager] 创建文件夹: ${virtualPath}`);
        return { virtualPath, name: folderName };
    }

    async deleteFolder(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        if (virtualPath === '/drive_home') throw new Error('不能删除根目录');

        const items = this.storage.listDirectory(virtualPath);
        console.log(`[FileManager] 删除文件夹: ${virtualPath}, 包含 ${items.length} 个项目`);

        for (const item of items) {
            if (item.isFile) {
                await this.deleteFile(item.path);
            } else if (item.isFolder) {
                await this.deleteFolder(item.path);
            }
        }

        this.storage.deleteFolder(virtualPath);
    }


    // 移动文件
    async moveFile(sourcePath, targetPath) {
        // 读取源文件内容
        const content = await this.getFileContent(sourcePath);
        if (content === null) throw new Error('无法读取源文件');
        // 写入目标位置
        await this.writeFileContent(targetPath, content);
        // 删除源文件
        await this.deleteFile(sourcePath);
        return true;
    }

    async renameItem(virtualPath, newName) {
        virtualPath = Storage.normalizePath(virtualPath);
        const parentPath = Storage.getParentPath(virtualPath);
        const newPath = parentPath + '/' + newName;

        if (this.storage.exists(newPath)) throw new Error('目标名称已存在');

        this.storage.moveItem(virtualPath, newPath);
        console.log(`[FileManager] 重命名: ${virtualPath} → ${newPath}`);
        return { oldPath: virtualPath, newPath, name: newName };
    }

    // ==================== 搜索 ====================
    searchFiles(query) {
        return this.storage.searchFiles(query);
    }

    // ==================== 容量同步 ====================
    async syncAllRepoUsage() {
        const repos = this.storage.getRepos();
        const invalidRepos = [];
        for (const repo of repos) {
            try {
                const repoInfo = await this.api.getRepository(repo.owner, repo.repo);
                const sizeKB = repoInfo.size || 0;
                this.storage.setRepoUsage(repo.owner, repo.repo, sizeKB * 1024);
            } catch (e) {
                // 404 说明仓库不存在，自动移除
                if (e.status === 404) {
                    console.warn(`[FileManager] 仓库不存在，自动移除: ${repo.owner}/${repo.repo}`);
                    invalidRepos.push(repo);
                } else {
                    console.warn(`[FileManager] 同步仓库容量失败: ${repo.name}`, e.message);
                }
            }
        }
        // 移除无效仓库
        for (const repo of invalidRepos) {
            this.storage.removeRepo(repo.owner, repo.repo);
        }
        if (invalidRepos.length > 0) {
            console.log(`[FileManager] 已自动移除 ${invalidRepos.length} 个无效仓库`);
        }
        console.log('[FileManager] 所有仓库容量同步完成');
    }

    // ==================== 工具方法 ====================
    static formatSize(bytes) { return Storage.formatBytes(bytes); }

    static getFileIcon(name, type) {
        if (type === 'dir') return '📁';
        const ext = name.split('.').pop().toLowerCase();
        const icons = {
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️', ico: '🖼️',
            mp4: '🎬', avi: '🎬', mov: '🎬', wmv: '🎬', flv: '🎬', mkv: '🎬', webm: '🎬',
            mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', wma: '🎵', m4a: '🎵',
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
            txt: '📄', md: '📝', json: '📋', xml: '📋', yaml: '📋', yml: '📋',
            js: '📜', ts: '📜', py: '📜', java: '📜', c: '📜', cpp: '📜', go: '📜', rs: '📜',
            html: '🌐', css: '🎨', zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
            exe: '⚙️', dmg: '💿', iso: '💿', apk: '📱', ipa: '📱'
        };
        return icons[ext] || '📄';
    }
}
