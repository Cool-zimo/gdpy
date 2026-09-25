/**
 * 本地存储模块 v2
 * 管理 Token、关联仓库、虚拟文件系统(VFS)、文件拆分关系、用户配置、仓库容量等
 * 
 * 虚拟文件系统结构：
 * /drive_home/ - 根目录，所有用户可见的文件都在这里
 *  - 文件：包含 chunks 数组，记录拆分后的分片在各仓库的实际位置
 *  - 文件夹：纯虚拟概念，只存在于配置中
 */
class Storage {
    constructor() {
        this.prefix = 'github_drive_';
        this.onConfigChange = null;
        this.keys = {
            TOKEN: 'token',
            USER: 'user',
            REPOS: 'repos',
            VFS: 'vfs',           // 虚拟文件系统 { files: {}, folders: {} }
            FAVORITES: 'favorites',
            RECENT: 'recent',
            SHARES: 'shares',
            SETTINGS: 'settings',
            REPO_USAGE: 'repo_usage',
            STORAGE_CONFIG: 'storage_config',
            ACCOUNTS: 'accounts',
            CURRENT_ACCOUNT: 'current_account',
        };
        // 需要按账号隔离的数据 key
        this.accountScopedKeys = [
            this.keys.VFS,
            this.keys.FAVORITES,
            this.keys.RECENT,
            this.keys.SHARES,
            this.keys.REPOS,
            this.keys.REPO_USAGE,
            this.keys.STORAGE_CONFIG,
            this.keys.SETTINGS,
        ];
    }
    
    // 获取当前账号 ID（直接读 localStorage，避免递归）
    _getAccountId() {
        try {
            const value = localStorage.getItem(this.prefix + this.keys.CURRENT_ACCOUNT);
            return value ? JSON.parse(value) : null;
        } catch { return null; }
    }
    
    // 获取带账号前缀的 key
    _accountKey(key) {
        if (this.accountScopedKeys.includes(key)) {
            return 'account_' + (this._getAccountId() || 'default') + '_' + key;
        }
        return key;
    }
    
    // 迁移旧数据到账号隔离的 key
    _migrateToAccountScoped() {
        const accountId = this._getAccountId() || 'default';
        
        // 1. 从旧的无前缀 key 迁移（首次升级）
        this.accountScopedKeys.forEach(key => {
            const oldKey = this.prefix + key;
            const newKey = this.prefix + 'account_' + accountId + '_' + key;
            const oldValue = localStorage.getItem(oldKey);
            const newValue = localStorage.getItem(newKey);
            if (oldValue !== null && newValue === null) {
                localStorage.setItem(newKey, oldValue);
            }
        });
        
        // 2. 新账号从空数据开始，不复制其他账号的数据（避免仓库列表混乱导致 401）
        // 每个账号有自己独立的存储仓库，自动创建即可
    }

    get(key, defaultValue = null) {
        // 访问账号相关数据时执行迁移检查（幂等，不会重复迁移）
        if (this.accountScopedKeys.includes(key)) {
            try { this._migrateToAccountScoped(); } catch { /* 忽略 */ }
        }
        try { const value = localStorage.getItem(this.prefix + this._accountKey(key)); return value ? JSON.parse(value) : defaultValue; } catch { return defaultValue; }
    }
    set(key, value) {
        localStorage.setItem(this.prefix + this._accountKey(key), JSON.stringify(value));
        if (this.onConfigChange && key !== this.keys.TOKEN && key !== this.keys.USER) {
            this.onConfigChange();
        }
    }
    remove(key) {
        localStorage.removeItem(this.prefix + this._accountKey(key));
        if (this.onConfigChange && key !== this.keys.TOKEN && key !== this.keys.USER) {
            this.onConfigChange();
        }
    }
    clearAll() { 
        // 清理当前账号的数据
        Object.values(this.keys).forEach(key => this.remove(key));
        // 清理所有账号的隔离数据
        const accountId = this._getAccountId();
        this.accountScopedKeys.forEach(key => {
            localStorage.removeItem(this.prefix + 'account_' + accountId + '_' + key);
        });
    }

    // ==================== Token ====================
    getToken() { return this.get(this.keys.TOKEN, ''); }
    setToken(token) { this.set(this.keys.TOKEN, token); }
    clearToken() { this.remove(this.keys.TOKEN); }

