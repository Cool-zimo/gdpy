/**
 * 应用主入口 v2
 * 统一目录视图，用户感受不到仓库存在
 */
class App {
    constructor() {
        this.api = null;
        this.storage = new Storage();
        // 清理旧版本遗留的分享密码（那些是 base64 明文，留着没意义）
        try { this.storage.purgeLegacySharePasswords(); } catch (e) { /* 清理失败不影响使用 */ }
        this.fileManager = null;
        this.shareManager = null;
        this.configSync = null;
        // 初始设为 null，稍后在 DOM 加载完成后初始化
        this.ui = null;
        this.currentFiles = [];
    }

    async init() {
        I18n.init();
        // 显示版本号
        this.updateAppVersion();
        const token = this.storage.getToken();
        if (token) {
            // 有本地 token：先显示应用界面（避免闪登录页），再异步验证
            this.showApp();
            await this.initializeWithToken(token);
        } else {
            this.showLogin();
        }
    }

    showLogin() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
        this.ui?.renderSavedAccounts();
    }
    

    showApp() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
    }

    // 显示应用版本号（从 script 标签提取）
    updateAppVersion() {
        const versionEl = document.getElementById('app-version');
        if (!versionEl) return;
        // 对外显示正式版本号，内部日期版本号作为 tooltip
        const formalVersion = (typeof APP_VERSION !== 'undefined') ? APP_VERSION.displayVersion : 'v0.0.0';
        const dateVersion = (typeof APP_VERSION !== 'undefined') ? APP_VERSION.internalVersion : 'unknown';
        versionEl.textContent = formalVersion;
        versionEl.title = I18n.t('app.versionTitle').replace('{version}', dateVersion);
    }

    async login(token) {
        token = token.trim();
        if (!token) { 
            this.ui?.showToast(I18n.t('login.enterToken'), 'error'); 
            return; 
        }
        
        // 更严格的 Token 格式校验
        if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
            this.ui?.showToast(I18n.t('login.tokenPrefix'), 'error');
            console.error('[App] Invalid token format provided.');
            return;
        }

        // 检查 github_pat_ 类型 Token 的长度
        if (token.startsWith('github_pat_')) {
            // github_pat_ 格式的 token 长度通常在 100 位以上
            if (token.length < 100) {
                this.ui?.showToast(I18n.t('login.fineGrainedLength'), 'error');
                console.error('[App] github_pat_ token seems to be of invalid length.');
                return;
            }
        } else if (token.startsWith('ghp_')) {
            // ghp_ 格式的 token 长度通常是 40 位
            if (token.length !== 40) {
                this.ui?.showToast(I18n.t('login.tokenLength'), 'error');
                console.error('[App] ghp_ token seems to be of invalid length.');
                return;
            }
        }
        
        console.log('[App] Attempting to login with token format: ', token.startsWith('ghp_') ? 'classic (ghp_)' : 'fine-grained (github_pat_)');
        try {
            this.ui?.showToast(I18n.t('login.validating'), 'info');
            this.api = new GitHubAPI(token);
            const user = await this.api.getMe();
            this.storage.setToken(token);
            this.storage.setUser(user);
            this.storage.addAccount(token, user);
            // 同步给仓鼠（同源 localStorage 共享），让对面也是已登录状态
            this.syncTokenToBridge(token, user);
            // 确保当前账号 ID 已设置（addAccount 里已设置，这里双重保险）
            this.storage.set(this.storage.keys.CURRENT_ACCOUNT, this.storage._getAccountId());
            await this.initializeWithToken(token);
            this.ui?.showToast(I18n.t('login.success'), 'success');
        } catch (e) {
            console.error('登录失败:', e);
            let errorMessage = '登录失败';
            if (e.status === 401) {
                errorMessage = 'Token 无效或已过期，请检查并重试';
            } else if (e.status === 403) {
                errorMessage = 'Token 权限不足，请确保拥有 repo 和 workflow 权限';
            } else if (e.message) {
                errorMessage += `: ${e.message}`;
            }
            this.ui?.showToast(errorMessage, 'error');
        }
    }

    // ================= 与仓鼠联动 =================

    get bridge() { return (typeof window !== 'undefined') ? window.Bridge : null; }

    /** 把令牌同步到仓鼠的存储位置，让对面免登录 */
    syncTokenToBridge(token, user) {
        const B = this.bridge;
        if (!B) return;
        try { B.saveToken(token, user); } catch (e) { /* 不影响主流程 */ }
    }

    /**
     * 在侧边栏挂"切换到仓鼠"按钮
     * 带上当前存储仓库，跳过去能直接定位
     */
    mountBridgeButton() {
        const B = this.bridge;
        const slot = document.getElementById('app-switch-slot');
        if (!B || !B.other() || !slot) return;
        slot.innerHTML = B.switchButtonHtml();
        document.getElementById('app-switch-btn')?.addEventListener('click', () => {
            const cur = this.storage ? (this.storage.getCurrentRepo?.() || null) : null;
            B.go(cur ? { repo: cur } : {});
        });
    }

    async initializeWithToken(token) {
        this.mountBridgeButton();
        if (!this.api) this.api = new GitHubAPI(token);
        // 设置限流警告回调
        this.api.onRateLimitWarning = (level, info) => {
            const resetTime = info.reset ? new Date(info.reset * 1000).toLocaleTimeString() : '未知';
            if (level === 'critical') {
                this.ui?.showToast(I18n.t('api.rateLimit').replace('{remaining}', info.remaining).replace('{time}', resetTime), 'error');
            } else {
                this.ui?.showToast(`⚠️ API 剩余 ${info.remaining} 次请求，${resetTime} 重置`, 'warning');
            }
        };
        this.fileManager = new FileManager(this.api, this.storage);
        this.shareManager = new ShareManager(this.api, this.storage);
        // UI 只创建一次，避免重复绑定事件导致 toast/导航重复触发
        if (!this.ui) {
            this.ui = new UI(this);
            window.ui = this.ui;
            window.app = this;
        }

        this.configSync = new ConfigSync(this.api, this.storage);
        this.storage.onConfigChange = () => this.configSync.scheduleSync();

        try { await this.configSync.init(); } catch (e) { console.warn('配置同步初始化失败:', e.message); }

        this.showApp();
        // 更新仓库体积显示
        setTimeout(() => this.updateRepoSizeDisplay(), 1500);

        // 验证 token 有效性（401 说明 token 无效/过期，回登录页）
        try {
            const user = await this.api.getMe();
            this.storage.setUser(user);
        } catch (e) {
            console.warn('[App] 获取用户信息失败:', e.message);
            if (e.status === 401) {
                this.ui?.showToast(I18n.t('login.invalidToken'), 'error');
                this.logout();
                return;
            }
        }
        const user = this.storage.getUser();
        if (user) this.ui.renderUserInfo(user);
        
        // 数据修复 + 实时同步：从 GitHub 获取当前用户的所有 drive-storage-* 仓库
        // 覆盖本地可能混乱的仓库列表，确保数据严格隔离
        if (user && user.login) {
            try {
                // 修复：原版只取第 1 页（上限 100），仓库数超过 100 时会漏掉靠后的存储仓。
                // 且列表按 updated 排序，长期未更新的存储仓排在最末，最容易被截断丢失。
                const allRepos = [];
                for (let page = 1; page <= 10; page++) {
                    const batch = await this.api.listRepositories(100, page);
                    if (!Array.isArray(batch) || batch.length === 0) break;
                    allRepos.push(...batch);
                    if (batch.length < 100) break;
                }
                const storageRepos = allRepos
                    .filter(r => r.name.startsWith('drive-storage-') && r.owner.login === user.login)
                    .map(r => ({
                        owner: r.owner.login,
                        repo: r.name,
                        name: r.name,
                        description: r.description || '',
                        branch: r.default_branch || 'main',
                        isDefault: false,
                        addedAt: new Date().toISOString()
                    }));
                
                // 按更新时间排序，最新的作为默认仓库
                if (storageRepos.length > 0) {
                    storageRepos[0].isDefault = true;
                }
                
                const oldRepos = this.storage.getRepos();
                if (JSON.stringify(oldRepos) !== JSON.stringify(storageRepos)) {
                    console.log(`[App] 从 GitHub 同步仓库列表: ${oldRepos.length} → ${storageRepos.length} 个存储仓库`);
                    this.storage.setRepos(storageRepos);
                }
                this._repoSizeFailed = false;
            } catch (e) {
                console.warn('[App] 同步仓库列表失败，使用本地缓存:', e.message);
                // 同步失败时，至少清理 owner 不匹配的仓库
                const repos = this.storage.getRepos();
                const validRepos = repos.filter(r => r.owner === user.login);
                if (validRepos.length !== repos.length) {
                    this.storage.setRepos(validRepos);
                }
            }
        }
        // 恢复上次浏览状态
        const restored = this.restoreLastState();
        if (restored) {
            // 已恢复路径和视图，switchView会自动加载文件
        } else {
            await this.loadFiles();
        }
        this.fileManager.syncAllRepoUsage().then(() => this.ui.renderRepoList()).catch(() => {});
    }

    logout() { this.storage.clearToken(); this.storage.setUser(null); location.reload(); }
    
    // 切换账号
    async switchAccount(accountId) {
        // 先保存当前账号的最后浏览状态
        try { this.saveLastState(); } catch(e) {}
        // 严格数据隔离：切换账号前清除当前账号的所有本地缓存
        // 这样新账号会从远程重新读取 config，不会和旧账号数据混淆
        this.storage.clearCurrentAccountData();
        const account = this.storage.setCurrentAccount(accountId);
        if (account) {
            location.reload();
        }
    }
    
    // 删除账号
    removeAccount(accountId) {
        this.storage.removeAccount(accountId);
        // 如果删除的是当前账号，回到登录页
        if (!this.storage.getCurrentAccountId()) {
            this.storage.clearToken();
            this.storage.setUser(null);
            location.reload();
        }
    }

    async loadFiles() {
        if (!this.fileManager) return;
        this.ui.showLoading();
        this.ui.renderBreadcrumb();
        try {
            const files = await this.fileManager.listFiles();
            this.currentFiles = files;
            this.ui.renderFileList(files);
        } catch (e) {
            this.ui.showToast('加载文件失败: ' + e.message, 'error');
            document.getElementById('loading-state')?.classList.add('hidden');
        }
    }

    async navigateTo(path) { 
        this.fileManager.setCurrentPath(path); 
        this.saveLastState();
        await this.loadFiles(); 
    }
    
    // 保存上次浏览状态（路径+视图）
    saveLastState() {
        try {
            const currentPath = this.fileManager.currentPath || '/drive_home';
            // 不保存回收站路径
            if (currentPath.includes('.trash')) return;
            const state = {
                path: currentPath,
                view: this._currentView || 'all-files',
                time: Date.now()
            };
            this.storage.set('last_state', state);
        } catch (e) { /* 忽略 */ }
    }
    
    // 恢复上次浏览状态
    restoreLastState() {
        try {
            const saved = this.storage.get('last_state', null);
            if (!saved) return false;
            const state = saved;
            const view = state.view || 'all-files';
            this._currentView = view;
            if (view === 'all-files') {
                // 文件视图：恢复路径并加载
                if (state.path) {
                    this.fileManager.setCurrentPath(state.path);
                }
                this.loadFiles();
            } else {
                // 其他视图：切换视图会自动加载对应内容
                if (this.ui) this.ui.switchView(view);
            }
            return true;
        } catch (e) { return false; }
    }

    async openFile(file) {
        if (file.isFolder) { await this.navigateTo(file.path); }
        else { this.previewFile(file); }
    }

    async previewFile(file) {
        try {
            this.ui.showToast(I18n.t('file.previewLoading') || '正在加载预览...', 'info');
            let blob = await this.fileManager.getFileBlob(file.path);
            if (!blob || !(blob instanceof Blob) || blob.size === 0) {
                throw new Error('文件数据无效或为空');
            }
            // 文本文件自动检测编码（GBK/UTF-8），避免乱码
            const textExts = ['txt','md','csv','log','json','js','css','html','htm','xml','yaml','yml','ini','conf','py','java','c','cpp','h','go','rs','ts','jsx','tsx','sh','bat','sql'];
            const ext = file.name.split('.').pop().toLowerCase();
            if (textExts.includes(ext)) {
                const buf = await blob.arrayBuffer();
                let text = null;
                // 先尝试 UTF-8（严格模式，失败则抛异常）
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
                } catch {
                    // UTF-8 失败，尝试 GBK
                    try {
                        text = new TextDecoder('gbk').decode(buf);
                    } catch {
                        // GBK 也失败，用默认 UTF-8（带替换字符）
                        text = new TextDecoder('utf-8').decode(buf);
                    }
                }
                // 用 UTF-8 重新编码，加 BOM 确保浏览器识别
                const utf8Buf = new TextEncoder().encode(text);
                const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                const withBom = new Uint8Array(bom.length + utf8Buf.length);
                withBom.set(bom, 0);
                withBom.set(utf8Buf, bom.length);
                blob = new Blob([withBom], { type: 'text/plain;charset=utf-8' });
            }
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            this.storage.addToRecent(file.path);
        } catch (e) { this.ui.showToast((I18n.t('file.previewFailed') || '预览失败') + ': ' + e.message, 'error'); }
    }

    async downloadFile(file) {
        try {
            this.ui.showDownloadProgress(file.name);
            await this.fileManager.downloadFile(file.path, (percent, current, total) => {
                this.ui.updateDownloadProgress(percent, current, total);
            });
            this.ui.hideDownloadProgress();
            this.ui.showToast('下载完成', 'success');
        } catch (e) {
            this.ui.hideDownloadProgress();
            this.ui.showToast(I18n.t('file.downloadFailed') + ': ' + e.message, 'error');
        }
    }

    async deleteFile(file, permanent = false) {
        const isInTrash = file.path.startsWith('/drive_home/.trash/');
        const reallyDelete = permanent || isInTrash;
        if (reallyDelete) {
            if (!confirm(`确定要永久删除 "${file.name}" 吗？此操作不可撤销，文件将从 GitHub 仓库彻底删除。`)) return;
        } else {
            if (!confirm(`确定要删除 "${file.name}" 吗？文件将移到回收站，可在 30 天内恢复。`)) return;
        }
        try {
            if (reallyDelete) {
                // 永久删除：删除 GitHub 分片
                if (file.isFolder) {
                    await this.fileManager.deleteFolder(file.path);
                } else {
                    await this.fileManager.deleteFile(file.path);
                }
                this.ui.showToast(`已永久删除: ${file.name}`, 'success');
            } else {
                // 移到回收站：只修改虚拟路径，不删除 GitHub 分片
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const trashPath = `/drive_home/.trash/${timestamp}_${file.name}`;
                this.storage.moveItem(file.path, trashPath);
                this.ui.showToast(`已移到回收站: ${file.name}`, 'success');
            }
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('删除失败: ' + e.message, 'error'); }
    }
    
    // 从回收站恢复文件
    async restoreFile(file) {
        try {
            // 从回收站路径提取原始文件名（去掉时间戳前缀）
            const trashName = file.path.split('/').pop();
            const originalName = trashName.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/, '');
            const restorePath = `/drive_home/${originalName}`;
            this.storage.moveItem(file.path, restorePath);
            this.ui.showToast(`已恢复: ${originalName}`, 'success');
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('恢复失败: ' + e.message, 'error'); }
    }

    async deleteFiles(files, permanent = false) {
        if (!files || files.length === 0) return;
        if (files.length === 1) { this.deleteFile(files[0], permanent); return; }
        const hasInTrash = files.some(f => f.path.startsWith('/drive_home/.trash/'));
        const reallyDelete = permanent || hasInTrash;
        if (reallyDelete) {
            if (!confirm(`确定要永久删除选中的 ${files.length} 个项目吗？此操作不可撤销。`)) return;
        } else {
            if (!confirm(`确定要删除选中的 ${files.length} 个项目吗？文件将移到回收站。`)) return;
        }
        try {
            let success = 0, failed = 0;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            for (const f of files) {
                try {
                    if (reallyDelete) {
                        if (f.isFolder) await this.fileManager.deleteFolder(f.path);
                        else await this.fileManager.deleteFile(f.path);
                    } else {
                        const trashPath = `/drive_home/.trash/${timestamp}_${f.name}`;
                        this.storage.moveItem(f.path, trashPath);
                    }
                    success++;
                } catch (e) { failed++; }
            }
            const msg = failed > 0 ? `已删除 ${success} 个，失败 ${failed} 个` : `已删除 ${success} 个项目`;
            this.ui.showToast(msg, failed > 0 ? 'warning' : 'success');
            this.ui.deselectFile();
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('删除失败: ' + e.message, 'error'); }
    }

    async renameFile(file, newName) {
        if (!file) file = this.ui.contextMenuTarget;
        if (!newName) newName = document.getElementById('rename-input')?.value?.trim();
        if (!file || !newName) { this.ui.showToast(I18n.t('error.enterNewName'), 'error'); return; }
        try {
            await this.fileManager.renameItem(file.path, newName);
            this.ui.showToast(I18n.t('toast.renameSuccess'), 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('重命名失败: ' + e.message, 'error'); }
    }

    // 移动文件（虚拟路径，只需修改配置）
    async moveFile(file) {
        const files = file ? (Array.isArray(file) ? file : [file]) : (this.ui._moveFiles || []);
        const targetPath = this.ui._moveTargetPath || '';
        if (!files || files.length === 0) { this.ui.showToast(I18n.t('error.selectFiles'), 'error'); return; }
        try {
            let success = 0;
            for (const f of files) {
                const newPath = targetPath ? `/drive_home/${targetPath}/${f.name}` : `/drive_home/${f.name}`;
                if (f.isFolder && (newPath === f.path || newPath.startsWith(f.path + '/'))) continue;
                this.storage.moveItem(f.path, newPath);
                success++;
            }
            this.ui.showToast(`已移动 ${success} 个项目`, 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('移动失败: ' + e.message, 'error'); }
    }

    async moveFileByDrag(file, targetFolderPath) {
        if (!file || !targetFolderPath) return;
        try {
            const fileName = file.name;
            const newPath = `${targetFolderPath}/${fileName}`;
            if (newPath === file.path) return;
            if (file.isFolder && newPath.startsWith(file.path + '/')) {
                this.ui.showToast(I18n.t('error.cannotMoveToSubfolder'), 'error');
                return;
            }
            this.storage.moveItem(file.path, newPath);
            this.ui.showToast(`已移动到 ${targetFolderPath.split('/').pop() || '根目录'}`, 'success');
            await this.loadFiles();
        } catch (e) { this.ui.showToast('移动失败: ' + e.message, 'error'); }
    }

    // 复制文件（下载原文件内容，重新上传到目标位置）
    async copyFile(file) {
        const files = file ? (Array.isArray(file) ? file : [file]) : (this.ui._copyFiles || []);
        const targetPath = this.ui._copyTargetPath || '';
        if (!files || files.length === 0) { this.ui.showToast(I18n.t('error.selectFiles'), 'error'); return; }
        try {
            this.ui.showToast(I18n.t('common.copying'), 'info');
            this.ui.closeModal();
            const targetFullPath = targetPath ? `/drive_home/${targetPath}` : '/drive_home';
            let success = 0;
            for (const f of files) {
                const content = await this.fileManager.getFileContent(f.path);
                const blob = new Blob([content]);
                const fileObj = new File([blob], f.name, { type: 'application/octet-stream' });
                await this.fileManager.uploadFile(fileObj, targetFullPath);
                success++;
            }
            this.ui.showToast(`已复制 ${success} 个项目`, 'success');
            await this.loadFiles();
        } catch (e) { this.ui.showToast('复制失败: ' + e.message, 'error'); }
    }

    async uploadFiles(files) {
        if (!files || files.length === 0) return;
        this.ui.showUploadProgress?.(files);
        try {
            for (let i = 0; i < files.length; i++) {
                await this.fileManager.uploadFile(files[i], this.fileManager.currentPath, (percent) => {
                    this.ui.updateUploadProgress?.(i, percent, files.length);
                });
                this.ui.setUploadSuccess?.(i);
            }
            this.ui.showToast(`成功上传 ${files.length} 个文件`, 'success');
            await this.loadFiles();
            // 显示成功状态 2 秒后自动关闭面板
            setTimeout(() => this.ui.hideUploadProgress?.(), 2000);
        } catch (e) {
            this.ui.showToast(I18n.t('file.uploadFailed') + ': ' + e.message, 'error');
            setTimeout(() => this.ui.hideUploadProgress?.(), 3000);
        }
    }

    async uploadFolder(files) {
        if (!files || files.length === 0) return;
        const items = files.map(f => ({
            file: f,
            relativePath: f.webkitRelativePath || f.name
        }));
        this.ui.showUploadProgress?.(items.map(it => ({ name: it.relativePath })));
        try {
            for (let i = 0; i < items.length; i++) {
                const { file, relativePath } = items[i];
                // 保留完整相对路径（包括外层文件夹名）
                const subPath = relativePath;
                const lastSlash = subPath.lastIndexOf('/');
                const parentPath = lastSlash > 0 ? '/drive_home/' + subPath.substring(0, lastSlash) : '/drive_home';
                // 确保父文件夹存在
                if (parentPath !== '/drive_home') {
                    await this.ensureFolderPath(parentPath);
                }
                await this.fileManager.uploadFile(file, parentPath, (percent) => {
                    this.ui.updateUploadProgress?.(i, percent);
                });
                this.ui.setUploadSuccess?.(i);
            }
            this.ui.showToast(`成功上传 ${items.length} 个文件`, 'success');
            await this.loadFiles();
            setTimeout(() => this.ui.hideUploadProgress?.(), 2000);
        } catch (e) {
            this.ui.showToast(I18n.t('file.uploadFailed') + ': ' + e.message, 'error');
            setTimeout(() => this.ui.hideUploadProgress?.(), 3000);
        }
    }

    async ensureFolderPath(path) {
        const parts = path.replace(/^\/drive_home\/?/, '').split('/').filter(Boolean);
        let current = '/drive_home';
        for (const part of parts) {
            current += '/' + part;
            if (!this.storage.exists(current)) {
                this.storage.putFolder(current);
            }
        }
    }

    async createFolder(name) {
        if (!name) name = document.getElementById('new-folder-name')?.value?.trim();
        if (!name) { this.ui.showToast(I18n.t('error.enterFolderName'), 'error'); return; }
        try {
            await this.fileManager.createFolder(name);
            this.ui.showToast(I18n.t('toast.folderCreated'), 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('创建失败: ' + e.message, 'error'); }
    }

    async shareFiles(files) {
        if (!files) files = this.ui._shareFiles || [];
        if (files.length === 0) { this.ui.showToast(I18n.t('share.noFiles'), 'error'); return; }
        const shareName = document.getElementById('share-name')?.value?.trim() || '';
        const shareDesc = document.getElementById('share-desc')?.value?.trim() || '';
        try {
            this.ui.closeModal();
            // 专用进度弹窗替代 toast 刷屏：进度条 + 步骤，一目了然
            this.ui.showShareProgress(files.length);
            const virtualPaths = files.map(f => f.path);
            const result = await this.shareManager.shareByVirtualPaths(virtualPaths, shareName, shareDesc, (percent, msg) => {
                this.ui.updateShareProgress(percent, msg);
            });
            this.ui.closeShareProgress();
            this.ui.showShareResult?.(result);
        } catch (e) {
            // 失败也要关掉进度弹窗，否则会一直挂着挡住后续操作
            this.ui.closeShareProgress();
            this.ui.showToast('分享失败: ' + e.message, 'error');
        }
    }

    async searchFiles(query) {
        if (!query.trim()) { await this.loadFiles(); return; }
        const searchContent = localStorage.getItem('gd_search_content') === '1';
        const results = this.fileManager.searchFiles(query, searchContent);
        this.currentFiles = results;
        this.ui.renderFileList(results);
    }




    // ==================== 文件版本历史 ====================
    async showFileHistory(file) {
        try {
            this.ui.showToast('正在加载版本历史...', 'info');
            const repos = this.storage.getRepos();
            if (repos.length === 0) return;
            const repo = repos[0];
            const history = await this.api.getFileHistory(repo.owner, repo.repo, file.path, repo.branch || 'main');
            if (history.length === 0) { this.ui.showToast('暂无版本历史', 'info'); return; }
            let body = '<div style="max-height:400px;overflow-y:auto;padding:8px 0;">';
            history.forEach((v, i) => {
                const date = new Date(v.date).toLocaleString('zh-CN');
                body += '<div style="padding:12px;border-bottom:1px solid #f3f4f6;display:flex;gap:12px;align-items:flex-start;">';
                body += '<div style="width:32px;height:32px;border-radius:50%;background:#e0e7ff;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">📝</div>';
                body += '<div style="flex:1;"><div style="font-size:13px;font-weight:600;">' + v.message.substring(0, 50) + '</div>';
                body += '<div style="font-size:11px;color:#6b7280;margin-top:2px;">' + v.author + ' · ' + date + '</div>';
                body += '<div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-top:2px;">' + v.sha + '</div></div>';
                if (i > 0) {
                    body += '<button onclick="app.restoreVersion(\'' + file.path + '\', \'' + v.fullSha + '\')" style="padding:4px 10px;background:#f3f4f6;border:none;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;">恢复</button>';
                } else {
                    body += '<span style="font-size:11px;color:#10b981;background:#d1fae5;padding:2px 8px;border-radius:4px;flex-shrink:0;">当前</span>';
                }
                body += '</div>';
            });
            body += '</div>';
            this.ui.showModal('📜 版本历史 - ' + file.name, body, '', true);
        } catch (e) { this.ui.showToast('加载失败: ' + e.message, 'error'); }
    }
    
    async restoreVersion(path, sha) {
        if (!confirm('确定要恢复到此版本吗？当前内容将被覆盖。')) return;
        try {
            const repos = this.storage.getRepos();
            const repo = repos[0];
            const content = await this.api.getFileAtVersion(repo.owner, repo.repo, path, sha);
            if (content !== null) {
                await this.fileManager.writeFileContent?.(path, content);
                this.ui.showToast('已恢复到指定版本', 'success');
                this.ui.closeModal();
                this.loadFiles();
            }
        } catch (e) { this.ui.showToast('恢复失败: ' + e.message, 'error'); }
    }

    // ==================== 仪表盘概览 ====================
    async showDashboard() {
        const container = document.getElementById('file-list');
        if (!container) return;
        container.className = 'dashboard-view';
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;"><div class="spinner" style="margin:0 auto 12px;"></div>加载仪表盘...</div>';
        
        const vfs = this.storage.getVFS();
        const files = Object.entries(vfs.files || {});
        const folders = Object.entries(vfs.folders || {});
        const favorites = this.storage.getFavorites?.() || [];
        const recent = this.storage.getRecent?.() || [];
        let totalSize = 0;
        const typeStats = {};
        files.forEach(([path, info]) => {
            totalSize += info.size || 0;
            const ext = (info.name.split('.').pop() || 'other').toLowerCase();
            typeStats[ext] = (typeStats[ext] || 0) + 1;
        });
        const topTypes = Object.entries(typeStats).sort((a,b) => b[1]-a[1]).slice(0, 5);
        const repoInfo = await this.getRepoSize().catch(() => null);
        
        const html = '<div style="padding:20px;max-width:1200px;margin:0 auto;">' +
            '<h2 style="font-size:22px;font-weight:700;margin-bottom:20px;color:#111827;">📊 仪表盘</h2>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;">' +
            '<div style="padding:20px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px;color:#fff;box-shadow:0 4px 12px rgba(102,126,234,0.3);"><div style="font-size:32px;font-weight:700;">' + files.length + '</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">📄 文件总数</div></div>' +
            '<div style="padding:20px;background:linear-gradient(135deg,#f093fb,#f5576c);border-radius:16px;color:#fff;box-shadow:0 4px 12px rgba(240,147,251,0.3);"><div style="font-size:32px;font-weight:700;">' + folders.length + '</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">📁 文件夹</div></div>' +
            '<div style="padding:20px;background:linear-gradient(135deg,#4facfe,#00f2fe);border-radius:16px;color:#fff;box-shadow:0 4px 12px rgba(79,172,254,0.3);"><div style="font-size:28px;font-weight:700;">' + (totalSize/1024/1024).toFixed(1) + ' MB</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">💾 本地缓存</div></div>' +
            '<div style="padding:20px;background:linear-gradient(135deg,#43e97b,#38f9d7);border-radius:16px;color:#fff;box-shadow:0 4px 12px rgba(67,233,123,0.3);"><div style="font-size:32px;font-weight:700;">' + favorites.length + '</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">⭐ 收藏</div></div></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">' +
            '<div style="padding:20px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
            '<div style="font-size:16px;font-weight:600;margin-bottom:16px;color:#111827;">📦 GitHub 仓库存储</div>' +
            (repoInfo ? '<div style="font-size:14px;color:#6b7280;line-height:1.8;">仓库: ' + repoInfo.name + '<br>大小: ' + repoInfo.sizeMB + ' MB<br>分支: main</div>' : '<div style="font-size:14px;color:#9ca3af;">加载中...</div>') +
            '</div>' +
            '<div style="padding:20px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
            '<div style="font-size:16px;font-weight:600;margin-bottom:16px;color:#111827;">📊 文件类型分布</div>' +
            (files.length > 0 ? topTypes.map(([ext, count]) => {
                const pct = (count/files.length*100).toFixed(1);
                return '<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span style="color:#374151;">.' + ext + '</span><span style="color:#6b7280;">' + count + ' (' + pct + '%)</span></div><div style="height:8px;background:#f3f4f6;border-radius:4px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:4px;transition:width 0.3s;"></div></div></div>';
            }).join('') : '<div style="font-size:13px;color:#9ca3af;">暂无文件</div>') +
            '</div></div>' +
            '<div style="margin-top:20px;padding:20px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
            '<div style="font-size:16px;font-weight:600;margin-bottom:16px;color:#111827;">🕐 最近使用</div>' +
            (recent.length > 0 ? recent.slice(0,8).map(p => '<div style="display:flex;align-items:center;padding:10px 12px;background:#f9fafb;border-radius:8px;margin-bottom:6px;cursor:pointer;" onclick="app.openFileByPath(\'' + p + '\')"><span style="margin-right:8px;">📄</span><span style="font-size:13px;color:#374151;">' + p.split('/').pop() + '</span><span style="margin-left:auto;font-size:11px;color:#9ca3af;">' + p + '</span></div>').join('') : '<div style="font-size:13px;color:#9ca3af;text-align:center;padding:20px;">暂无最近文件</div>') +
            '</div></div>';
        container.innerHTML = html;
    }

    // ==================== 文件标签管理 ====================
    showTagManager(file) {
        const currentTags = this.storage.getFileTags(file.path);
        const allTags = this.storage.getAllTags();
        let body = '<div style="padding:8px 0;">';
        body += '<div style="font-size:13px;color:#6b7280;margin-bottom:8px;">文件: ' + file.name + '</div>';
        body += '<div style="margin-bottom:16px;"><div style="font-size:14px;font-weight:600;margin-bottom:8px;">当前标签</div>';
        if (currentTags.length > 0) {
            body += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
            currentTags.forEach(tag => {
                body += '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#dbeafe;color:#1e40af;border-radius:12px;font-size:12px;">#' + tag + '<button onclick="app.removeTag(\'' + file.path + '\', \'' + tag + '\')" style="background:none;border:none;cursor:pointer;color:#1e40af;font-weight:bold;">×</button></span>';
            });
            body += '</div>';
        } else { body += '<div style="font-size:13px;color:#9ca3af;">暂无标签</div>'; }
        body += '</div>';
        if (allTags.length > 0) {
            body += '<div style="margin-bottom:16px;"><div style="font-size:14px;font-weight:600;margin-bottom:8px;">常用标签</div><div style="display:flex;flex-wrap:wrap;gap:6px;">';
            allTags.forEach(tag => {
                if (!currentTags.includes(tag)) {
                    body += '<button onclick="app.addTag(\'' + file.path + '\', \'' + tag + '\')" style="padding:4px 10px;background:#f3f4f6;border:none;border-radius:12px;cursor:pointer;font-size:12px;">#' + tag + '</button>';
                }
            });
            body += '</div></div>';
        }
        body += '<div><div style="font-size:14px;font-weight:600;margin-bottom:8px;">新建标签</div>';
        body += '<div style="display:flex;gap:8px;"><input id="new-tag-input" type="text" placeholder="输入标签名" style="flex:1;padding:8px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;">';
        body += '<button onclick="app.addNewTag(\'' + file.path + '\')" style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">添加</button></div></div></div>';
        this.ui.showModal('🏷️ 标签管理', body, '', false);
    }
    addTag(path, tag) { this.storage.addFileTag(path, tag); this.showTagManager({path, name: path.split('/').pop()}); this.loadFiles(); }
    removeTag(path, tag) { this.storage.removeFileTag(path, tag); this.showTagManager({path, name: path.split('/').pop()}); this.loadFiles(); }
    addNewTag(path) { const input = document.getElementById('new-tag-input'); if (input && input.value.trim()) { this.addTag(path, input.value.trim()); input.value = ''; } }

    // ==================== 高级筛选 ====================
    applyAdvancedFilter() {
        const type = document.getElementById('filter-type')?.value || '';
        const size = document.getElementById('filter-size')?.value || '';
        const sort = document.getElementById('filter-sort')?.value || 'name';
        const order = document.getElementById('filter-order')?.value || 'asc';
        let files = [...(this.currentFiles || [])];
        if (type) {
            const typeMap = { image: ['jpg','jpeg','png','gif','webp','svg'], video: ['mp4','avi','mkv','mov'], audio: ['mp3','wav','flac','aac'], document: ['pdf','doc','docx','xls','xlsx','txt','md','csv'], code: ['js','py','java','c','cpp','go','html','css','json'], archive: ['zip','rar','7z','tar','gz'] };
            const exts = typeMap[type] || [];
            files = files.filter(f => { if (f.isFolder) return type === ''; const ext = (f.name.split('.').pop() || '').toLowerCase(); return exts.includes(ext); });
        }
        if (size) {
            const ranges = { tiny: [0, 100*1024], small: [100*1024, 1024*1024], medium: [1024*1024, 10*1024*1024], large: [10*1024*1024, 100*1024*1024], huge: [100*1024*1024, Infinity] };
            const [min, max] = ranges[size] || [0, Infinity];
            files = files.filter(f => f.isFolder || (f.size >= min && f.size < max));
        }
        files.sort((a, b) => {
            let cmp = 0;
            if (sort === 'name') cmp = a.name.localeCompare(b.name);
            else if (sort === 'size') cmp = (a.size || 0) - (b.size || 0);
            else if (sort === 'date') cmp = new Date(a.modified || 0) - new Date(b.modified || 0);
            else if (sort === 'type') cmp = (a.name.split('.').pop() || '').localeCompare(b.name.split('.').pop() || '');
            return order === 'desc' ? -cmp : cmp;
        });
        this.ui.renderFileList(files);
        this.ui.closeModal();
        this.ui.showToast('筛选结果: ' + files.length + ' 个文件', 'success');
    }

    // ==================== 分享密码（已移除） ====================
    //
    // 分享 = 公开仓库 + GitHub Pages，本身就是公开的。
    // 原密码实现只防误点、不防真想看的人（详见 storage.js 同名注释），
    // 留着反而给用户虚假的安全感，所以整体砍掉。
    //
    // 需要保护的内容：不要分享。要分享的：就当它公开。

    // ==================== 智能文件分类 ====================
    async smartOrganize() {
        if (!confirm('将自动按文件类型整理到对应文件夹，是否继续？')) return;
        const vfs = this.storage.getVFS();
        const files = Object.entries(vfs.files || {}).map(([path, info]) => ({path, ...info}));
        const categories = { '图片': ['jpg','jpeg','png','gif','webp','svg'], '视频': ['mp4','avi','mkv','mov'], '音频': ['mp3','wav','flac','aac'], '文档': ['pdf','doc','docx','xls','xlsx','txt','md','csv'], '代码': ['js','py','java','c','cpp','go','html','css','json'], '压缩包': ['zip','rar','7z','tar','gz'], '应用': ['exe','dmg','apk'], '设计': ['psd','ai','fig'] };
        let moved = 0, created = 0;
        for (const file of files) {
            if (file.path.includes('/')) continue;
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            let category = '其他';
            for (const [cat, exts] of Object.entries(categories)) { if (exts.includes(ext)) { category = cat; break; } }
            if (!this.storage.folderExists?.(category)) { await this.fileManager.createFolder?.(category); created++; }
            const newPath = category + '/' + file.name;
            if (file.path !== newPath) { await this.fileManager.moveFile?.(file.path, newPath); moved++; }
        }
        this.ui.showToast('智能整理完成：创建 ' + created + ' 个文件夹，移动 ' + moved + ' 个文件', 'success');
        this.loadFiles();
    }
    showCategoryStats() {
        const vfs = this.storage.getVFS();
        const files = Object.entries(vfs.files || {}).map(([path, info]) => ({path, ...info}));
        const categories = { '🖼️ 图片': ['jpg','jpeg','png','gif','webp'], '🎬 视频': ['mp4','avi','mkv','mov'], '🎵 音频': ['mp3','wav','flac'], '📄 文档': ['pdf','doc','docx','xls','xlsx','txt','md','csv'], '💻 代码': ['js','py','java','c','cpp','go','html','css','json'], '📦 压缩包': ['zip','rar','7z','tar','gz'], '📱 应用': ['exe','dmg','apk'], '📁 其他': [] };
        const stats = {};
        Object.keys(categories).forEach(c => stats[c] = 0);
        files.forEach(f => {
            const ext = (f.name.split('.').pop() || '').toLowerCase();
            let found = false;
            for (const [cat, exts] of Object.entries(categories)) { if (exts.includes(ext)) { stats[cat]++; found = true; break; } }
            if (!found) stats['📁 其他']++;
        });
        let body = '<div style="padding:8px 0;"><div style="font-size:13px;color:#6b7280;margin-bottom:16px;">共 ' + files.length + ' 个文件</div>';
        for (const [cat, count] of Object.entries(stats)) {
            if (count === 0) continue;
            const pct = (count / files.length * 100).toFixed(1);
            body += '<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>' + cat + '</span><span style="color:#6b7280;">' + count + ' 个 (' + pct + '%)</span></div>';
            body += '<div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:4px;"></div></div></div>';
        }
        body += '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;"><button onclick="app.smartOrganize()" style="width:100%;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;">✨ 一键智能整理</button></div></div>';
        this.ui.showModal('🎯 智能分类', body, '', true);
    }

    // ==================== 在线文件编辑 ====================
    async editFile(file) {
        try {
            const content = await this.fileManager.getFileContent?.(file.path);
            this._editingFile = file;
            this.ui.showOnlineEditor(file, content);
        } catch (e) {
            this.ui.showToast('无法读取文件: ' + e.message, 'error');
        }
    }
    
    async saveEditedFile() {
        const textarea = document.getElementById('editor-textarea');
        const statusEl = document.getElementById('editor-status');
        if (!textarea || !this._editingFile) return;
        
        try {
            if (statusEl) statusEl.textContent = '保存中...';
            const content = textarea.value;
            await this.fileManager.writeFileContent?.(this._editingFile.path, content);
            if (statusEl) statusEl.textContent = '✅ 已保存';
            this.ui.showToast('文件已保存', 'success');
            this._editingFile = null;
            setTimeout(() => { this.ui.closeModal(); this.loadFiles(); }, 800);
        } catch (e) {
            if (statusEl) statusEl.textContent = '❌ 保存失败';
            this.ui.showToast('保存失败: ' + e.message, 'error');
        }
    }

    // ==================== 快捷键系统 ====================
    initShortcuts() {
        document.addEventListener('keydown', (e) => {
            // 输入框中不触发快捷键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                if (e.key === 'Escape') e.target.blur();
                return;
            }
            
            const ctrl = e.ctrlKey || e.metaKey;
            
            // Ctrl + N: 新建文件夹
            if (ctrl && e.key === 'n') {
                e.preventDefault();
                this.ui.showNewFolderModal?.();
                return;
            }
            
            // Ctrl + U: 上传文件
            if (ctrl && e.key === 'u') {
                e.preventDefault();
                this.ui.openUploadModal?.();
                return;
            }
            
            // Ctrl + F: 搜索
            if (ctrl && e.key === 'f') {
                e.preventDefault();
                const searchInput = document.getElementById('search-input');
                if (searchInput) searchInput.focus();
                return;
            }
            
            // Ctrl + R: 刷新（阻止浏览器刷新）
            if (ctrl && e.key === 'r') {
                e.preventDefault();
                this.loadFiles();
                this.ui.showToast('已刷新', 'success');
                return;
            }
            
            // Delete / Backspace: 删除选中文件
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedFiles?.length > 0) {
                e.preventDefault();
                this.deleteSelectedFiles();
                return;
            }
            
            // F2: 重命名
            if (e.key === 'F2' && this.selectedFiles?.length === 1) {
                e.preventDefault();
                this.ui.showRenameModal?.(this.selectedFiles[0]);
                return;
            }
            
            // Escape: 取消选择/关闭弹窗
            if (e.key === 'Escape') {
                this.selectedFiles = [];
                this.ui.renderFileList?.(this.currentFiles);
                return;
            }
            
            // Ctrl + A: 全选
            if (ctrl && e.key === 'a') {
                e.preventDefault();
                this.selectedFiles = [...(this.currentFiles || [])];
                this.ui.renderFileList?.(this.currentFiles, { selected: this.selectedFiles });
                return;
            }
            
            // Ctrl + D: 收藏/取消收藏
            if (ctrl && e.key === 'd' && this.selectedFiles?.length === 1) {
                e.preventDefault();
                this.toggleStar(this.selectedFiles[0]);
                return;
            }
            
            // ?: 显示快捷键帮助
            if (e.key === '?' || (e.shiftKey && e.key === '/')) {
                e.preventDefault();
                this.showShortcutsHelp();
                return;
            }
        });
    }
    
    showShortcutsHelp() {
        const shortcuts = [
            { key: 'Ctrl + N', desc: '新建文件夹' },
            { key: 'Ctrl + U', desc: '上传文件' },
            { key: 'Ctrl + F', desc: '搜索文件' },
            { key: 'Ctrl + R', desc: '刷新文件列表' },
            { key: 'Ctrl + A', desc: '全选文件' },
            { key: 'Ctrl + D', desc: '收藏/取消收藏' },
            { key: 'Delete', desc: '删除选中文件' },
            { key: 'F2', desc: '重命名文件' },
            { key: 'Escape', desc: '取消选择/关闭弹窗' },
            { key: '?', desc: '显示快捷键帮助' }
        ];
        const body = '<div style="padding:8px 0;">' + 
            shortcuts.map(s => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6;">
                <span style="font-family:monospace;background:#f3f4f6;padding:4px 10px;border-radius:4px;font-size:13px;">${s.key}</span>
                <span style="font-size:14px;color:#374151;">${s.desc}</span>
            </div>`).join('') + '</div>';
        this.ui.showModal?.('⌨️ 快捷键列表', body, '', true);
    }
    
    deleteSelectedFiles() {
        if (!this.selectedFiles || this.selectedFiles.length === 0) return;
        const count = this.selectedFiles.length;
        if (confirm(`确定要删除选中的 ${count} 个文件吗？`)) {
            this.deleteFiles(this.selectedFiles);
            this.selectedFiles = [];
        }
    }

    // 收藏/取消收藏
    async toggleStar(file) {
        const isFav = this.storage.toggleFavorite(file.path);
        this.ui.showToast(isFav ? I18n.t('toast.starred') : I18n.t('toast.unstarred'), 'success');
        await this.loadFiles();
    }

    // 最近使用
    // 显示回收站文件
    async showTrashFiles() {
        try {
            const trashPath = '/drive_home/.trash';
            const files = this.storage.listDirectory(trashPath);
            // 回收站视图：显示恢复和永久删除按钮
            this.ui.renderFileList(files, { isTrash: true });
        } catch (e) {
            this.ui.showToast('加载回收站失败: ' + e.message, 'error');
        }
    }
    
    async showRecentFiles() {
        const paths = this.storage.getRecent();
        const vfs = this.storage.getVFS();
        const items = [];
        for (const p of paths) {
            if (vfs.files[p]) items.push({ ...vfs.files[p], path: p, isFile: true });
            else if (vfs.folders[p]) items.push({ ...vfs.folders[p], path: p, isFolder: true });
        }
        this.currentFiles = items;
        this.ui.renderFileList(this.currentFiles);
        this.ui.showToast(I18n.t('toast.recentCount').replace('{count}', items.length), 'info');
    }

    // 收藏文件
    async showStarredFiles() {
        const paths = this.storage.getFavorites();
        const vfs = this.storage.getVFS();
        const items = [];
        for (const p of paths) {
            if (vfs.files[p]) items.push({ ...vfs.files[p], path: p, isFile: true });
            else if (vfs.folders[p]) items.push({ ...vfs.folders[p], path: p, isFolder: true });
        }
        this.currentFiles = items;
        this.ui.renderFileList(this.currentFiles);
        this.ui.showToast(I18n.t('toast.starredCount').replace('{count}', items.length), 'info');
    }

    // 我的分享
    //
    // 之前只读 localStorage，换浏览器/清缓存后就空了，
    // 但仓库本身还在 GitHub 上 —— 所以改为：
    //   ① 本地记录立即渲染（快，不白屏）
    //   ② 异步拉取账号下 gd-share-* 仓库（真实来源）
    //   ③ 以远程为准合并，本地记录补充描述等元信息
    async showShares() {
        const local = this.storage.getShares() || [];
        // 先渲染本地，避免等待时空白
        this.ui.showShareList?.(local, { loading: local.length === 0 });

        try {
            const remote = await this.shareManager.listMyShares();
            this.ui.showShareList?.(this._mergeShares(local, remote));
        } catch (e) {
            console.warn('拉取远程分享失败:', e.message);
            // 远程失败就只用本地，不打断用户
            this.ui.showShareList?.(local);
        }
    }

    /**
     * 合并本地记录与远程仓库
     * 以远程为准（仓库真实存在），本地补充描述、文件列表等元信息
     */
    _mergeShares(local, remote) {
        const localByRepo = {};
        for (const l of local) {
            if (!l.repoName) continue;
            localByRepo[l.repoName] = l;
        }
        const merged = remote.map(r => {
            const l = localByRepo[r.repoName];
            return {
                ...r,
                id: l?.id || r.repoName,          // 删除时用：本地有 id 用 id，否则用仓库名
                description: l?.description || r.description || '',
                files: l?.files || [],
                hasLocalRecord: !!l
            };
        });
        // 本地有、远程没了（仓库被删）/ 或还没被索引到的，也带上
        const remoteNames = new Set(remote.map(r => r.repoName));
        for (const l of local) {
            if (l.repoName && !remoteNames.has(l.repoName)) {
                merged.push({ ...l, missing: true });
            }
        }
        merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return merged;
    }

    // 发现分享（搜索公开分享）
    async showExploreShares() {
        this._explorePage = 1;
        this._exploreShares = [];
        this._exploreHasMore = true;
        const cached = this.getCache('gd_cache_explore');
        if (cached && cached.length > 0) {
            this._exploreShares = cached;
            this._explorePage = 2;
            this.ui.renderExploreShares?.(cached, true);
            // 后台静默刷新第一页
            this._refreshExploreCache();
        } else {
            this.ui.showExploreLoading?.();
            await this.loadMoreExploreShares();
        }
    }

    async _refreshExploreCache() {
        try {
            const result = await this.shareManager.searchShares(1, 30);
            if (result.shares.length > 0) {
                this._exploreShares = result.shares;
                this._exploreHasMore = result.hasMore;
                this._explorePage = 2;
                this.setCache('gd_cache_explore', result.shares);
                this.ui.renderExploreShares?.(result.shares, result.hasMore);
            }
        } catch (e) {
            console.debug('后台刷新分享失败:', e.message);
        }
    }

    async loadMoreExploreShares() {
        if (!this._exploreHasMore) return;
        const isFirstPage = this._explorePage === 1;
        try {
            const result = await this.shareManager.searchShares(this._explorePage, 30);
            this._exploreShares = this._exploreShares.concat(result.shares);
            this._exploreHasMore = result.hasMore;
            this._explorePage++;
            this.ui.renderExploreShares?.(this._exploreShares, this._exploreHasMore);
            if (isFirstPage && result.shares.length > 0) {
                this.setCache('gd_cache_explore', result.shares);
            }
        } catch (e) {
            this.ui.showToast('加载分享失败: ' + e.message, 'error');
            this.ui.renderExploreShares?.(this._exploreShares, false);
        }
    }

    // ==================== 后端服务配置 ====================
    // ==================== 仓库体积监控 ====================
    
    async getRepoSize() {
        // 如果之前已经失败过，直接返回，避免重复请求
        if (this._repoSizeFailed) return null;
        try {
            const owner = this.storage.getUser()?.login;
            if (!owner) return null;
            
            // 优先访问存储仓库（drive-storage-*），而不是默认的 github_drive
            const repos = this.storage.getRepos();
            if (repos.length === 0) return null;
            
            // 计算所有存储仓库的总体积
            let totalSize = 0;
            let repoCount = 0;
            for (const repo of repos) {
                try {
                    const repoInfo = await this.api.getRepository(repo.owner, repo.repo);
                    totalSize += repoInfo.size || 0;
                    repoCount++;
                } catch (e) {
                    console.debug('获取仓库体积失败:', repo.repo, e.message);
                }
            }
            
            if (repoCount === 0) return null;
            
            return {
                size: totalSize, // KB
                sizeMB: (totalSize / 1024).toFixed(1),
                sizeGB: (totalSize / (1024 * 1024)).toFixed(2),
                name: `${repoCount} 个存储仓库`,
                full_name: `${owner}/drive-storage-*`
            };
        } catch (e) {
            this._repoSizeFailed = true;
            console.debug('获取仓库体积失败:', e.message);
            return null;
        }
    }
    

    // ==================== 存储用量统计 ====================
    async showStorageStats() {
        try {
            // 先显示加载中弹窗
            this.ui.showModal?.('📊 存储用量统计', '<div style="text-align:center;padding:40px;color:#6b7280;">⏳ 正在统计...</div>', '', true);
            
            const vfs = this.storage.getVFS();
            const files = Object.entries(vfs.files || {});
            const folders = Object.entries(vfs.folders || {});
            
            const typeStats = {};
            let totalSize = 0;
            files.forEach(([path, info]) => {
                const ext = (info.name.split('.').pop() || 'unknown').toLowerCase();
                typeStats[ext] = (typeStats[ext] || 0) + 1;
                totalSize += info.size || 0;
            });
            
            const sortedTypes = Object.entries(typeStats).sort((a, b) => b[1] - a[1]).slice(0, 8);
            const repoInfo = await this.getRepoSize();
            
            let typeHtml = '';
            sortedTypes.forEach(([ext, count]) => {
                const percent = (count / files.length * 100).toFixed(1);
                typeHtml += '<div style="margin-bottom:8px;">';
                typeHtml += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">';
                typeHtml += '<span style="color:#374151">.' + ext + '</span>';
                typeHtml += '<span style="color:#6b7280;">' + count + ' 个 (' + percent + '%)</span>';
                typeHtml += '</div>';
                typeHtml += '<div style="height:4px;background:#e5e7eb;border-radius:2px;overflow:hidden;">';
                typeHtml += '<div style="height:100%;width:' + percent + '%;background:#2563eb;"></div>';
                typeHtml += '</div></div>';
            });
            
            const repoHtml = repoInfo ? 
                '<div style="padding:12px;background:#f9fafb;border-radius:8px;">' +
                '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
                '<span style="font-size:13px;color:#6b7280;">GitHub 仓库大小</span>' +
                '<span style="font-size:13px;font-weight:600;">' + repoInfo.sizeMB + ' MB</span></div>' +
                '<div style="display:flex;justify-content:space-between;">' +
                '<span style="font-size:13px;color:#6b7280;">存储仓库数</span>' +
                '<span style="font-size:13px;font-weight:600;">' + repoInfo.name + '</span></div>' +
                '<div style="margin-top:8px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">' +
                '<div style="height:100%;width:' + Math.min(100, parseFloat(repoInfo.sizeMB) / 1024 * 100) + '%;background:linear-gradient(90deg,#2563eb,#7c3aed);"></div></div>' +
                '<div style="font-size:11px;color:#9ca3af;margin-top:4px;">GitHub 建议仓库不超过 1GB</div></div>'
                : '<div style="font-size:13px;color:#9ca3af;">仓库信息加载中...</div>';
            
            const body = '<div style="padding:8px 0;">' +
                '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">' +
                '<div style="text-align:center;padding:16px;background:#eff6ff;border-radius:12px;">' +
                '<div style="font-size:28px;font-weight:700;color:#2563eb;">' + files.length + '</div>' +
                '<div style="font-size:12px;color:#6b7280;">文件数</div></div>' +
                '<div style="text-align:center;padding:16px;background:#f0fdf4;border-radius:12px;">' +
                '<div style="font-size:28px;font-weight:700;color:#16a34a;">' + folders.length + '</div>' +
                '<div style="font-size:12px;color:#6b7280;">文件夹数</div></div>' +
                '<div style="text-align:center;padding:16px;background:#fef3c7;border-radius:12px;">' +
                '<div style="font-size:24px;font-weight:700;color:#d97706;">' + (totalSize/1024/1024).toFixed(2) + 'MB</div>' +
                '<div style="font-size:12px;color:#6b7280;">本地缓存</div></div></div>' +
                '<div style="margin-bottom:16px;"><div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:8px;">📦 仓库存储</div>' + repoHtml + '</div>' +
                '<div><div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:8px;">📊 文件类型分布</div>' +
                (sortedTypes.length > 0 ? typeHtml : '<div style="font-size:13px;color:#9ca3af;">暂无文件</div>') +
                '</div></div>';
            
            // 更新弹窗内容
            const modalBody = document.querySelector('.modal-body');
            if (modalBody) {
                modalBody.innerHTML = body;
            } else {
                this.ui.showModal?.('📊 存储用量统计', body, '', true);
            }
        } catch (e) {
            this.ui.showToast?.('统计失败: ' + e.message, 'error');
            this.ui.closeModal?.();
        }
    }

    async updateRepoSizeDisplay() {
        const info = await this.getRepoSize();
        const el = document.getElementById('repo-size-display');
        if (!el || !info) return;
        const sizeMB = parseFloat(info.sizeMB);
        let color = '#6b7280';
        let warning = '';
        if (sizeMB > 900) {
            color = '#dc2626';
            warning = ' ⚠️ 接近上限';
        } else if (sizeMB > 500) {
            color = '#f59e0b';
            warning = ' ⚠️';
        }
        el.innerHTML = `<span style="color:${color};">📦 ${info.sizeMB} MB${warning}</span>`;
        el.title = `仓库：${info.full_name}
体积：${info.sizeMB} MB (${info.sizeGB} GB)
GitHub 建议不超过 1 GB`;
        if (sizeMB > 900) {
            this.ui?.showToast(`⚠️ 仓库体积已达 ${info.sizeMB} MB，接近 1 GB 上限！建议清理历史记录或迁移部分文件`, 'error');
        }
    }

    // ==================== 数据导出/导入 ====================
    
    exportBackup() {
        try {
            const data = this.storage.exportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `github_drive_backup_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.ui?.showToast(I18n.t('toast.backupExported'), 'success');
        } catch (e) {
            this.ui?.showToast('导出失败: ' + e.message, 'error');
        }
    }
    
    importBackup(file) {
        if (!file) {
            // 触发文件选择
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                if (e.target.files[0]) this.importBackup(e.target.files[0]);
            };
            input.click();
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!confirm(I18n.t('backup.importConfirm'))) return;
                this.storage.importData(data);
                this.ui?.showToast(I18n.t('backup.imported'), 'success');
                setTimeout(() => location.reload(), 1500);
            } catch (err) {
                this.ui?.showToast(I18n.t('backup.importFailed'), 'error');
            }
        };
        reader.readAsText(file);
    }

    getBackendConfig() {
        try {
            return JSON.parse(localStorage.getItem('gd_backend_config') || '{}');
        } catch { return {}; }
    }

    saveBackendConfig(config) {
        localStorage.setItem('gd_backend_config', JSON.stringify(config));
    }

    async backendRequest(data) {
        const config = this.getBackendConfig();
        const baseUrl = config.url || 'http://localhost:8787';
        const token = config.token || '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Auth-Token'] = token;
        const resp = await fetch(baseUrl + data.path, {
            method: data.method || 'GET',
            headers,
            body: data.body ? JSON.stringify(data.body) : undefined
        });
        return resp.json();
    }

    // ==================== 插件系统 ====================
    PLUGIN_REPO = 'Cool-zimo/github_drive_plugins';
    PLUGIN_REPO_BRANCH = 'main';

    getInstalledPlugins() {
        try { return JSON.parse(localStorage.getItem('gd_plugins') || '{}'); }
        catch { return {}; }
    }

    saveInstalledPlugins(plugins) {
        localStorage.setItem('gd_plugins', JSON.stringify(plugins));
    }

    CACHE_TTL = 5 * 60 * 1000; // 缓存5分钟

    getCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            if (Date.now() - cache.timestamp > this.CACHE_TTL) return null;
            return cache.data;
        } catch { return null; }
    }

    setCache(key, data) {
        try { localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() })); } catch {}
    }

    // 搜索第三方插件（众筹模式，搜索 GD-Plugin- 开头的仓库）
    async searchCommunityPlugins(page = 1, perPage = 30) {
        // 命名格式：GD-Plugin-{项目名}-{开发者}
        const result = await this.api.searchRepositories('GD-Plugin in:name', page, perPage);
        const repos = result.items || [];
        const plugins = [];
        // 严格命名格式正则
        const nameRegex = /^GD-Plugin-[^-]+-[^-]+$/;
        for (const repo of repos) {
            try {
                // 跳过官方仓库
                if (repo.full_name === 'Cool-zimo/github_drive_plugins') continue;
                // 1. 严格检查仓库名格式
                if (!nameRegex.test(repo.name)) {
                    console.debug('跳过命名格式不符的仓库:', repo.name);
                    continue;
                }
                // 2. 检查是否空仓库（size=0 或没有默认分支）
                if (repo.size === 0 || !repo.default_branch) {
                    console.debug('跳过空仓库:', repo.full_name);
                    continue;
                }
                // 3. 必须有 plugin.json
                let manifest = null;
                let entryFile = null;
                try {
                    const raw = await this.api.getFileRaw(repo.owner.login, repo.name, 'plugin.json', repo.default_branch);
                    manifest = JSON.parse(new TextDecoder('utf-8').decode(raw));
                    entryFile = manifest?.file;
                } catch {
                    console.debug('跳过无plugin.json的仓库:', repo.full_name);
                    continue;
                }
                // 4. 入口文件必须在 plugin.json 中指定
                if (!entryFile) {
                    console.debug('跳过plugin.json未指定入口文件的仓库:', repo.full_name);
                    continue;
                }
                const plugin = {
                    id: 'community-' + repo.full_name.replace('/', '-'),
                    name: manifest?.name || repo.name,
                    description: manifest?.description || repo.description || '暂无描述',
                    author: manifest?.author || repo.owner.login,
                    version: manifest?.version || '1.0.0',
                    icon: manifest?.icon || '🧩',
                    type: manifest?.type || 'plugin',
                    file: entryFile,
                    community: true,
                    repoUrl: repo.html_url,
                    repoFullName: repo.full_name,
                    stars: repo.stargazers_count,
                    updatedAt: repo.updated_at,
                    hasManifest: !!manifest
                };
                plugins.push(plugin);
            } catch (e) {
                console.debug('跳过插件仓库:', repo.full_name, e.message);
            }
        }
        return { plugins, total: result.total_count || 0, hasMore: repos.length >= perPage };
    }

    // 安装第三方插件
    async installCommunityPlugin(pluginInfo) {
        try {
            this.ui.showToast('正在安装 ' + pluginInfo.name + '...', 'info');
            const [owner, repo] = pluginInfo.repoFullName.split('/');
            let data;
            try {
                data = await this.api.getFileRaw(owner, repo, pluginInfo.file, 'main');
            } catch (e) {
                this.ui.showToast('安装失败：入口文件 "' + pluginInfo.file + '" 不存在，请去插件仓库确认', 'error');
                window.open(pluginInfo.repoUrl, '_blank');
                return;
            }
            const html = new TextDecoder('utf-8').decode(data);
            const installed = this.getInstalledPlugins();
            installed[pluginInfo.id] = {
                ...pluginInfo,
                html,
                installedAt: new Date().toISOString()
            };
            this.saveInstalledPlugins(installed);
            this.ui.showToast(pluginInfo.name + ' 安装成功', 'success');
            this.showPluginMarket();
        } catch (e) {
            this.ui.showToast('安装失败: ' + e.message, 'error');
        }
    }

    async showPluginMarket() {
        const cached = this.getCache('gd_cache_plugins');
        const installed = this.getInstalledPlugins();
        if (cached) {
            this.ui.renderPluginMarket?.(cached, installed);
            // 后台静默更新
            this._refreshPluginCache();
        } else {
            this.ui.showPluginLoading?.();
            await this._refreshPluginCache();
        }
    }

    async _refreshPluginCache() {
        try {
            const [owner, repo] = this.PLUGIN_REPO.split('/');
            const data = await this.api.getFileRaw(owner, repo, 'plugins.json', this.PLUGIN_REPO_BRANCH);
            const manifestText = new TextDecoder('utf-8').decode(data);
            const manifest = JSON.parse(manifestText);
            const plugins = manifest.plugins || [];
            this.setCache('gd_cache_plugins', plugins);
            const installed = this.getInstalledPlugins();
            this.ui.renderPluginMarket?.(plugins, installed);
        } catch (e) {
            if (!this.getCache('gd_cache_plugins')) {
                this.ui.showToast('加载插件市场失败: ' + e.message, 'error');
                this.ui.renderPluginMarket?.([], {});
            }
        }
    }

    async installPlugin(pluginInfo) {
        try {
            this.ui.showToast('正在安装 ' + pluginInfo.name + '...', 'info');
            const [owner, repo] = this.PLUGIN_REPO.split('/');
            const data = await this.api.getFileRaw(owner, repo, pluginInfo.file, this.PLUGIN_REPO_BRANCH);
            const html = new TextDecoder('utf-8').decode(data);
            const installed = this.getInstalledPlugins();
            installed[pluginInfo.id] = {
                ...pluginInfo,
                html,
                installedAt: new Date().toISOString()
            };
            this.saveInstalledPlugins(installed);
            this.ui.showToast(pluginInfo.name + ' 安装成功', 'success');
            this.showPluginMarket();
        } catch (e) {
            this.ui.showToast('安装失败: ' + e.message, 'error');
        }
    }

    uninstallPlugin(pluginId) {
        const installed = this.getInstalledPlugins();
        const plugin = installed[pluginId];
        if (!plugin) return;
        if (!confirm('确定卸载 "' + plugin.name + '" 吗？')) return;
        delete installed[pluginId];
        this.saveInstalledPlugins(installed);
        this.ui.showToast('已卸载 ' + plugin.name, 'success');
        this.showPluginMarket();
    }

    runPlugin(pluginId) {
        const installed = this.getInstalledPlugins();
        const plugin = installed[pluginId];
        if (!plugin) { this.ui.showToast(I18n.t('plugin.notInstalled'), 'error'); return; }
        this.ui.showPluginRunner?.(plugin);
    }

    // 插件 API（postMessage 通信）
    /**
     * 取仓鼠联动实例（懒创建）
     * 用当前登录用户的 token 走 GitHub API 读写 cangshu-config
     */
    _cangshu() {
        const user = this.storage.getUser();
        const owner = user?.login;
        if (!owner || !this.api) return null;
        if (!this._cangshuLink || this._cangshuLink.owner !== owner) {
            this._cangshuLink = new CangshuLink(this.api, owner);
        }
        return this._cangshuLink;
    }

    /** 当前 CangshuLink 使用的 owner（可能为 null） */
    _cangshuOwner() {
        const u = this.storage.getUser();
        return (u && u.login) || null;
    }

    /** 用修正后的 owner 重建 CangshuLink */
    _resetCangshuLink(login) {
        this._cangshuLink = null;
        if (this.storage.setUser) {
            const u = this.storage.getUser() || {};
            this.storage.setUser({ ...u, login });
        }
        this._cangshuLink = new CangshuLink(this.api, login);
        console.warn('[App] 本地账号信息与令牌不符，已按令牌真实身份修正：', login);
    }

    /**
     * 用当前令牌反查真实登录身份
     *
     * 结果缓存到本次会话：/user 是高频接口，
     * 没必要每个 status 都打一次。登出/换 token 时清掉即可。
     *
     * @returns {Promise<{login:string, cachedLogin:string|null}|null>}
     */
    async _resolveTokenOwner() {
        const cachedLogin = this._cangshuOwner();
        if (this._tokenOwner && this._tokenOwnerFor === this.api?.token) {
            return { login: this._tokenOwner, cachedLogin };
        }
        if (!this.api) return null;
        try {
            const me = await this.api.getMe();
            const login = me && me.login;
            if (!login) return null;
            this._tokenOwner = login;
            this._tokenOwnerFor = this.api.token;
            return { login, cachedLogin };
        } catch (e) {
            // 拿不到就退回本地值，不阻断流程
            return cachedLogin ? { login: cachedLogin, cachedLogin } : null;
        }
    }

    /**
     * 在已保存的其它账号里找 cangshu-config
     *
     * 场景：Drive 支持多账号，用户可能在 A 账号装了仓鼠、
     * 却在 B 账号下打开插件。这时配置当然找不到，
     * 但报错只说"没有 cangshu-config"，用户会以为仓鼠没装。
     *
     * 这里用其它账号的 token 试探一次，把配置真正所在的账号找出来，
     * 让插件能提示"请切换到 XXX"。
     *
     * @param {string} currentOwner 当前登录账号（跳过）
     * @returns {Promise<string|null>} 找到的账号 login，没找到返回 null
     */
    async _findConfigInOtherAccounts(currentOwner) {
        try {
            const accounts = this.storage.getAccounts() || [];
            for (const acc of accounts) {
                const login = acc && acc.user && acc.user.login;
                const token = acc && acc.token;
                if (!login || !token || login === currentOwner) continue;
                try {
                    const resp = await fetch(
                        `https://api.github.com/repos/${encodeURIComponent(login)}/cangshu-config`,
                        { headers: { 'Authorization': `token ${token}`,
                                     'Accept': 'application/vnd.github+json' },
                          cache: 'no-store' }
                    );
                    if (resp.ok) return login;
                } catch (e) { /* 这个账号没权限，试下一个 */ }
            }
        } catch (e) { /* storage 不可用等，忽略 */ }
        return null;
    }

    handlePluginMessage(event, pluginId) {
        const data = event.data;
        if (!data || data.type !== 'gd-api') return;
        const { id, action, data: payload } = data;
        const respond = (result, error) => {
            event.source.postMessage({ type: 'gd-response', id, result, error }, '*');
        };

        (async () => {
            try {
                switch (action) {
                    case 'listFiles': {
                        const path = payload.path || '/drive_home';
                        const items = this.storage.listDirectory(path);
                        respond(items.map(f => ({
                            name: f.name, path: f.path,
                            isFolder: !!f.isFolder, size: f.size || 0
                        })));
                        break;
                    }
                    case 'downloadFile': {
                        const blob = await this.fileManager.getFileBlob(payload.path);
                        const text = await blob.text();
                        respond(text);
                        break;
                    }
                    case 'uploadFile': {
                        const { name, content, path } = payload;
                        const blob = new Blob([content], { type: 'application/octet-stream' });
                        const file = new File([blob], name);
                        await this.fileManager.uploadFile(file, path || '/drive_home');
                        await this.loadFiles();
                        respond({ success: true });
                        break;
                    }
                    case 'showToast':
                        this.ui.showToast(payload.message, payload.type || 'info');
                        respond({ success: true });
                        break;
                    case 'getCurrentPath':
                        respond(this.fileManager.currentPath);
                        break;
                    case 'getToken':
                        respond(this.storage.getToken());
                        break;
                    case 'getBackendConfig':
                        respond(this.getBackendConfig());
                        break;
                    case 'backendRequest': {
                        const config = this.getBackendConfig();
                        const baseUrl = config.url || 'http://localhost:8787';
                        const token = config.token || '';
                        const headers = { 'Content-Type': 'application/json' };
                        if (token) headers['X-Auth-Token'] = token;
                        const resp = await fetch(baseUrl + (payload.path || '/'), {
                            method: payload.method || 'GET',
                            headers,
                            body: payload.body ? JSON.stringify(payload.body) : undefined
                        });
                        const text = await resp.text();
                        try { respond(JSON.parse(text)); } catch { respond(text); }
                        break;
                    }
                    // ==================== 仓鼠联动 ====================
                    // 读写「仓鼠」的管理配置，实现两个应用数据互通。
                    // 配置真实来源是 GitHub 仓库 cangshu-config/cangshu.json，
                    // 所以直接用 Drive 的令牌读写即可，跨设备一致。
                    case 'cangshu.status': {
                        // 先用令牌反查真实身份。
                        // owner 原本取自 localStorage 存的 user 对象，
                        // 但老版本升级上来的数据、或多账号切换残留，
                        // 都可能让 user.login 与当前 token 不属于同一账号。
                        // 一旦错位就会出现：用 A 的 token 去查 B 的名下
                        // → 读不到配置 → 判"没装" → 创建却报"已存在"。
                        const real = await this._resolveTokenOwner();
                        if (!real) { respond(null, '未登录或令牌无效'); break; }
                        if (real.login && real.login !== this._cangshuOwner()) {
                            this._resetCangshuLink(real.login);
                        }
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const inst = await link.isInstalled();
                        const cfg = await link.getConfig();
                        // 带上 owner：插件要能告诉用户"当前登录的是哪个账号"。
                        // 配置仓库是账号私有的，Feng-zimo 下找不到 Cool-zimo 的
                        // cangshu-config 是正常现象，不提示账号就会让人以为没装仓鼠。
                        const exists = !!(cfg.ok && cfg.exists);
                        let configOwner = exists ? link.owner : null;
                        // 当前账号没有 → 去已保存的其它账号里找。
                        // 多账号场景下很可能是登错了账号，直接告诉用户配置在哪。
                        if (!exists) {
                            configOwner = await this._findConfigInOtherAccounts(link.owner);
                        }
                        respond({
                            installed: !!inst.installed,
                            exists,
                            owner: link.owner,
                            configRepo: link.configRepo,
                            // 配置实际所在的账号（与 owner 不同 = 登错账号了）
                            configOwner,
                            // 令牌的真实身份。与 owner 不同说明本地账号信息过期/错位，
                            // 界面上要提示用户，否则他们会一直排查错方向。
                            tokenOwner: real.login,
                            mismatch: !!(real.login && real.login !== real.cachedLogin),
                            cachedLogin: real.cachedLogin || null,
                            count: (cfg.ok && cfg.data && cfg.data.managed) ? cfg.data.managed.length : 0,
                            url: link.url,
                            tokenShared: !!(window.Bridge && window.Bridge.findToken())
                        });
                        break;
                    }
                    case 'cangshu.getConfig': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.getConfig();
                        respond(r.ok ? r.data : null, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.listRepos': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.listRepos(!!payload.detail);
                        respond(r.ok ? r.repos : null, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.addRepo': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.addRepo(payload.owner, payload.repo, payload.meta || {});
                        respond(r, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.removeRepo': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.removeRepo(payload.owner, payload.repo);
                        respond(r, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.hasRepo': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.hasRepo(payload.owner, payload.repo);
                        respond(r.ok ? r.has : null, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.setAlias': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.setAlias(payload.owner, payload.repo, payload.alias || '');
                        respond(r, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.ensureConfig': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        const r = await link.ensureConfigRepo();
                        respond(r, r.ok ? undefined : r.error);
                        break;
                    }
                    case 'cangshu.open': {
                        const link = this._cangshu();
                        if (!link) { respond(null, '未登录'); break; }
                        respond(link.open(payload.params || { repo: payload.repo }));
                        break;
                    }
                    case 'cangshu.url':
                        respond('https://cool-zimo.github.io/cangshu/');
                        break;

                    // ==================== 跨应用桥 ====================
                    case 'bridge.apps': {
                        const B = window.Bridge;
                        respond(B ? Object.keys(B.APPS).map(k => ({
                            id: B.APPS[k].id, name: B.APPS[k].name, icon: B.APPS[k].icon
                        })) : []);
                        break;
                    }
                    case 'bridge.current': {
                        const B = window.Bridge;
                        respond(B && B.current() ? B.current().id : null);
                        break;
                    }
                    case 'bridge.go': {
                        const B = window.Bridge;
                        if (!B) { respond(null, 'Bridge 不可用'); break; }
                        respond({ ok: !!B.go(payload.params || {}) });
                        break;
                    }
                    case 'bridge.getToken': {
                        const B = window.Bridge;
                        respond(B ? B.findToken() : null);
                        break;
                    }
                    case 'bridge.otherLoggedIn': {
                        const B = window.Bridge;
                        respond(!!(B && B.otherHasToken()));
                        break;
                    }
                    case 'api.listActions':
                        respond([
                            'listFiles', 'downloadFile', 'uploadFile', 'showToast',
                            'getCurrentPath', 'getToken', 'getBackendConfig', 'backendRequest',
                            'cangshu.status', 'cangshu.getConfig', 'cangshu.listRepos',
                            'cangshu.addRepo', 'cangshu.removeRepo', 'cangshu.hasRepo',
                            'cangshu.setAlias', 'cangshu.ensureConfig', 'cangshu.open', 'cangshu.url',
                            'bridge.apps', 'bridge.current', 'bridge.go',
                            'bridge.getToken', 'bridge.otherLoggedIn',
                            'api.listActions'
                        ]);
                        break;

                    default:
                        respond(null, '未知 API: ' + action);
                }
            } catch (e) {
                respond(null, e.message);
            }
        })();
    }


    async deleteShare(id) {
        // 兼容两种来源：本地记录用 id，远程仓库直接用仓库名
        const shares = this.storage.getShares() || [];
        let share = shares.find(s => s.id === id);
        if (!share) share = { repoName: id, description: id };

        const name = share.description || share.repoName || I18n.t('share.unnamed');
        if (!confirm(I18n.t('share.deleteConfirm').replace('{name}', name))) return;

        try {
            await this.shareManager.deleteShare(share.repoName);
            // 清掉本地记录（可能没有，静默处理）
            try { this.storage.removeShare(share.id); } catch (e) {}
            this.ui.showToast(I18n.t('share.deleted'), 'success');
            await this.showShares();
        } catch (e) {
            this.ui.showToast('删除失败: ' + e.message, 'error');
        }
    }
}

let app = null;
let ui = null;

document.addEventListener('DOMContentLoaded', () => {
    app = new App();
    // 在 DOM 加载完成后初始化 UI，确保 UI 绑定的元素已存在于页面中
    app.ui = new UI(app);
    window.ui = app.ui;
    window.app = app;
    ui = app.ui;
    // 同步检查本地 token：有则立即显示应用界面，避免刷新时闪一下登录页
    if (app.storage.getToken()) {
        app.showApp();
    }
    app.init().catch(e => {
        console.error('初始化失败:', e);
        app.showLogin();
        app.ui?.showToast('应用初始化失败: ' + e.message, 'error');
    });
});










