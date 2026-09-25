/**
 * 配置同步模块
 * 将本地配置同步到 GitHub 私有配置仓库，实现跨设备/跨会话恢复
 */
class ConfigSync {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
        this.configRepo = 'github-drive-config';
        this.configFile = 'config.json';
        this.syncTimer = null;
        this.isSyncing = false;
        this.lastSyncHash = '';
    }

    /**
     * 初始化：确保配置仓库存在，并从远程恢复配置
     */
    async init() {
        try {
            const username = await this.api.getUsername();
            this.owner = username;

            // 检查配置仓库是否存在
            const repoExists = await this.ensureConfigRepo();
            if (!repoExists) {
                console.log('[ConfigSync] 配置仓库已创建，初始化空配置');
                await this.pushConfig();
                return;
            }

            // 从远程读取配置
            const remoteConfig = await this.pullConfig();
            if (remoteConfig) {
                // 兼容旧版本脏数据：远程没有文件索引但本地有文件时，推送本地覆盖远程，
                // 避免用空索引清空本地文件列表
                const localVFS = this.storage.getVFS();
                const remoteHasFiles = remoteConfig.fileIndex && Object.keys(remoteConfig.fileIndex.files || {}).length > 0;
                const localHasFiles = Object.keys(localVFS.files || {}).length > 0;
                if (!remoteHasFiles && localHasFiles) {
                    console.log('[ConfigSync] 远程配置无文件索引，推送本地配置覆盖');
                    await this.pushConfig();
                } else {
                    console.log('[ConfigSync] 从远程恢复配置成功');
                    this.restoreConfig(remoteConfig);
                }
            } else {
                console.log('[ConfigSync] 远程配置为空，推送本地配置');
                await this.pushConfig();
            }
        } catch (e) {
            console.warn('[ConfigSync] 初始化失败:', e.message);
        }
    }

    /**
     * 确保配置仓库存在，不存在则创建
     */
    async ensureConfigRepo() {
        try {
            await this.api.getRepository(this.owner, this.configRepo);
            return true;
        } catch (e) {
            // 仓库不存在，创建
            try {
                await this.api.createRepository(this.configRepo, {
                    description: 'GitHub Drive 配置仓库（自动生成，请勿手动修改）',
                    private: true,
                    autoInit: true
                });
                // 等待仓库初始化
                await this.sleep(2000);
                return true;
            } catch (createErr) {
                console.error('[ConfigSync] 创建配置仓库失败:', createErr.message);
                return false;
            }
        }
    }

    /**
     * 从远程拉取配置
     */
    async pullConfig() {
        try {
            const content = await this.api.getFileContents(
                this.owner,
                this.configRepo,
                this.configFile,
                'main'
            );
            if (content && content.content) {
                // atob 得到 latin1 字符串（每个 UTF-8 字节映射为一个字符），
                // 用 TextDecoder 按 UTF-8 正确解码，避免中文文件名乱码
                // （比 decodeURIComponent(escape()) 更健壮，不会因 % 字符抛 URIError）
                const binary = atob(content.content);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const decoded = new TextDecoder('utf-8').decode(bytes);
                return JSON.parse(decoded);
            }
            return null;
        } catch (e) {
            // 文件不存在
            return null;
        }
    }

    /**
     * 推送本地配置到远程
     */
    async pushConfig() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            const config = this.exportConfig();
            const configStr = JSON.stringify(config, null, 2);
            const hash = this.hashCode(configStr);

            // 如果和上次同步的内容一样，跳过
            if (hash === this.lastSyncHash) {
                this.isSyncing = false;
                return;
            }

            // 使用 Contents API 更新文件（GitHub 自动管理 commit，避免手动管理分支引用导致的缓存问题）
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    // 1. 获取文件最新 SHA（加时间戳绕过缓存）
                    let sha = null;
                    try {
                        const existing = await this.api.getFileContents(
                            this.owner, this.configRepo, this.configFile, 'main'
                        );
                        if (existing && existing.sha) sha = existing.sha;
                    } catch (e) {
                        // 文件不存在，将创建新文件
                        console.log('[ConfigSync] 配置文件不存在，将创建新文件');
                    }
                    console.log(`[ConfigSync] 步骤1: 获取 SHA=${sha ? sha.substring(0,12) : '新文件'}, attempt=${attempt+1}/3`);

                    // 2. 创建或更新文件
                    await this.api.createOrUpdateFile(
                        this.owner, this.configRepo, this.configFile,
                        configStr, '更新配置', 'main', sha
                    );

                    this.lastSyncHash = hash;
                    console.log('[ConfigSync] 配置已同步到远程');
                    break; // 成功
                } catch (e) {
                    console.error(`[ConfigSync] 同步失败 (attempt ${attempt + 1}/3):`, e.status, e.message);
                    if (e.status === 409 || e.message?.includes('Conflict') || e.message?.includes('does not match')) {
                        console.warn(`[ConfigSync] SHA冲突，重新获取 SHA 重试...`);
                        await this.sleep(1000);
                        continue;
                    }
                    throw e;
                }
            }
        } catch (e) {
            console.warn('[ConfigSync] 推送配置失败:', e.message);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * 防抖同步：配置变更后 2 秒自动同步
     */
    scheduleSync() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }
        this.syncTimer = setTimeout(() => {
            this.pushConfig();
        }, 5000);
    }

    /**
     * 导出本地所有配置
     */
    exportConfig() {
        return {
            version: 1,
            updatedAt: new Date().toISOString(),
            repos: this.storage.getRepos(),
            fileIndex: this.storage.getVFS(),
            starred: this.storage.getFavorites(),
            recent: this.storage.get('recent', []),
            shares: this.storage.getShares(),
            repoUsage: this.storage.get('repo_usage', {}),
            storageConfig: this.storage.getStorageConfig()
        };
    }

    /**
     * 从远程配置恢复到本地
     */
    restoreConfig(config) {
        if (config.repos) this.storage.set(this.storage.keys.REPOS, config.repos);
        if (config.fileIndex) this.storage.setVFS(config.fileIndex);
        if (config.starred) this.storage.set(this.storage.keys.FAVORITES, config.starred);
        if (config.recent) this.storage.set(this.storage.keys.RECENT, config.recent);
        if (config.shares) this.storage.set(this.storage.keys.SHARES, config.shares);
        if (config.repoUsage) this.storage.set(this.storage.keys.REPO_USAGE, config.repoUsage);
        if (config.storageConfig) this.storage.set(this.storage.keys.STORAGE_CONFIG, config.storageConfig);

        // 更新最后同步的 hash
        this.lastSyncHash = this.hashCode(JSON.stringify(config, null, 2));
    }

    /**
     * 简单的字符串 hash（用于比较配置是否变化）
     */
    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString();
    }

    /**
     * 休眠
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