    // ==================== 多账号管理 ====================
    getAccounts() {
        return this.get(this.keys.ACCOUNTS, []);
    }
    addAccount(token, user) {
        const accounts = this.getAccounts();
        const accountId = (user && (user.login || user.id)) || token.substring(0, 8);
        const existing = accounts.find(a => a.id === accountId);
        if (existing) {
            existing.token = token;
            existing.user = user;
            existing.lastUsed = new Date().toISOString();
        } else {
            accounts.push({
                id: accountId,
                token: token,
                user: user,
                addedAt: new Date().toISOString(),
                lastUsed: new Date().toISOString()
            });
        }
        this.set(this.keys.ACCOUNTS, accounts);
        this.set(this.keys.CURRENT_ACCOUNT, accountId);
        return accountId;
    }
    removeAccount(accountId) {
        let accounts = this.getAccounts().filter(a => a.id !== accountId);
        this.set(this.keys.ACCOUNTS, accounts);
        if (this.getCurrentAccountId() === accountId) {
            this.set(this.keys.CURRENT_ACCOUNT, accounts[0] ? accounts[0].id : null);
        }
        return accounts;
    }
    getCurrentAccountId() {
        return this.get(this.keys.CURRENT_ACCOUNT, null);
    }
    setCurrentAccount(accountId) {
        this.set(this.keys.CURRENT_ACCOUNT, accountId);
        const account = this.getAccounts().find(a => a.id === accountId);
        if (account) {
            this.setToken(account.token);
            this.setUser(account.user);
            account.lastUsed = new Date().toISOString();
            const accounts = this.getAccounts();
            const idx = accounts.findIndex(a => a.id === accountId);
            if (idx >= 0) accounts[idx] = account;
            this.set(this.keys.ACCOUNTS, accounts);
        }
        return account;
    }
    
    // 清除当前账号的所有本地数据（VFS、收藏、最近使用、分享、仓库列表等）
    // 切换账号时调用，确保数据严格隔离
    clearCurrentAccountData() {
        const accountId = this._getAccountId();
        if (!accountId) return;
        
        console.log(`[Storage] 清除账号 ${accountId} 的所有本地数据`);
        this.accountScopedKeys.forEach(key => {
            const accountKey = this.prefix + 'account_' + accountId + '_' + key;
            localStorage.removeItem(accountKey);
        });
        
        // 同时清除全局的旧格式数据（如果有的话）
        this.accountScopedKeys.forEach(key => {
            const oldKey = this.prefix + key;
            localStorage.removeItem(oldKey);
        });
    }



    // ==================== 分享密码（已移除） ====================
    //
    // 原实现有问题，已整体砍掉：
    //   1. btoa() 是编码不是加密，逆向即可还原
    //   2. 密码只存 localStorage —— 换设备就没了，链接在别的设备上打不开
    //   3. 校验是纯前端的 —— 分享仓库本身是公开的，绕过校验即可拿到内容
    // 结论：这个"密码"只防误点，不防真想看的人。留着反而给用户虚假的安全感。
    //
    // 分享本身就是"公开仓库 + Pages"，要给就给链接，别给密码。
    //
    // ★ 下面这个方法用于清理老用户 localStorage 里的历史遗留数据，
    //   不要删 —— 否则旧数据会一直躺在用户浏览器里。
    purgeLegacySharePasswords() {
        if (this.get('share_passwords', null) !== null) {
            this.remove('share_passwords');
            return true;
        }
        return false;
    }

    // ==================== 文件标签系统 ====================
    getFileTags(path) {
        const tags = this.get('file_tags', {});
        return tags[path] || [];
    }
    
    setFileTags(path, tags) {
        const allTags = this.get('file_tags', {});
        if (tags.length === 0) {
            delete allTags[path];
        } else {
            allTags[path] = tags;
        }
        this.set('file_tags', allTags);
    }
    
    addFileTag(path, tag) {
        const tags = this.getFileTags(path);
        if (!tags.includes(tag)) {
            tags.push(tag);
            this.setFileTags(path, tags);
        }
    }
    
    removeFileTag(path, tag) {
        const tags = this.getFileTags(path).filter(t => t !== tag);
        this.setFileTags(path, tags);
    }
    
    getAllTags() {
        const allTags = this.get('file_tags', {});
        const tagSet = new Set();
        Object.values(allTags).forEach(tags => tags.forEach(t => tagSet.add(t)));
        return Array.from(tagSet).sort();
    }
    
    getFilesByTag(tag) {
        const allTags = this.get('file_tags', {});
        return Object.entries(allTags)
            .filter(([path, tags]) => tags.includes(tag))
            .map(([path]) => path);
    }

