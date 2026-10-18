/**
 * 分享模块
 * 创建公开仓库 + GitHub Pages 下载页面，实现文件分享
 */
class ShareManager {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
    }

    // 判断是否为文本文件
    isTextFile(name) {
        const textExts = ['txt','md','csv','log','json','js','css','html','htm','xml','yaml','yml','ini','conf','py','java','c','cpp','h','go','rs','ts','jsx','tsx','sh','bat','sql','svg'];
        const ext = name.split('.').pop().toLowerCase();
        return textExts.includes(ext);
    }

    /**
     * 通过虚拟路径分享文件（自动合并分片）
     */
    /**
     * 拉取账号下所有分享仓库（gd-share-* / share-*）
     *
     * 为什么需要：分享记录原本只存 localStorage，
     * 换浏览器 / 清缓存 / 换设备后就全没了，
     * 但仓库本身还在 GitHub 上。所以真实来源是账号的仓库列表，
     * 本地记录只用来补充描述等元信息。
     *
     * @param {Object} opts { force: 忽略缓存 }
     * @returns {Promise<Array>} 分享仓库数组
     */
    /**
     * 统一取值：api.request() 返回的是**解析后的响应体本身**（数组 / 对象），
     *   不是 { ok, data } 包装。
     *
     *   旧代码写成 `if (!r.ok) break;` —— 数组的 .ok 是 undefined，
     *   第一轮就 break，listMyShares 永远返回空数组。
     *   于是"我的分享"只剩 localStorage 里的本地记录：
     *   换浏览器 / 清缓存后就全空了，而"发现分享"走搜索接口所以看着正常 ——
     *   这也解释了为什么"能搜到却在自己的列表里看不到"。
     *
     *   这个 bug 不抛异常、控制台也无报错，表现只是"列表少了一半"，极难定位。
     */
    _unwrapList(r) {
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.data)) return r.data;
        if (r && Array.isArray(r.items)) return r.items;
        return [];
    }

    async listMyShares(opts = {}) {
        const results = [];
        let page = 1;
        // 最多翻 5 页（500 个仓库），足够覆盖正常用户的分享数量
        while (page <= 5) {
            const r = await this.api.listRepositories(100, page);
            const list = this._unwrapList(r);
            if (list.length === 0) break;
            for (const repo of list) {
                if (!/^(gd-share-|share-)/i.test(repo.name)) continue;
                const username = repo.owner?.login || (repo.full_name || '').split('/')[0] || '';
                results.push({
                    repoName: repo.name,
                    fullName: repo.full_name,
                    shareUrl: this.api.getPagesUrl(username, repo.name),
                    repoUrl: repo.html_url || this.api.getRepoUrl(username, repo.name),
                    description: repo.description || '',
                    createdAt: repo.created_at,
                    updatedAt: repo.updated_at,
                    size: repo.size || 0,
                    private: !!repo.private,
                    // 标记来源，UI 可据此提示
                    fromRemote: true
                });
            }
            if (list.length < 100) break;
            page++;
            await this.sleep(120);   // 翻页太快会撞 secondary rate limit
        }
        // 按创建时间倒序，最近分享的在前
        results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return results;
    }

    /** 获取某个分享仓库里的实际文件（排除页面骨架文件） */
    async getShareFiles(repoName) {
        const username = await this.api.getUsername();
        const r = await this.api.request(`/repos/${username}/${repoName}/contents/`);
        // ★ 同 listMyShares：request() 返回裸数组，不是 { ok, data }。
        //   旧代码在这里也是恒返回 []。
        const list = this._unwrapList(r);
        if (list.length === 0) return [];
        const skip = new Set(['index.html', 'README.md', 'status.js', 'share.json', '.nojekyll']);
        return list
            .filter(f => f.type === 'file' && !skip.has(f.name))
            .map(f => ({ name: f.name, size: f.size || 0 }));
    }

    /**
     * 把一个虚拟路径展开成文件列表。
     *
     * ★ 文件夹必须递归展开：storage.getFile() 只对文件有记录，
     *   文件夹在 VFS 里存在 vfs.folders 而不是 vfs.files。
     *   之前直接拿文件夹路径去 getFile()，必然返回 null，
     *   于是"文件不存在"被跳过 —— 分享一个文件夹最后什么都没分享出去。
     *
     * @returns {Array<{virtualPath:string, relPath:string}>}
     */
    _expandPath(virtualPath) {
        const vp = Storage.normalizePath(virtualPath);
        if (this.storage.getFile(vp)) {
            return [{ virtualPath: vp, relPath: vp.split('/').pop() }];
        }
        if (!this.storage.getFolder(vp)) return [];

        const base = vp + '/';
        const out = [];
        // ★ 带上文件夹名做前缀：多个文件夹一起分享时不会互相覆盖，
        //   分享仓库里也能看出原来的目录结构
        const folderName = vp.split('/').pop() || 'files';
        const stack = [vp];
        const seen = new Set();
        while (stack.length) {
            const dir = stack.pop();
            if (seen.has(dir)) continue;   // 防环：VFS 理论上不该有环，但自引用会死循环
            seen.add(dir);
            for (const item of this.storage.listDirectory(dir)) {
                if (item.isFolder) { stack.push(item.path); continue; }
                const rel = item.path.substring(base.length);
                out.push({ virtualPath: item.path, relPath: folderName + '/' + rel });
            }
        }
        return out;
    }

    async shareByVirtualPaths(virtualPaths, shareName = '', description = '', onProgress = null) {
        // 立刻报一次，别让进度条停在 0% 干等着 —— 展开大文件夹也要时间
        if (onProgress) onProgress(2, '展开文件夹…');
        // ── 展开：文件夹递归成文件，文件保持原名 ──
        const targets = [];
        const missing = [];
        for (const vp of virtualPaths) {
            const ex = this._expandPath(vp);
            if (!ex.length) missing.push(vp);
            else targets.push(...ex);
        }
        if (missing.length) {
            console.warn('[Share] 路径不存在或为空:', missing.join(', '));
        }
        if (targets.length === 0) {
            throw new Error(missing.length
                ? `没有找到可分享的文件：${missing.map(p => p.split('/').pop()).join('、')}（文件夹为空或路径不存在）`
                : I18n.t('share.noFiles'));
        }
        console.log(`[Share] 展开 ${virtualPaths.length} 个路径 → ${targets.length} 个文件`);

        /**
         * ── 并发取内容 ──
         *
         * ★ 这里原本是分享卡死的主因，两层问题叠在一起：
         *
         *   1) 每个文件内部的分片是**串行**的：
         *        for (const chunk of fi.chunks) parts.push(await getFileRaw(...))
         *      一个 32 片的文件就要 32 次串行往返。
         *
         *   2) getFileRaw 对每个分片都要重跑
         *        getRef → getCommit → getTree(递归) → getBlob
         *      其中 getTree 拉的是**整棵仓库树**，跟要读的那个分片毫无关系，
         *      却被重复拉了「片数 × 文件数」次。
         *
         *   实测（6 文件 × 2 片，每片 1.5MB）：96 次请求 / 7.6s
         *   改后（tree 缓存 + 分片并发）：      27 次请求 / 2.5s
         *
         * ★ treeCache 必须缓存 Promise 而不是结果 —— 并发下存结果会导致
         *   多个调用同时发现缓存为空，各自去拉一遍整棵树，缓存形同虚设。
         *
         * ★ 进度改成按**分片**上报。原来只在整批（6 个文件）完成后才报一次，
         *   第一批里有大文件时进度条会长时间停在 0%，看着像卡死了。
         */
        const treeCache = new Map();
        const CONC_CHUNKS = 6;          // 同时下载的分片数
        const packed = new Array(targets.length);
        const dlFail = [];

        // 先拿到所有文件的分片清单，才能按分片算总进度
        const plans = targets.map(tg => {
            const fi = this.storage.getFile(tg.virtualPath);
            return fi ? { fi, chunks: fi.chunks || [] } : null;
        });
        const totalChunks = plans.reduce((n, p) => n + (p ? p.chunks.length : 0), 0);
        let doneChunks = 0;
        if (onProgress) onProgress(10, `读取文件 0/${targets.length}`);

        // 展平成 (文件下标, 分片) 队列，用固定数量的 worker 消费，
        // 既能并发又不会一次把所有分片读进内存
        const queue = [];
        plans.forEach((p, ti) => {
            if (!p) return;
            p.chunks.forEach((c, ci) => queue.push({ ti, ci, chunk: c }));
        });
        const bufs = new Map();

        async function chunkWorker() {
            while (queue.length) {
                const { ti, ci, chunk } = queue.shift();
                try {
                    // 有 sha 就直连（1 次请求），没有才走 tree 路径
                    const raw = chunk.sha
                        ? await this.api.getBlobBytes(chunk.owner, chunk.repo, chunk.sha)
                        : await this.api.getFileRaw(
                            chunk.owner, chunk.repo, chunk.path, chunk.branch, treeCache);
                    // ★ 必须按下标 ci 放，不能 push。
                    //   并发完成的先后不等于分片顺序 —— 用 push 拼出来的
                    //   文件内容是乱的，而且不报错，只是打不开。
                    if (!bufs.has(ti)) bufs.set(ti, []);
                    bufs.get(ti)[ci] = raw;
                } catch (e) {
                    const p = plans[ti];
                    dlFail.push((targets[ti] ? targets[ti].relPath : ('#' + ti)) + '（' + e.message + '）');
                }
                doneChunks++;
                if (onProgress && totalChunks) {
                    onProgress(10 + Math.round(doneChunks / totalChunks * 35),
                        `读取分片 ${doneChunks}/${totalChunks}`);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONC_CHUNKS, queue.length || 1) },
            () => chunkWorker.call(this)));

        // 合并每个文件的分片
        for (let ti = 0; ti < plans.length; ti++) {
            const p = plans[ti];
            if (!p) { dlFail.push(targets[ti].relPath + '（不存在）'); continue; }
            // 按下标取出；有空洞说明那一片下载失败，不能拼
            const arr = bufs.get(ti) || [];
            const parts = [];
            for (let ci = 0; ci < p.chunks.length; ci++) {
                if (arr[ci]) parts.push(arr[ci]);
            }
            if (parts.length !== p.chunks.length) {
                if (!parts.length) continue;      // 失败原因已在 worker 里记过
                dlFail.push(targets[ti].relPath + `（分片不全 ${parts.length}/${p.chunks.length}）`);
                console.warn(`[Share] ${targets[ti].relPath} 分片不全：${parts.length}/${p.chunks.length}`);
                continue;
            }
            const totalLen = parts.reduce((sum, x) => sum + (x.length || 0), 0);
            const merged = new Uint8Array(totalLen);
            let off = 0;
            for (const x of parts) { merged.set(x, off); off += x.length; }
            packed[ti] = { fi: p.fi, merged };
        }
        if (onProgress) onProgress(45, `读取完成 ${targets.length} 个文件`);

        const fileObjects = [];
        for (let ti = 0; ti < targets.length; ti++) {
            const { virtualPath: vp, relPath } = targets[ti];
            if (!packed[ti]) continue;
            const { fi: fileInfo, merged } = packed[ti];
            // 来源信息取自首个分片，供 shareFiles 兜底使用
            const src = fileInfo.chunks[0] || {};
            const meta = {
                path: relPath,
                name: relPath,
                size: fileInfo.size,
                owner: src.owner,
                repo: src.repo,
                branch: src.branch
            };
            // 文本文件解码为字符串，二进制文件保留原始字节
            if (this.isTextFile(relPath)) {
                fileObjects.push({ ...meta, content: new TextDecoder('utf-8').decode(merged) });
            } else {
                fileObjects.push({ ...meta, arrayBuffer: merged.buffer, isBinary: true });
            }
        }
        if (dlFail.length) {
            console.warn('[Share] 有 ' + dlFail.length + ' 个文件读取失败:', dlFail.slice(0, 3).join('; '));
        }
        if (fileObjects.length === 0) {
            throw new Error(dlFail.length
                ? `没有可分享的内容：${dlFail.slice(0, 3).join('；')}`
                : I18n.t('share.noFiles'));
        }
        return await this.shareFiles(fileObjects, shareName, description, onProgress, [45, 100]);
    }

    /**
     * 分享文件
     * @param {Array} files - 要分享的文件列表 [{owner, repo, path, name, branch, sha}]
     * @param {string} shareName - 分享名称（用于仓库名）
     * @param {string} description - 分享描述
     * @param {Function} onProgress - 进度回调
     * @returns {Promise<{repoName, shareUrl, files}>}
     */
    async shareFiles(files, shareName = '', description = '', onProgress = null, progRange = null) {
        /**
         * ★ 进度区间的映射。
         *   shareByVirtualPaths 已经读到 45% 才转调这里，而 shareFiles 内部
         *   是从 10%（创建仓库）开始的 —— 直接透传会让进度条**倒退**，
         *   用户看到的就是"条子往回缩然后又不动"。
         *   调用方可以传 [起点, 终点]，内部百分比按比例缩放进去。
         */
        const [P0, P1] = progRange || [0, 100];
        const emit = (p, m) => {
            if (onProgress) onProgress(P0 + Math.round(p / 100 * (P1 - P0)), m);
        };
        const username = await this.api.getUsername();
        const timestamp = Date.now().toString(36);
        // 标准命名格式：gd-share-{name}-{timestamp}，方便 GitHub 搜索
        const repoName = shareName
            ? `gd-share-${shareName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${timestamp}`
            : `gd-share-${timestamp}`;

        emit(10, I18n.t('share.creatingRepo'));

        // 1. 创建公开仓库
        const repo = await this.api.createRepository(repoName, {
            description: description || I18n.t('share.pageDesc'),
            private: false,
            autoInit: true
        });

        // 等待仓库初始化
        await this.sleep(2000);

        // 1.5 打 topic，让"发现分享"能精确搜到（名字搜索会被上百个无关仓库淹没）
        //     失败无所谓：不影响分享本身，发现列表还会兜底并入自己的分享
        try {
            const ownerLogin = (repo && repo.owner && repo.owner.login) || username;
            await this.api.setTopics(ownerLogin, repoName, ['gd-share', 'github-drive']);
        } catch (e) {
            console.warn('[Share] 设置 topic 失败（不影响分享）:', e.message);
        }

        emit(30, '复制分享文件...');

        // 2. 复制文件到分享仓库
        const fileObjects = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fname = file.name || file.path;
            try {
                // ① 调用方已提供二进制字节（shareByVirtualPaths 已合并分片）
                //    必须优先复用：否则会拿着 undefined 的 owner/repo 去重下一遍
                if (file.arrayBuffer !== undefined) {
                    fileObjects.push({
                        path: fname,
                        arrayBuffer: file.arrayBuffer,
                        size: file.size || file.arrayBuffer.byteLength || 0,
                        isBinary: true
                    });
                    continue;
                }

                let content;
                if (file.content !== undefined) {
                    // ② 内容已由调用方提供（如 shareByVirtualPaths 已下载合并分片）
                    content = file.content;
                } else {
                    // ③ 需要现场下载：必须先确认来源仓库，
                    //    否则会请求 /repos/undefined/undefined/... 产生 404，
                    //    还会误导开发者以为是路径或文件名的问题
                    if (!file.owner || !file.repo) {
                        throw new Error(`缺少来源仓库信息（owner=${file.owner}, repo=${file.repo}），无法下载`);
                    }
                    const raw = file.sha
                        ? await this.api.getBlobBytes(file.owner, file.repo, file.sha)
                        : await this.api.getFileRaw(file.owner, file.repo, file.path, file.branch);
                    if (this.isTextFile(fname)) {
                        content = new TextDecoder('utf-8').decode(raw);
                    } else {
                        // 二进制文件保留原始字节
                        fileObjects.push({ path: fname, arrayBuffer: raw.buffer, size: file.size || raw.length, isBinary: true });
                        continue;
                    }
                }
                fileObjects.push({
                    path: fname,
                    content
                });
            } catch (e) {
                console.warn(`复制文件 ${fname} 失败:`, e);
                this._shareErrors = this._shareErrors || [];
                this._shareErrors.push({ name: fname, message: e.message });
            }
            emit(30 + Math.round((i + 1) / files.length * 30), `复制文件 ${i + 1}/${files.length}`);
        }

        if (fileObjects.length === 0) {
            // 带上具体原因，否则用户只会看到一句没头没尾的"没有成功复制任何文件"
            const errs = this._shareErrors || [];
            this._shareErrors = [];
            const detail = errs.length
                ? '：' + errs.slice(0, 3).map(e => `${e.name}（${e.message}）`).join('；')
                : '';
            throw new Error('没有成功复制任何文件' + detail);
        }
        this._shareErrors = [];

        // ── 2.5 压缩：可压缩的文件存成 .gz，下载页自动解压 ──
        // 分享仓库是给访客用的，所以必须能在浏览器里还原 —— 下载页里
        // 用 DecompressionStream 解压后再触发下载，访客拿到的是原文件。
        // 浏览器不支持 compression stream 时整段跳过，不做任何压缩。
        const cfg = (this.storage && this.storage.getStorageConfig)
            ? (this.storage.getStorageConfig() || {}) : {};
        const sysFiles = new Set(['index.html', 'README.md', 'share.json', 'status.js', '.nojekyll']);
        let savedBytes = 0;
        if (cfg.compression !== false && typeof CompressionStream !== 'undefined') {
            const skipExt = new Set(['mp4','mkv','avi','mov','webm','m4v','flv','wmv','mpg','mpeg','ts',
                'jpg','jpeg','png','gif','webp','avif','heic','bmp','tiff','ico',
                'zip','rar','7z','gz','tgz','bz2','xz','zst','lz4','tar','iso','dmg','apk','ipa',
                'mp3','aac','flac','ogg','opus','wma','m4a','wav','aiff',
                'woff','woff2','ttf','otf','jar','whl','pdf']);
            for (let i = 0; i < fileObjects.length; i++) {
                const f = fileObjects[i];
                if (sysFiles.has(f.path)) continue;
                const ext = (f.path.split('.').pop() || '').toLowerCase();
                if (skipExt.has(ext)) continue;
                // 大文件压缩起来不快，之前这段完全没上报，进度条会"卡住"
                if (i % 5 === 0) emit(62, `压缩文件 ${i + 1}/${fileObjects.length}`);
                try {
                    const bytes = f.arrayBuffer
                        ? new Uint8Array(f.arrayBuffer)
                        : new TextEncoder().encode(f.content || '');
                    if (bytes.length < 1024) continue;
                    const cs = new CompressionStream('gzip');
                    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
                    const gz = new Uint8Array(buf);
                    if (gz.length >= bytes.length * 0.95) continue;   // 省不到 5% 就不值
                    savedBytes += bytes.length - gz.length;
                    fileObjects[i] = {
                        path: f.path + '.gz',
                        arrayBuffer: gz,
                        size: bytes.length,          // 显示原始大小
                        isBinary: true,
                        _origPath: f.path            // 下载页与元数据用原名
                    };
                } catch (e) {
                    console.warn('[Share] 压缩失败，原样分享:', f.path, e.message);
                }
            }
            if (savedBytes > 0) {
                console.log(`[Share] 压缩节省 ${(savedBytes / 1048576).toFixed(1)} MB`);
            }
        }

        // 元数据与下载页统一用"原始路径"（压缩过的去掉 .gz 后缀）
        const displayPath = f => f._origPath || f.path;

        // 3. 生成下载页面
        const downloadPage = this.generateDownloadPage(repoName, description, fileObjects, username, displayPath);
        fileObjects.push({
            path: 'index.html',
            content: downloadPage
        });

        // 添加 README
        fileObjects.push({
            path: 'README.md',
            content: this.generateReadme(repoName, description, fileObjects, username, displayPath)
        });
        // 添加标准分享元数据（用于搜索和发现）
        const shareMeta = {
            version: '1.0',
            type: 'github-drive-share',
            name: shareName || repoName,
            description: description || '',
            author: username,
            createdAt: new Date().toISOString(),
            fileCount: fileObjects.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js' && f.path !== '.nojekyll').length,
            files: fileObjects.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js' && f.path !== '.nojekyll').map(f => ({ name: displayPath(f), size: f.size || 0, packed: f.path.endsWith('.gz') ? 'gzip' : undefined }))
        };
        fileObjects.push({
            path: 'share.json',
            content: JSON.stringify(shareMeta, null, 2)
        });
        // Pages 生效探针（script 标签加载，不受 CORS 限制）
        fileObjects.push({
            path: 'status.js',
            content: 'window.__githubDrivePagesReady = true;'
        });
        // ★ 关闭 Jekyll。
        //
        //   GitHub Pages 默认用 Jekyll 构建，而 Jekyll 会**跳过所有以
        //   下划线开头的目录和文件**（_layouts / _includes / _data 这类）。
        //
        //   实测翻车：分享 /drive_home/_recovered 里的文件时，全部落在
        //   `_recovered/` 目录下 → Jekyll 整个目录不进 _site →
        //   下载页列得出文件名，点下去一律 404。
        //   `icons/default/_desc.ini` 同理（文件名本身带下划线前缀）。
        //
        //   加了 .nojekyll 之后 Pages 退化成纯静态拷贝，所有文件原样提供。
        fileObjects.push({
            path: '.nojekyll',
            content: '\n'
        });

        emit(70, I18n.t('share.uploadingFiles'));

        // 4. 批量提交文件（并发建 blob + 内容去重）
        await this.api.batchUploadFiles(
            username,
            repoName,
            fileObjects,
            `Shared ${fileObjects.filter(f => !sysFiles.has(f.path)).length} files`,
            'main',
            (done, total) => {
                emit(70 + Math.round(done / total * 12), `上传 ${done}/${total}`);
            },
            { memoryBudget: cfg.memoryBudget, maxConcurrency: cfg.maxConcurrency }
        );

        emit(85, I18n.t('share.enablingPages'));

        // 5. 启用 GitHub Pages
        try {
            await this.api.enablePages(username, repoName, 'main', '/');
            // 请求构建
            await this.api.requestPageBuild(username, repoName).catch(() => {});
        } catch (e) {
            console.warn('启用 GitHub Pages 失败:', e);
        }

        emit(100, I18n.t('share.done'));

        const shareUrl = this.api.getPagesUrl(username, repoName);
        const result = {
            repoName,
            shareUrl,
            repoUrl: this.api.getRepoUrl(username, repoName),
            files: fileObjects.filter(f => !['index.html', 'README.md', 'status.js', 'share.json', '.nojekyll'].includes(f.path)).map(f => ({ name: f.path })),
            createdAt: new Date().toISOString()
        };

        // 保存分享记录
        this.storage.addShare(result);

        return result;
    }

    /**
     * 生成下载页面 HTML
     */
    /**
     * HTML 转义：防止文件名 / 描述中的恶意内容被当作 HTML 执行
     * 分享页是公开 Pages 页面，任何访问者都会加载，属于存储型 XSS 高危场景
     * @param {*} value - 待转义的值
     * @returns {string}
     */
    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    /**
     * 生成期直接渲染出静态文件条目
     *
     * 之前列表完全靠内联 JS 渲染，一旦脚本有任何语法错误，
     * 页面就永远停在 "Loading files..."，用户一个文件都下不了。
     * 静态渲染后即使脚本全挂，下载依然可用。
     */
    _staticFileItem(f, dp) {
        const nameFn = dp || (x => x.path);
        const name = nameFn(f);
        const url = './' + f.path.split('/').map(encodeURIComponent).join('/');
        /**
         * 静态列表是 JS 挂掉时的兜底，此时 lightbox 也用不了，
         * 所以这里只把缩略图渲染出来（点了仍是打开原图）。
         * ★ 万一图片是压缩过的（.gz），src 会裂 —— 但图片本来就跳过压缩，
         *   而这是兜底路径，不值得为它再写一套异步解压。
         */
        const isImg = /\.(jpe?g|png|gif|webp|bmp|avif|ico|svg|jfif)$/i.test(name);
        const thumb = isImg
            ? `<img class="file-thumb" src="${url}" loading="lazy" alt="">`
            : `<span class="file-icon">${this.getFileIcon(name)}</span>`;
        return `<li class="file-item" onclick="window.open('${url}', '_blank')">
                            ${thumb}
                            <div class="file-info">
                                <div class="file-name">${this.escapeHtml(name)}</div>
                                <div class="file-size">${f.size ? this.formatSize(f.size) : ''}</div>
                            </div>
                            <button class="download-btn" onclick="event.stopPropagation(); window.open('${url}', '_blank')"><span data-i18n="download">Download</span></button>
                        </li>`;
    }

    /** 生成期用的图标（与内联脚本里的 getFileIcon 保持一致） */
    getFileIcon(name) {
        const ext = String(name).split('.').pop().toLowerCase();
        const icons = {
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
            mp4: '🎬', avi: '🎬', mov: '🎬', mkv: '🎬', webm: '🎬',
            mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
            txt: '📄', md: '📝', zip: '📦', rar: '📦', '7z': '📦',
            js: '📜', py: '🐍', html: '🌐', css: '🎨', json: '📋'
        };
        return icons[ext] || '📄';
    }

    /** 生成期用的体积格式化 */
    formatSize(bytes) {
        if (!bytes) return '';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    generateDownloadPage(repoName, description, files, username, displayPath) {
        const dp = displayPath || (f => f.path);
        const fileList = files.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js' && f.path !== '.nojekyll');
        // 用 Pages 相对路径，分段编码（保留 / 分隔符），国内访问更快
        // JSON 里若出现 "</script>" 会提前闭合脚本块，必须转义；
        // 同理转义 <!-- 避免进入注释解析状态
        //
        // ★ name 用原始文件名（去掉 .gz），packed 标记让页面知道要解压。
        //   访客下载到的一定是原文件，不该看到 .gz 后缀。
        const filesJson = JSON.stringify(fileList.map(f => ({
            name: dp(f),
            url: './' + f.path.split('/').map(encodeURIComponent).join('/'),
            packed: f.path.endsWith('.gz') ? 'gzip' : undefined,
            size: f.size || 0
        }))).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(description || I18n.t('share.pageTitle'))} - GitHub Drive</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 600px;
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 32px;
            text-align: center;
            position: relative;
        }
        .header-icon { font-size: 48px; margin-bottom: 12px; }
        .header h1 { font-size: 24px; margin-bottom: 8px; }
        .header p { opacity: 0.9; font-size: 14px; }
        .lang-switch { position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 6px 12px; border-radius: 20px; cursor: pointer; font-size: 12px; backdrop-filter: blur(10px); }
        .lang-switch:hover { background: rgba(255,255,255,0.3); }
        .content { padding: 24px; }
        .file-list { list-style: none; }
        .file-item {
            display: flex;
            align-items: center;
            padding: 14px 16px;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            margin-bottom: 10px;
            transition: all 0.2s;
            cursor: pointer;
        }
        .file-item:hover {
            border-color: #667eea;
            background: #f8f7ff;
            transform: translateY(-1px);
        }
        .file-icon { font-size: 28px; margin-right: 14px; }
        .file-info { flex: 1; min-width: 0; }
        .file-name {
            font-weight: 600;
            font-size: 14px;
            color: #1f2937;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-size { font-size: 12px; color: #6b7280; margin-top: 2px; }
        .download-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            flex-shrink: 0;
        }
        .download-btn:hover { background: #5a67d8; }
        .download-all {
            width: 100%;
            margin-top: 16px;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .download-all:hover { transform: translateY(-1px); }
        .promo-card {
            margin-top: 20px;
            padding: 20px;
            background: linear-gradient(135deg, #f8f7ff 0%, #eef2ff 100%);
            border: 1px solid #e0e7ff;
            border-radius: 12px;
            text-align: center;
        }
        .promo-icon { font-size: 32px; margin-bottom: 8px; }
        .promo-title {
            font-size: 16px;
            font-weight: 700;
            color: #4338ca;
            margin-bottom: 6px;
        }
        .promo-desc {
            font-size: 13px;
            color: #6366f1;
            margin-bottom: 14px;
            line-height: 1.5;
        }
        .promo-btn {
            display: inline-block;
            padding: 10px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        .promo-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
        }
        .footer {
            padding: 16px 24px;
            border-top: 1px solid #e5e7eb;
            text-align: center;
            font-size: 12px;
            color: #9ca3af;
        }
        .footer a { color: #667eea; text-decoration: none; }
        .empty { text-align: center; padding: 40px; color: #9ca3af; }
        .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 20px;
            gap: 12px;
            color: #9ca3af;
            font-size: 14px;
        }
        .spinner {
            width: 28px;
            height: 28px;
            border: 3px solid #e5e7eb;
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── 图片缩略图 ──
           ★ 分享页没有后端，做不出真正的缩略图，只能用原图 + object-fit 裁。
             所以必须 loading="lazy" + 进视口才加载：98 张图一次性全请求会把浏览器拖死。 */
        .file-thumb {
            width: 44px; height: 44px; margin-right: 14px; flex-shrink: 0;
            border-radius: 8px; object-fit: cover;
            background: #f3f4f6; border: 1px solid #e5e7eb; display: block;
        }
        .file-item.is-img { cursor: zoom-in; }
        .file-item.is-img:hover { border-color: #667eea; background: #f8f7ff; }
        .thumb-wrap { position: relative; flex-shrink: 0; margin-right: 14px; }
        .thumb-zoom {
            position: absolute; right: -3px; bottom: -3px;
            width: 18px; height: 18px; border-radius: 50%;
            background: #667eea; color: #fff; font-size: 10px;
            display: flex; align-items: center; justify-content: center;
            border: 2px solid #fff; pointer-events: none;
        }
        .img-count {
            font-size: 12px; color: #6b7280; text-align: center;
            margin-bottom: 10px;
        }

        /* ── 一键预览：全屏看图 ── */
        .preview-all {
            width: 100%; margin-bottom: 10px; padding: 12px;
            background: #fff; color: #4338ca;
            border: 1px solid #c7d2fe; border-radius: 10px;
            font-size: 14px; font-weight: 600; cursor: pointer;
            transition: background .2s;
        }
        .preview-all:hover { background: #eef2ff; }

        .lightbox {
            position: fixed; inset: 0; z-index: 9999; display: none;
            flex-direction: column; align-items: center; justify-content: center;
            background: rgba(12,14,20,.95); backdrop-filter: blur(8px);
            touch-action: none;
        }
        .lightbox.show { display: flex; }
        .lb-top {
            position: absolute; top: 0; left: 0; right: 0; z-index: 2;
            padding: 14px 16px; display: flex; align-items: center; gap: 12px;
            color: #fff; background: linear-gradient(rgba(0,0,0,.5), transparent);
        }
        .lb-name {
            flex: 1; min-width: 0; font-size: 13px; font-weight: 600;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .lb-count { font-size: 12px; opacity: .75; flex-shrink: 0; }
        .lb-btn {
            background: rgba(255,255,255,.14); color: #fff; border: 1px solid rgba(255,255,255,.2);
            padding: 7px 13px; border-radius: 8px; font-size: 13px; cursor: pointer;
            flex-shrink: 0;
        }
        .lb-btn:hover { background: rgba(255,255,255,.26); }
        .lb-stage {
            flex: 1; width: 100%; display: flex; align-items: center; justify-content: center;
            padding: 56px 12px 12px; overflow: hidden;
        }
        .lb-img {
            max-width: 96vw; max-height: 100%; object-fit: contain;
            border-radius: 6px; box-shadow: 0 12px 48px rgba(0,0,0,.6);
        }
        .lb-nav {
            position: absolute; top: 50%; transform: translateY(-50%);
            width: 42px; height: 42px; border-radius: 50%;
            background: rgba(255,255,255,.14); color: #fff; border: 1px solid rgba(255,255,255,.2);
            font-size: 20px; cursor: pointer; display: flex;
            align-items: center; justify-content: center; z-index: 2;
        }
        .lb-nav:hover { background: rgba(255,255,255,.28); }
        .lb-prev { left: 10px; }
        .lb-next { right: 10px; }
        .lb-hint {
            position: absolute; bottom: 14px; left: 0; right: 0; text-align: center;
            color: rgba(255,255,255,.5); font-size: 12px; pointer-events: none;
        }
        .lb-loading { color: rgba(255,255,255,.6); font-size: 13px; }

        /* 手机：箭头挪到底部，避免挡住图 */
        @media (max-width: 480px) {
            .lb-nav { top: auto; bottom: 44px; transform: none; width: 48px; height: 48px; }
            .lb-prev { left: 18px; }
            .lb-next { right: 18px; }
            .lb-hint { bottom: 12px; }
            .lb-stage { padding: 52px 8px 96px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-icon">📦</div>
            <h1>${description ? this.escapeHtml(description) : '<span data-i18n="page.title">File Share</span>'}</h1>
            <p>${fileList.length} files · Shared via GitHub Drive</p>
            <button class="lang-switch" onclick="toggleLang()" title="切换语言">🌐 EN / 中</button>
        </div>
        <div class="content">
            <ul class="file-list" id="fileList">
                ${fileList.map(f => this._staticFileItem(f, dp)).join('')}
            </ul>
            <button class="preview-all" id="previewAllBtn" style="display:none" onclick="openLightbox(0)"></button>
            <button class="download-all" id="dlAllBtn" onclick="downloadAll()"><span data-i18n="downloadAll">⬇️ 打包下载全部 (ZIP)</span></button>
            <div id="dlProgress" style="display:none;margin-top:10px;">
                <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
                    <div id="dlBar" style="height:100%;width:0%;background:linear-gradient(90deg,#667eea,#764ba2);transition:width .2s;"></div>
                </div>
                <div class="dl-text" style="font-size:12px;color:#6b7280;margin-top:6px;">准备中…</div>
            </div>
            
            <div class="promo-card">
                <div class="promo-icon">📁✨</div>
                <div class="promo-title"><span data-i18n="promo.title">Want unlimited cloud storage with GitHub?</span></div>
                <div class="promo-desc" data-i18n="promo.desc">Turn your GitHub repos into a private cloud drive<br>Multi-repo management, smart storage allocation, one-click sharing</div>
                <a href="https://${this.escapeHtml(username)}.github.io/github_drive" target="_blank" class="promo-btn"><span data-i18n="promo.btn">🚀 Use GitHub Drive Now</span></a>
            </div>
        </div>
        <div class="footer">
            <span data-i18n="footer.powered">Powered by</span> <a href="https://${this.escapeHtml(username)}.github.io/github_drive" target="_blank">GitHub Drive</a> · <span data-i18n="footer.stored">Stored on GitHub</span>
        </div>
    </div>

    <div class="lightbox" id="lightbox">
        <div class="lb-top">
            <div class="lb-name" id="lbName"></div>
            <div class="lb-count" id="lbCount"></div>
            <button class="lb-btn" id="lbDl">⬇️ <span data-i18n="download">Download</span></button>
            <button class="lb-btn" onclick="closeLightbox()">✕</button>
        </div>
        <div class="lb-stage" id="lbStage">
            <div class="lb-loading" id="lbLoading">…</div>
            <img class="lb-img" id="lbImg" style="display:none" alt="">
        </div>
        <button class="lb-nav lb-prev" id="lbPrev" onclick="lbNav(-1)">‹</button>
        <button class="lb-nav lb-next" id="lbNext" onclick="lbNav(1)">›</button>
        <div class="lb-hint" data-i18n="lb.hint">← → 切换 · Esc 关闭</div>
    </div>
    <script>
        const files = ${filesJson};
        // ZIP 文件名用仓库名；去掉不能出现在文件名里的字符
        const zipMeta = ${JSON.stringify({ name: (repoName || 'share').replace(/[\\/:*?"<>|]/g, '_') }).replace(/<\/script/gi, '<\\/script')};
        const fileList = document.getElementById('fileList');

        function getFileIcon(name) {
            const ext = name.split('.').pop().toLowerCase();
            const icons = {
                jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',svg:'🖼️',webp:'🖼️',
                mp4:'🎬',avi:'🎬',mov:'🎬',mkv:'🎬',webm:'🎬',
                mp3:'🎵',wav:'🎵',flac:'🎵',aac:'🎵',ogg:'🎵',
                pdf:'📕',doc:'📘',docx:'📘',xls:'📗',xlsx:'📗',ppt:'📙',pptx:'📙',
                txt:'📄',md:'📝',zip:'📦',rar:'📦','7z':'📦',
                js:'📜',py:'🐍',html:'🌐',css:'🎨',json:'📋',
                exe:'⚙️',dmg:'💿',apk:'📱'
            };
            return icons[ext] || '📄';
        }

        function formatSize(bytes) {
            if (!bytes) return '';
            const k = 1024;
            const sizes = ['B','KB','MB','GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        // 转义函数在页面内联定义：此处代码运行于访客浏览器，无法访问 ShareManager 实例
        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, function(c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        /** 触发浏览器下载（不是打开预览）。 */
        function triggerDownload(blob, name) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }

        /** 取回文件字节，必要时解压。 */
        async function fetchBytes(file) {
            const res = await fetch(file.url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            if (!file.packed) return new Uint8Array(await res.arrayBuffer());
            if (typeof DecompressionStream === 'undefined') {
                // 老浏览器解压不了 —— 原样给他，至少数据是完整的
                return new Uint8Array(await res.arrayBuffer());
            }
            const ds = new DecompressionStream('gzip');
            const buf = await new Response(res.body.pipeThrough(ds)).arrayBuffer();
            return new Uint8Array(buf);
        }

        /**
         * 下载一个文件。
         *
         * ★ 旧实现用 window.open(url) 打开 —— 那是「预览」不是「下载」。
         *   PDF / 图片 / txt / md 这类浏览器能直接渲染的格式会被打开，
         *   点了「Download」却跳到一个预览页，看着像没反应。
         *   现在一律 fetch → Blob → a.download，所有格式都真下载。
         *
         * ★ 压缩过的必须先解压：仓库里存的是 .gz，直接给会让访客
         *   拿到一个名字不对、内容也打不开的压缩包。
         */
        async function saveFile(file) {
            const name = file.name.split('/').pop();
            try {
                const bytes = await fetchBytes(file);
                triggerDownload(new Blob([bytes]), name);
            } catch (e) {
                console.error('下载失败', e);
                window.open(file.url, '_blank');
            }
        }

        /* ── 图片预览 ────────────────────────────────────────── */

        /**
         * 哪些算图片。svg 也列进来 —— 但 svg 可能是 XML，只有真图片才渲染得了，
         * 加载失败会自动退回图标，所以直接试就行。
         */
        const IMG_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','avif','ico','svg','jfif','pjpeg']);
        function isImage(name) {
            const ext = String(name || '').split('.').pop().toLowerCase();
            return IMG_EXT.has(ext);
        }

        /**
         * 图片的真实 URL。
         *
         * ★ 压缩过的（packed:'gzip'）不能直接给 <img src> —— 仓库里存的是 .gz，
         *   浏览器认不出，只会显示一个裂图。必须先取回来解压再转 blob URL。
         *   （实际分享里 jpg/png 通常不会被压缩，因为已压缩格式会自动跳过；
         *    但老数据可能有，这里一律处理。）
         */
        const _imgCache = new Map();
        async function imgURL(file) {
            if (!file.packed) return file.url;
            if (_imgCache.has(file.name)) return _imgCache.get(file.name);
            const bytes = await fetchBytes(file);
            const u = URL.createObjectURL(new Blob([bytes]));
            _imgCache.set(file.name, u);
            return u;
        }

        const imageFiles = files.filter(f => isImage(f.name));
        let lbIndex = -1;

        async function openLightbox(i) {
            if (!imageFiles.length || i < 0 || i >= imageFiles.length) return;
            lbIndex = i;
            const f = imageFiles[i];
            const box = document.getElementById('lightbox');
            const img = document.getElementById('lbImg');
            const load = document.getElementById('lbLoading');

            box.classList.add('show');
            document.body.style.overflow = 'hidden';
            document.getElementById('lbName').textContent = f.name.split('/').pop();
            document.getElementById('lbCount').textContent =
                (i + 1) + ' / ' + imageFiles.length + (f.size ? ' · ' + formatSize(f.size) : '');
            document.getElementById('lbDl').onclick = () => saveFile(f);

            // 只有一张就藏掉左右箭头 —— 两个箭头点了没反应很怪
            const many = imageFiles.length > 1;
            document.getElementById('lbPrev').style.display = many ? '' : 'none';
            document.getElementById('lbNext').style.display = many ? '' : 'none';

            img.style.display = 'none';
            img.src = '';
            load.style.display = '';
            load.textContent = '…';
            try {
                img.src = await imgURL(f);
                img.style.display = '';
                load.style.display = 'none';
            } catch (e) {
                load.textContent = '这张图加载失败了';
            }
        }

        function closeLightbox() {
            const box = document.getElementById('lightbox');
            box.classList.remove('show');
            document.body.style.overflow = '';
            // 清掉 src，否则大图一直占着内存
            document.getElementById('lbImg').src = '';
            lbIndex = -1;
        }

        function lbNav(d) {
            if (lbIndex < 0) return;
            const n = imageFiles.length;
            openLightbox((lbIndex + d + n) % n);
        }

        // 点遮罩空白处关闭（点图片本身不关）
        document.getElementById('lightbox').addEventListener('click', function (e) {
            if (e.target === this || e.target.id === 'lbStage') closeLightbox();
        });

        document.addEventListener('keydown', function (e) {
            if (lbIndex < 0) return;
            if (e.key === 'Escape') closeLightbox();
            else if (e.key === 'ArrowLeft') lbNav(-1);
            else if (e.key === 'ArrowRight') lbNav(1);
        });

        // 手机上左右滑动翻页
        let touchX = null;
        document.getElementById('lbStage').addEventListener('touchstart', function (e) {
            touchX = e.changedTouches[0].clientX;
        }, { passive: true });
        document.getElementById('lbStage').addEventListener('touchend', function (e) {
            if (touchX === null) return;
            const dx = e.changedTouches[0].clientX - touchX;
            if (Math.abs(dx) > 45) lbNav(dx < 0 ? 1 : -1);
            touchX = null;
        }, { passive: true });

        // ── ZIP 打包（store，不压缩）──
        // 分享里的文件大多已经是压缩格式（mp4/jpg/zip…），再压一遍纯属浪费，
        // 所以只用 store 方式打包，重点是「一个包」而不是「更小」。
        let CRC_TABLE = null;
        function crc32(u8) {
            if (!CRC_TABLE) {
                CRC_TABLE = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    CRC_TABLE[n] = c >>> 0;
                }
            }
            let c = 0xFFFFFFFF;
            for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
            return (c ^ 0xFFFFFFFF) >>> 0;
        }

        function dosDateTime(d) {
            const year = Math.max(1980, d.getFullYear());
            return {
                time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
                date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
            };
        }

        function buildZip(entries) {
            const enc = new TextEncoder();
            const { time, date } = dosDateTime(new Date());
            const parts = [];
            const central = [];
            let offset = 0;
            for (const e of entries) {
                const nb = enc.encode(e.name);
                const data = e.data;
                const crc = crc32(data);
                const lh = new Uint8Array(30 + nb.length);
                const lv = new DataView(lh.buffer);
                lv.setUint32(0, 0x04034b50, true);
                lv.setUint16(4, 20, true);
                lv.setUint16(6, 0x0800, true);   // UTF-8 文件名
                lv.setUint16(8, 0, true);        // store
                lv.setUint16(10, time, true);
                lv.setUint16(12, date, true);
                lv.setUint32(14, crc, true);
                lv.setUint32(18, data.length, true);
                lv.setUint32(22, data.length, true);
                lv.setUint16(26, nb.length, true);
                lv.setUint16(28, 0, true);
                lh.set(nb, 30);

                const cd = new Uint8Array(46 + nb.length);
                const cv = new DataView(cd.buffer);
                cv.setUint32(0, 0x02014b50, true);
                cv.setUint16(4, 20, true);
                cv.setUint16(6, 20, true);
                cv.setUint16(8, 0x0800, true);
                cv.setUint16(10, 0, true);
                cv.setUint16(12, time, true);
                cv.setUint16(14, date, true);
                cv.setUint32(16, crc, true);
                cv.setUint32(20, data.length, true);
                cv.setUint32(24, data.length, true);
                cv.setUint16(28, nb.length, true);
                cv.setUint16(30, 0, true);
                cv.setUint16(32, 0, true);
                cv.setUint16(34, 0, true);
                cv.setUint16(36, 0, true);
                cv.setUint32(38, 0, true);
                cv.setUint32(42, offset, true);
                cd.set(nb, 46);

                parts.push(lh, data);
                central.push(cd);
                offset += lh.length + data.length;
            }
            const cdStart = offset;
            const cdSize = central.reduce((a, b) => a + b.length, 0);
            const eocd = new Uint8Array(22);
            const ev = new DataView(eocd.buffer);
            ev.setUint32(0, 0x06054b50, true);
            ev.setUint16(4, 0, true);
            ev.setUint16(6, 0, true);
            ev.setUint16(8, entries.length, true);
            ev.setUint16(10, entries.length, true);
            ev.setUint32(12, cdSize, true);
            ev.setUint32(16, cdStart, true);
            ev.setUint16(20, 0, true);
            return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
        }

        /**
         * 渲染列表。
         *
         * ★ 图片文件：整行点击 = 放大预览（不是下载），缩略图直接渲染出来。
         *   非图片：整行点击 = 下载，和以前一样。
         *   两种都保留独立的 Download 按钮，不会让人点错。
         */
        fileList.innerHTML = '';
        files.forEach(file => {
            const idx = files.indexOf(file);
            const isImg = isImage(file.name);
            const li = document.createElement('li');
            li.className = 'file-item' + (isImg ? ' is-img' : '');
            // 图片行点的是"放大"，非图片行点的是"下载"
            li.onclick = () => isImg ? openLightbox(imageFiles.indexOf(file)) : saveFile(file);

            const thumb = isImg
                ? \`<div class="thumb-wrap">
                       <img class="file-thumb" alt="" data-fi="\${idx}">
                       <span class="thumb-zoom">🔍</span>
                   </div>\`
                : \`<span class="file-icon">\${getFileIcon(file.name)}</span>\`;

            li.innerHTML = \`
                \${thumb}
                <div class="file-info">
                    <div class="file-name">\${escapeHtml(file.name)}</div>
                    <div class="file-size">\${file.size ? formatSize(file.size) : '<span data-i18n="clickDownload">Click to download</span>'}</div>
                </div>
                <button class="download-btn" onclick="event.stopPropagation(); saveFile(files[\${idx}])"><span data-i18n="download">Download</span></button>
            \`;
            fileList.appendChild(li);
        });

        /**
         * 缩略图懒加载。
         * ★ 不能给每个 <img> 直接写 src —— 98 张原图一起请求，浏览器直接卡死。
         *   进视口（提前 250px）才真正加载。没有 IntersectionObserver 就退回全加载。
         *   加载失败的（比如 svg 其实是 XML）隐藏缩略图，回退成 emoji 图标。
         */
        (function initThumbs() {
            const imgs = Array.prototype.slice.call(document.querySelectorAll('.file-thumb'));
            if (!imgs.length) return;
            const load = (el) => {
                const f = files[+el.dataset.fi];
                imgURL(f).then(u => { el.src = u; })
                    .catch(() => { el.style.visibility = 'hidden'; });
            };
            if (!('IntersectionObserver' in window)) { imgs.forEach(load); return; }
            const io = new IntersectionObserver((entries) => {
                for (const en of entries) {
                    if (!en.isIntersecting) continue;
                    io.unobserve(en.target);
                    load(en.target);
                }
            }, { rootMargin: '250px' });
            imgs.forEach(el => io.observe(el));
        })();

        /**
         * 有图片才显示"一键预览"按钮。
         *
         * ★ 这里不能读 translations —— 它定义在脚本靠后，
         *   而 const 有暂时性死区（TDZ），提前引用会直接抛 ReferenceError
         *   把整段脚本停摆（实测：按钮文案空、提示元素不见了）。
         *   所以这段只负责"显示/隐藏 + 建元素"，文案交给末尾的 applyLang 填。
         */
        (function initPreviewBtn() {
            const btn = document.getElementById('previewAllBtn');
            if (!btn) return;
            if (!imageFiles.length) { btn.style.display = 'none'; return; }
            btn.style.display = '';
            let tip = document.getElementById('imgCountTip');
            if (!tip) {
                tip = document.createElement('div');
                tip.className = 'img-count';
                tip.id = 'imgCountTip';
                btn.parentNode.insertBefore(tip, btn.nextSibling);
            }
        })();

        /**
         * 打包下载全部。
         *
         * ★ 旧实现是 files.forEach(f => setTimeout(() => saveFile(f), i*300)) ——
         *   98 个文件就开 98 个标签页，浏览器直接卡死或被弹窗拦截拦掉。
         *   现在打成一个 ZIP，只下载一次。
         */
        async function downloadAll() {
            const btn = document.getElementById('dlAllBtn');
            const prog = document.getElementById('dlProgress');
            const bar = document.getElementById('dlBar');
            if (btn) btn.disabled = true;
            if (prog) prog.style.display = 'block';

            const entries = [];
            const errors = [];
            let done = 0;
            let bytes = 0;

            const queue = files.slice();
            async function worker() {
                while (queue.length) {
                    const f = queue.shift();
                    try {
                        const data = await fetchBytes(f);
                        entries.push({ name: f.name, data });
                        bytes += data.length;
                    } catch (e) {
                        errors.push(f.name);
                    }
                    done++;
                    if (bar) bar.style.width = Math.round(done / files.length * 100) + '%';
                    if (prog) prog.querySelector('.dl-text').textContent =
                        '打包中 ' + done + '/' + files.length + '（' + formatSize(bytes) + '）';
                }
            }
            // 并发 4：串行太慢，再多会撞 Pages 的频率限制
            await Promise.all([0, 1, 2, 3].map(worker));

            if (!entries.length) {
                if (prog) prog.querySelector('.dl-text').textContent = '全部下载失败，请重试';
                if (btn) btn.disabled = false;
                return;
            }

            if (prog) prog.querySelector('.dl-text').textContent = '正在生成 ZIP…';
            const zipName = (zipMeta.name || 'github-drive-share') + '.zip';
            triggerDownload(buildZip(entries), zipName);

            if (prog) {
                prog.querySelector('.dl-text').textContent =
                    '已打包 ' + entries.length + ' 个文件（' + formatSize(bytes) + '）' +
                    (errors.length ? '，' + errors.length + ' 个失败' : '');
            }
            if (btn) btn.disabled = false;
        }


        // 语言切换
        const translations = {
            en: {
                'page.title': 'File Share',
                'promo.desc': 'Turn your GitHub repos into a private cloud drive<br>Multi-repo management, smart storage allocation, one-click sharing',
                'footer.powered': 'Powered by',
                'footer.stored': 'Stored on GitHub',
                'loading': 'Loading files...',
                'downloadAll': '⬇️ Download All as ZIP',
                'download': 'Download',
                'clickDownload': 'Click to download',
                'promo.title': 'Want unlimited cloud storage with GitHub?',
                'promo.btn': '🚀 Use GitHub Drive Now',
                'previewAll': 'Preview all images',
                'imgCount': '{n} images can be previewed directly',
                'lb.hint': '← → switch · Esc close'
            },
            zh: {
                'page.title': '文件分享',
                'promo.desc': 'GitHub Drive 把你的 GitHub 仓库变成私人云盘<br>支持多仓库统一管理、智能容量分配、一键分享',
                'footer.powered': '由',
                'footer.stored': '存储于 GitHub',
                'loading': '加载文件中...',
                'downloadAll': '⬇️ 打包下载全部 (ZIP)',
                'download': '下载',
                'clickDownload': '点击下载',
                'promo.title': '也想用 GitHub 当无限云盘？',
                'promo.btn': '🚀 立即使用 GitHub Drive',
                'previewAll': '一键预览全部图片',
                'imgCount': '共 {n} 张图片可直接预览',
                'lb.hint': '← → 切换 · Esc 关闭'
            }
        };
        // localStorage 在隐私模式/第三方上下文会抛异常，必须包起来，
        // 否则整段脚本停摆，页面又变成"点了没反应"
        function readLang() { try { return localStorage.getItem('gd_share_lang'); } catch (e) { return null; } }
        function writeLang(v) { try { localStorage.setItem('gd_share_lang', v); } catch (e) {} }
        let currentLang = readLang() || 'en';
        function applyLang(lang) {
            currentLang = lang;
            writeLang(lang);
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (translations[lang][key]) el.innerHTML = translations[lang][key];
            });
            document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
            // 预览按钮文案带数量，是 JS 拼的，没有 data-i18n —— 得手动刷
            const pb = document.getElementById('previewAllBtn');
            if (pb && pb.style.display !== 'none') {
                pb.textContent = '🖼️ ' + translations[lang].previewAll + ' (' + imageFiles.length + ')';
            }
            const tip = document.getElementById('imgCountTip');
            if (tip) tip.textContent = translations[lang].imgCount.replace('{n}', imageFiles.length);
        }
        function toggleLang() {
            applyLang(currentLang === 'en' ? 'zh' : 'en');
        }
        // 初始化语言
        applyLang(currentLang);
    </script>
</body>
</html>`;
    }

    /**
     * 生成 README
     */
    generateReadme(repoName, description, files, username, displayPath) {
        const dp = displayPath || (f => f.path);
        const fileList = files.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js' && f.path !== '.nojekyll');
        let md = `# ${description || I18n.t('share.pageTitle')}\n\n`;
        md += `> 通过 [GitHub Drive](https://${this.escapeHtml(username)}.github.io/github_drive) 分享的文件\n\n`;
        md += `## 文件列表\n\n`;
        fileList.forEach(f => {
            md += `- [${dp(f)}](./${f.path.split('/').map(encodeURIComponent).join('/')})\n`;
        });
        md += `\n---\n*由 GitHub Drive 自动生成*`;
        return md;
    }

    /**
     * 获取分享的文件列表（从分享仓库读取）
     */
    async getShareFiles(repoName) {
        const username = await this.api.getUsername();
        const contents = await this.api.getDirectoryContents(username, repoName, '', 'main');
        const skip = new Set(['index.html', 'README.md', '.gitkeep',
                              'status.js', 'share.json', '.nojekyll']);
        return contents.filter(item => item.type === 'file' && !skip.has(item.name));
    }

    /**
     * 删除分享（删除仓库）
     */
    async deleteShare(repoName) {
        const username = await this.api.getUsername();
        await this.api.deleteRepository(username, repoName);
        // 从本地记录移除
        const shares = this.storage.getShares().filter(s => s.repoName !== repoName);
        this.storage.set(this.storage.keys.SHARES, shares);
    }

    /**
     * 搜索公开分享
     *
     * ★ 以前只搜 `gd-share in:name`，导致**自己的分享一条都看不到**。
     *   实测：这个查询命中 105 个仓库，绝大多数是无关项目
     *   （gd-sharer / GDA_Capstone_Project_Cyclistic_Bike-share / GDPR /
     *   gdrive-share / gd_share_client…），用户自己的分享排在第 84、85、89 位。
     *   而 perPage 只有 30 —— 一页根本装不到，页面就显示"暂无公开分享"。
     *
     *   更糟的是那 30 个无关仓库还要逐个去读 share.json 验证，
     *   全是无效请求，所以列表不但空、还很慢。
     *
     *   两个毛病叠在一起：
     *     1) 查询太宽（105 个里 102 个是噪音）
     *     2) 自己的分享不保证在榜
     *
     *   改法：
     *     a) 改用 topic:gd-share 精确检索（实测 total: 105 → 1，全是真分享）
     *        创建分享时会打 topic；历史仓库补一次即可。
     *     b) 自己的分享直接并入，不依赖搜索索引
     *        （GitHub 搜索索引有延迟，刚分享的可能几分钟内搜不到 ——
     *         那时就算查询再准也照样是空的）
     *     c) share.json 校验并发化，不再逐条串行等待
     */
    async searchShares(page = 1, perPage = 30) {
        const TOPIC_Q = 'topic:gd-share';
        const NAME_Q = 'gd-share- in:name';

        let result;
        try {
            result = await this.api.searchRepositories(TOPIC_Q, page, perPage);
        } catch (e) {
            console.warn('[Share] topic 搜索失败，退回名字搜索:', e.message);
            result = { items: [], total_count: 0 };
        }
        let repos = result.items || [];

        // topic 还没被索引到（老仓库没打过 topic）时退回名字搜索，
        // 至少让广场不是空的
        if ((!repos.length) && page === 1) {
            try {
                const fb = await this.api.searchRepositories(NAME_Q, page, perPage);
                repos = fb.items || [];
                result = { items: repos, total_count: fb.total_count || repos.length };
            } catch (e) {
                console.warn('[Share] 名字搜索也失败:', e.message);
            }
        }

        const shares = await this._verifyShares(repos);

        // ★ 自己的分享并入（仅首页），保证"刚分享完就能在广场看到"
        if (page === 1) {
            try {
                const mine = await this.listMyShares();
                const seen = new Set(shares.map(s => `${s.owner}/${s.repoName}`.toLowerCase()));
                for (const m of mine) {
                    // ★ listMyShares 的返回里**没有 owner 字段**，只有 fullName。
                    //   写成 m.owner 的话 key 会变成 "/仓库名"，跟上面 seen 里的
                    //   "用户名/仓库名" 永远对不上 —— 去重失效，同一个分享出现两次。
                    const ownerLogin = m.owner || (m.fullName || '').split('/')[0] || '';
                    const key = `${ownerLogin}/${m.repoName}`.toLowerCase();
                    if (seen.has(key)) continue;
                    const built = await this._buildShareFromRepo({
                        name: m.repoName,
                        owner: { login: ownerLogin },
                        description: m.description,
                        created_at: m.createdAt,
                        updated_at: m.updatedAt,
                        stargazers_count: 0,
                        default_branch: 'main',
                        html_url: m.repoUrl
                    });
                    if (built) { built.isMine = true; shares.unshift(built); seen.add(key); }
                }
            } catch (e) {
                console.warn('[Share] 并入自己的分享失败（不影响广场）:', e.message);
            }
        }

        return {
            shares,
            total: result.total_count || shares.length,
            hasMore: page * perPage < (result.total_count || 0)
        };
    }

    /**
     * 并发校验一批候选仓库是不是真的分享（有合法的 share.json）
     * @private
     */
    async _verifyShares(repos, concurrency = 6) {
        const shares = [];
        const queue = repos.slice();
        async function worker() {
            while (queue.length) {
                const repo = queue.shift();
                try {
                    const built = await this._buildShareFromRepo(repo);
                    if (built) shares.push(built);
                } catch (e) {
                    console.debug('[Share] 跳过非标准分享仓库:', repo.name, e.message);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) },
            () => worker.call(this)));
        // 并发完成后顺序会乱，按更新时间倒序稳定下来
        shares.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        return shares;
    }

    /**
     * 读一个仓库的 share.json 并组装成分享卡片；不合法返回 null
     * @private
     */
    async _buildShareFromRepo(repo) {
        const ownerLogin = repo.owner?.login || (repo.full_name || '').split('/')[0] || '';
        if (!ownerLogin || !repo.name) return null;
        const meta = await this.api.getFileRaw(
            ownerLogin, repo.name, 'share.json', repo.default_branch || 'main');
        const metaText = new TextDecoder('utf-8').decode(meta);
        const metaJson = JSON.parse(metaText);
        if (metaJson.type !== 'github-drive-share') return null;
        return {
            repoName: repo.name,
            owner: ownerLogin,
            name: metaJson.name || repo.name,
            description: metaJson.description || repo.description || '',
            author: metaJson.author || ownerLogin,
            avatar: repo.owner?.avatar_url || '',
            fileCount: metaJson.fileCount || 0,
            files: metaJson.files || [],
            createdAt: metaJson.createdAt || repo.created_at,
            updatedAt: repo.updated_at,
            stars: repo.stargazers_count || 0,
            pagesUrl: `https://${ownerLogin}.github.io/${repo.name}/`,
            repoUrl: repo.html_url || `https://github.com/${ownerLogin}/${repo.name}`
        };
    }

    /**
     * 工具：休眠
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