    // ==================== 用户信息 ====================
    getUser() { return this.get(this.keys.USER, null); }
    setUser(user) { this.set(this.keys.USER, user); }

    // ==================== 关联仓库 ====================
    getRepos() { return this.get(this.keys.REPOS, []); }
    setRepos(repos) { this.set(this.keys.REPOS, repos); }
    addRepo(repoInfo) {
        const repos = this.getRepos();
        const exists = repos.find(r => r.owner === repoInfo.owner && r.repo === repoInfo.repo);
        if (!exists) {
            repos.push({
                owner: repoInfo.owner, repo: repoInfo.repo, name: repoInfo.name || repoInfo.repo,
                description: repoInfo.description || '', branch: repoInfo.branch || 'main',
                isDefault: repos.length === 0, addedAt: new Date().toISOString()
            });
            this.set(this.keys.REPOS, repos);
        }
        return repos;
    }
    removeRepo(owner, repo) {
        let repos = this.getRepos().filter(r => !(r.owner === owner && r.repo === repo));
        if (repos.length > 0 && !repos.find(r => r.isDefault)) repos[0].isDefault = true;
        this.set(this.keys.REPOS, repos);
        const usage = this.getRepoUsage();
        delete usage[`${owner}/${repo}`];
        this.set(this.keys.REPO_USAGE, usage);
        return repos;
    }
    setDefaultRepo(owner, repo) {
        const repos = this.getRepos();
        repos.forEach(r => { r.isDefault = (r.owner === owner && r.repo === repo); });
        this.set(this.keys.REPOS, repos);
    }
    getDefaultRepo() {
        const repos = this.getRepos();
        const currentUser = this.getUser()?.login;
        // 只返回 owner 匹配的仓库
        const validRepos = currentUser ? repos.filter(r => r.owner === currentUser) : repos;
        return validRepos.find(r => r.isDefault) || validRepos[0] || null;
    }
    findRepo(owner, repo) { return this.getRepos().find(r => r.owner === owner && r.repo === repo); }

    // ==================== 虚拟文件系统 (VFS) ====================
    /**
     * 获取完整 VFS 结构
     * { files: { "/drive_home/xxx": {name, type, size, chunks, createdAt, updatedAt} }, 
     *   folders: { "/drive_home/xxx": {name, type, createdAt} } }
     */
    getVFS() {
        const vfs = this.get(this.keys.VFS, null);
        // 规范化：确保始终返回 { files: {}, folders: {} } 结构，
        // 避免旧版本同步进来的空对象/缺字段导致 Object.entries 崩溃
        if (!vfs || typeof vfs !== 'object') return { files: {}, folders: {} };
        if (!vfs.files || typeof vfs.files !== 'object') vfs.files = {};
        if (!vfs.folders || typeof vfs.folders !== 'object') vfs.folders = {};
        return vfs;
    }
    setVFS(vfs) { this.set(this.keys.VFS, vfs); }

    /**
     * 规范化虚拟路径，确保以 /drive_home/ 开头
     */
    static normalizePath(path) {
        if (!path.startsWith('/drive_home')) {
            path = '/drive_home/' + path.replace(/^\//, '');
        }
        return path.replace(/\/+$/, '') || '/drive_home';
    }

    /**
     * 获取路径的父目录路径
     */
    static getParentPath(path) {
        path = Storage.normalizePath(path);
        const idx = path.lastIndexOf('/');
        return idx <= '/drive_home'.length ? '/drive_home' : path.substring(0, idx);
    }

    /**
     * 获取路径的文件名
     */
    static getFileName(path) {
        path = Storage.normalizePath(path);
        return path.substring(path.lastIndexOf('/') + 1);
    }

    /**
     * 添加/更新文件到 VFS
     * @param {string} virtualPath - 虚拟路径，如 /drive_home/文档/report.pdf
     * @param {object} fileInfo - { name, size, chunks: [{owner, repo, path, size, sha}] }
     */
    putFile(virtualPath, fileInfo) {
        virtualPath = Storage.normalizePath(virtualPath);
        const vfs = this.getVFS();
        const now = new Date().toISOString();
        vfs.files[virtualPath] = {
            name: fileInfo.name || Storage.getFileName(virtualPath),
            type: 'file',
            size: fileInfo.size || 0,
            chunks: fileInfo.chunks || [],
            createdAt: vfs.files[virtualPath]?.createdAt || now,
            updatedAt: now
        };
        // 自动创建父文件夹
        this._ensureParentFolders(virtualPath, vfs);
        this.setVFS(vfs);
        return vfs.files[virtualPath];
    }

    /**
     * 添加文件夹到 VFS
     */
    putFolder(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const vfs = this.getVFS();
        const now = new Date().toISOString();
        vfs.folders[virtualPath] = {
            name: Storage.getFileName(virtualPath),
            type: 'folder',
            createdAt: vfs.folders[virtualPath]?.createdAt || now
        };
        this._ensureParentFolders(virtualPath, vfs);
        this.setVFS(vfs);
        return vfs.folders[virtualPath];
    }

    /**
     * 确保父文件夹存在（内部方法）
     */
    _ensureParentFolders(virtualPath, vfs) {
        let parent = Storage.getParentPath(virtualPath);
        while (parent && parent !== '/drive_home' && !vfs.folders[parent]) {
            vfs.folders[parent] = {
                name: Storage.getFileName(parent),
                type: 'folder',
                createdAt: new Date().toISOString()
            };
            parent = Storage.getParentPath(parent);
        }
    }

    /**
     * 获取文件信息
     */
    getFile(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        return this.getVFS().files[virtualPath] || null;
    }

    /**
     * 获取文件夹信息
     */
    getFolder(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        return this.getVFS().folders[virtualPath] || null;
    }

    /**
     * 判断路径是否存在（文件或文件夹）
     */
    exists(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const vfs = this.getVFS();
        return !!vfs.files[virtualPath] || !!vfs.folders[virtualPath] || virtualPath === '/drive_home';
    }

    /**
     * 列出指定目录下的内容
     * @returns {Array} 文件和文件夹列表
     */
    listDirectory(virtualPath = '/drive_home') {
        virtualPath = Storage.normalizePath(virtualPath);
        const vfs = this.getVFS();
        const prefix = virtualPath === '/drive_home' ? '/drive_home/' : virtualPath + '/';
        const items = [];

        // 直接子文件
        Object.entries(vfs.files).forEach(([path, info]) => {
            if (path.startsWith(prefix) && !path.substring(prefix.length).includes('/')) {
                items.push({ ...info, path, isFile: true });
            }
        });

        // 直接子文件夹
        Object.entries(vfs.folders).forEach(([path, info]) => {
            if (path.startsWith(prefix) && !path.substring(prefix.length).includes('/')) {
                items.push({ ...info, path, isFolder: true });
            }
        });

        // 排序：文件夹在前，按名称排序
        items.sort((a, b) => {
            if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return items;
    }

    /**
     * 删除文件（同时删除所有分片的容量记录）
     */
    deleteFile(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const vfs = this.getVFS();
        const file = vfs.files[virtualPath];
        if (file) {
            // 减少各仓库的容量使用
            file.chunks.forEach(chunk => {
                this.subtractFromRepoUsage(chunk.owner, chunk.repo, chunk.size);
            });
            delete vfs.files[virtualPath];
            this.setVFS(vfs);
        }
        return !!file;
    }

    /**
     * 删除文件夹（递归删除所有子文件和子文件夹）
     */
    deleteFolder(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        if (virtualPath === '/drive_home') return false;
        const vfs = this.getVFS();
        const prefix = virtualPath + '/';
        let deleted = false;

        // 删除所有子文件
        Object.keys(vfs.files).forEach(path => {
            if (path.startsWith(prefix) || path === virtualPath) {
                const file = vfs.files[path];
                if (file) {
                    file.chunks.forEach(chunk => {
                        this.subtractFromRepoUsage(chunk.owner, chunk.repo, chunk.size);
                    });
                }
                delete vfs.files[path];
                deleted = true;
            }
        });

        // 删除所有子文件夹
        Object.keys(vfs.folders).forEach(path => {
            if (path.startsWith(prefix) || path === virtualPath) {
                delete vfs.folders[path];
                deleted = true;
            }
        });

        if (deleted) this.setVFS(vfs);
        return deleted;
    }

    /**
     * 重命名/移动文件或文件夹
     */
    moveItem(oldPath, newPath) {
        oldPath = Storage.normalizePath(oldPath);
        newPath = Storage.normalizePath(newPath);
        const vfs = this.getVFS();

        if (vfs.files[oldPath]) {
            vfs.files[newPath] = { ...vfs.files[oldPath], name: Storage.getFileName(newPath), updatedAt: new Date().toISOString() };
            delete vfs.files[oldPath];
            this._ensureParentFolders(newPath, vfs);
        } else if (vfs.folders[oldPath]) {
            // 移动文件夹：需要更新所有子项的路径
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            const newFiles = {};
            const newFolders = {};
            Object.entries(vfs.files).forEach(([path, info]) => {
                if (path === oldPath) {
                    newFiles[newPath] = { ...info, name: Storage.getFileName(newPath) };
                } else if (path.startsWith(oldPrefix)) {
                    newFiles[newPrefix + path.substring(oldPrefix.length)] = info;
                } else {
                    newFiles[path] = info;
                }
            });
            Object.entries(vfs.folders).forEach(([path, info]) => {
                if (path === oldPath) {
                    newFolders[newPath] = { ...info, name: Storage.getFileName(newPath) };
                } else if (path.startsWith(oldPrefix)) {
                    newFolders[newPrefix + path.substring(oldPrefix.length)] = info;
                } else {
                    newFolders[path] = info;
                }
            });
            vfs.files = newFiles;
            vfs.folders = newFolders;
            this._ensureParentFolders(newPath, vfs);
        } else {
            return false;
        }

        this.setVFS(vfs);
        return true;
    }

    /**
     * 搜索文件
     */
    searchFiles(query, searchContent = false) {
        query = query.toLowerCase();
        const vfs = this.getVFS();
        const results = [];
        const textExts = ['.txt', '.md', '.json', '.js', '.py', '.html', '.css', '.csv', '.xml', '.yml', '.yaml', '.json', '.log'];
        
        Object.entries(vfs.files).forEach(([path, info]) => {
            let matched = false;
            let matchPreview = '';
            
            // 文件名匹配
            if (info.name.toLowerCase().includes(query)) {
                matched = true;
            }
            
            // 内容匹配（仅文本文件）
            if (searchContent && !matched) {
                const ext = '.' + (info.name.split('.').pop() || '').toLowerCase();
                if (textExts.includes(ext) && info.content) {
                    const content = typeof info.content === 'string' ? info.content : '';
                    const idx = content.toLowerCase().indexOf(query);
                    if (idx >= 0) {
                        matched = true;
                        const start = Math.max(0, idx - 20);
                        const end = Math.min(content.length, idx + query.length + 40);
                        matchPreview = '...' + content.substring(start, end) + '...';
                    }
                }
            }
            
            if (matched) {
                results.push({ ...info, path, isFile: true, matchPreview, contentMatch: !!matchPreview });
            }
        });
        return results;
    }

    // ==================== 收藏 ====================
    getFavorites() { return this.get(this.keys.FAVORITES, []); }
    toggleFavorite(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const favorites = this.getFavorites();
        const idx = favorites.indexOf(virtualPath);
        if (idx >= 0) favorites.splice(idx, 1); else favorites.push(virtualPath);
        this.set(this.keys.FAVORITES, favorites);
        return idx < 0;
    }
    isFavorite(virtualPath) { return this.getFavorites().includes(Storage.normalizePath(virtualPath)); }


    // 检查文件夹是否存在
    folderExists(path) {
        const vfs = this.getVFS();
        return !!vfs.folders[path];
    }

    // ==================== 最近使用 ====================
    getRecent() { return this.get(this.keys.RECENT, []); }
    addToRecent(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        let recent = this.getRecent();
        recent = recent.filter(p => p !== virtualPath);
        recent.unshift(virtualPath);
        recent = recent.slice(0, 50);
        this.set(this.keys.RECENT, recent);
    }

    // ==================== 分享记录 ====================
    getShares() { return this.get(this.keys.SHARES, []); }
    addShare(shareInfo) {
        const shares = this.getShares();
        shares.unshift({ id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5), ...shareInfo, createdAt: new Date().toISOString() });
        this.set(this.keys.SHARES, shares);
        return shares[0];
    }
    removeShare(id) {
        const shares = this.getShares().filter(s => s.id !== id);
        this.set(this.keys.SHARES, shares);
    }

    // ==================== 设置 ====================
    getSettings() {
        return this.get(this.keys.SETTINGS, {
            viewMode: 'grid', sortBy: 'name', sortOrder: 'asc', showHidden: false, confirmDelete: true
        });
    }
    updateSettings(updates) {
        const settings = this.getSettings();
        this.set(this.keys.SETTINGS, { ...settings, ...updates });
    }

    // ==================== 存储配置（智能分配+文件拆分） ====================
    /**
     * 获取存储配置
     * maxRepoSize: 单仓库最大容量（字节），默认 900MB
     * autoCreateRepo: 容量不足时是否自动创建新仓库
     * repoNamePrefix: 自动创建仓库的名称前缀
     * warnThreshold: 容量警告阈值（0-1），默认 0.8
     * chunkSize: 文件拆分大小（字节），默认 512KB
     * minChunkSize: 触发拆分的最小文件大小（字节），默认 512KB
     *               注：早期文档写的是 10MB，实际默认值一直是 512KB，
     *               即超过 512KB 的文件就会被分片（而非 10MB 才分）
     */
    getConfig() { return this.getStorageConfig(); }
    getStorageConfig() {
        const defaults = {
            maxRepoSize: 900 * 1024 * 1024,
            autoCreateRepo: true,
            repoNamePrefix: 'drive-storage',
            warnThreshold: 0.8,
            chunkSize: 512 * 1024,
            minChunkSize: 512 * 1024,
            configVersion: 2
        };
        const saved = this.get(this.keys.STORAGE_CONFIG, null);
        if (!saved) return defaults;
        
        // 配置迁移：旧版本 chunkSize 是 50MB 或 20MB，自动更新为 5MB
        let needUpdate = false;
        if (saved.chunkSize === 50 * 1024 * 1024 || saved.chunkSize === 20 * 1024 * 1024 || saved.chunkSize === 5 * 1024 * 1024) {
            saved.chunkSize = 512 * 1024;
            needUpdate = true;
        }
        // 确保所有字段都存在
        for (const key of Object.keys(defaults)) {
            if (saved[key] === undefined) {
                saved[key] = defaults[key];
                needUpdate = true;
            }
        }
        if (needUpdate) {
            this.set(this.keys.STORAGE_CONFIG, saved);
        }
        return saved;
    }
    updateStorageConfig(updates) {
        const config = this.getStorageConfig();
        this.set(this.keys.STORAGE_CONFIG, { ...config, ...updates });
    }

    // ==================== 仓库容量使用量追踪 ====================
    getRepoUsage() { return this.get(this.keys.REPO_USAGE, {}); }
    setRepoUsage(owner, repo, sizeBytes) {
        const usage = this.getRepoUsage();
        usage[`${owner}/${repo}`] = { size: sizeBytes, updatedAt: new Date().toISOString() };
        this.set(this.keys.REPO_USAGE, usage);
    }
    addToRepoUsage(owner, repo, sizeBytes) {
        const usage = this.getRepoUsage();
        const key = `${owner}/${repo}`;
        if (!usage[key]) usage[key] = { size: 0, updatedAt: new Date().toISOString() };
        usage[key].size += sizeBytes;
        usage[key].updatedAt = new Date().toISOString();
        this.set(this.keys.REPO_USAGE, usage);
    }
    subtractFromRepoUsage(owner, repo, sizeBytes) {
        const usage = this.getRepoUsage();
        const key = `${owner}/${repo}`;
        if (usage[key]) {
            usage[key].size = Math.max(0, usage[key].size - sizeBytes);
            usage[key].updatedAt = new Date().toISOString();
            this.set(this.keys.REPO_USAGE, usage);
        }
    }
    getRepoUsageSize(owner, repo) {
        const usage = this.getRepoUsage();
        return usage[`${owner}/${repo}`]?.size || 0;
    }
    getRepoRemaining(owner, repo) {
        const config = this.getStorageConfig();
        const used = this.getRepoUsageSize(owner, repo);
        return Math.max(0, config.maxRepoSize - used);
    }
    canRepoFit(owner, repo, fileSize) {
        return this.getRepoRemaining(owner, repo) >= fileSize;
    }
    getRepoUsagePercent(owner, repo) {
        const config = this.getStorageConfig();
        const used = this.getRepoUsageSize(owner, repo);
        return Math.min(1, used / config.maxRepoSize);
    }

    // ==================== 数据导入导出（配置同步用） ====================
    exportData() {
        const data = {};
        Object.values(this.keys).forEach(key => {
            if (key !== this.keys.TOKEN && key !== this.keys.USER && key !== this.keys.ACCOUNTS && key !== this.keys.CURRENT_ACCOUNT) {
                data[key] = this.get(key);
            }
        });
        return data;
    }
    importData(data) {
        Object.entries(data).forEach(([key, value]) => {
            if (value !== null && value !== undefined && key !== this.keys.TOKEN && key !== this.keys.USER) {
                this.set(key, value);
            }
        });
    }

    // ==================== 工具方法 ====================
    static formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}
