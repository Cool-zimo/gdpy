/**
 * GitHub API 封装模块
 * 处理所有与 GitHub REST API 的交互
 */
class GitHubAPI {
    constructor(token) {
        this.token = token;
        this.baseUrl = 'https://api.github.com';
        this.username = null;
        // 限流信息
        this.rateLimit = { remaining: null, limit: null, reset: null, lastWarned: 0 };
        this.onRateLimitWarning = null; // 回调函数
    }

    /**
     * 通用请求方法
     */
    async request(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `token ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...options.headers
        };

        console.debug(`[GitHubAPI] Requesting: ${url}, Headers: `, headers); // Debug log for request

        if (options.body && !options.rawBody) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }

        // 对 GET 请求禁用浏览器 HTTP 缓存（cache 是 Fetch API 选项，非请求头，不会触发 CORS 预检），
        // 确保每次获取到最新的 SHA / 文件内容，避免 Contents API 因过期 SHA 返回 409 冲突
        const fetchOptions = { ...options, headers };
        if (!fetchOptions.method || fetchOptions.method === 'GET') {
            fetchOptions.cache = 'no-store';
        }
        const response = await fetch(url, fetchOptions);

        // 读取限流信息（区分核心API和搜索API，搜索API限流独立，不警告）
        const remaining = response.headers.get('X-RateLimit-Remaining');
        const limit = response.headers.get('X-RateLimit-Limit');
        const reset = response.headers.get('X-RateLimit-Reset');
        const resource = response.headers.get('X-RateLimit-Resource') || 'core';
        if (remaining !== null) {
            const remainingInt = parseInt(remaining);
            const limitInt = limit ? parseInt(limit) : 5000;
            const resetInt = reset ? parseInt(reset) : null;
            
            // 只对核心 API（core）记录限流信息，搜索 API 有独立的限流，不混入
            if (resource === 'core') {
                this.rateLimit.remaining = remainingInt;
                this.rateLimit.limit = limitInt;
                this.rateLimit.reset = resetInt;
                
                // 限流警告：按比例计算，剩余 < 10% 警告，< 2% 严重警告
                const now = Date.now();
                const warnThreshold = Math.floor(limitInt * 0.1);  // 10%
                const criticalThreshold = Math.floor(limitInt * 0.02);  // 2%
                
                if (remainingInt < criticalThreshold && now - this.rateLimit.lastWarned > 60000) {
                    this.rateLimit.lastWarned = now;
                    if (this.onRateLimitWarning) this.onRateLimitWarning('critical', this.rateLimit);
                } else if (remainingInt < warnThreshold && now - this.rateLimit.lastWarned > 120000) {
                    this.rateLimit.lastWarned = now;
                    if (this.onRateLimitWarning) this.onRateLimitWarning('warning', this.rateLimit);
                }
            }
        }

        if (!response.ok) {
            let errorData;
            try {
                errorData = await response.json();
            } catch {
                errorData = { message: response.statusText };
            }
            // 401 时打印 token 前几位，方便调试
            if (response.status === 401) {
                console.warn('[GitHubAPI] 401 错误，当前 token 前10位:', this.token ? this.token.substring(0, 10) + '...' : '空');
            }
            console.error(`[GitHubAPI] Request failed: ${response.status} -`, errorData);

            // 提取 errors[] 里的具体原因。
            // GitHub 的 422 顶层 message 通常是 "Validation Failed" /
            // "Repository creation failed." 这类毫无信息量的通用文案，
            // 真正的原因在 errors[i].message 里 —— 比如
            // "name already exists on this account"。
            // 不拼接的话，用户只能看到一句没用的话，根本没法自查。
            const details = Array.isArray(errorData.errors)
                ? errorData.errors
                    .map(e => {
                        if (!e) return '';
                        const field = e.field ? `${e.field}: ` : '';
                        return field + (e.message || e.code || '');
                    })
                    .filter(Boolean)
                : [];

            // 检测限流错误
            const isRateLimit = response.status === 403 &&
                (errorData.message && (errorData.message.includes('rate limit') || errorData.message.includes('API rate limit')));
            let errorMsg;
            if (isRateLimit) {
                errorMsg = `GitHub API 限流！剩余请求数：${this.rateLimit.remaining || 0}，重置时间：${this.rateLimit.reset ? new Date(this.rateLimit.reset * 1000).toLocaleTimeString() : '未知'}`;
            } else if (details.length) {
                // 顶层文案 + 具体原因，都保留
                errorMsg = `${errorData.message || '请求失败'} — ${details.join('；')}`;
            } else {
                errorMsg = errorData.message || `HTTP ${response.status}`;
            }

            const error = new Error(errorMsg);
            error.status = response.status;
            error.data = errorData;
            error.errors = details;          // 结构化详情，便于上层分流处理
            error.isRateLimit = isRateLimit;
            throw error;
        }

        if (response.status === 204) return null;

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        }
        return await response.text();
    }

    /**
     * 获取当前用户信息
     */
    async getMe() {
        const user = await this.request('/user');
        this.username = user.login;
        return user;
    }

    /**
     * 获取用户名（缓存）
     */
    async getUsername() {
        if (this.username) return this.username;
        const user = await this.getMe();
        return user.login;
    }

    /**
     * 搜索仓库（GitHub Search API）
     */
    async searchRepositories(query, page = 1, perPage = 30) {
        const encodedQuery = encodeURIComponent(query);
        return await this.request(`/search/repositories?q=${encodedQuery}&sort=updated&order=desc&page=${page}&per_page=${perPage}`);
    }

    // ==================== 仓库管理 ====================

    /**
     * 获取用户的仓库列表
     */
    async listRepositories(perPage = 100, page = 1) {
        return await this.request(`/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    }

    /**
     * 获取单个仓库信息
     */
    async getRepository(owner, repo) {
        return await this.request(`/repos/${owner}/${repo}`);
    }

    /**
     * 创建新仓库
     */
    async createRepository(name, options = {}) {
        // 注意：这里不能偷懒用 `...options` 展开。
        // options 用的是驼峰（autoInit），GitHub API 要下划线（auto_init），
        // 展开会往请求体里塞一个 API 不认识的 autoInit 字段；
        // 而且展开放最后还会把上面的默认值覆盖掉。
        return await this.request('/user/repos', {
            method: 'POST',
            body: {
                name,
                description: options.description || '',
                private: options.private !== false,
                auto_init: options.autoInit !== false
            }
        });
    }

    /**
     * 删除仓库（需要确认）
     */
    async deleteRepository(owner, repo) {
        return await this.request(`/repos/${owner}/${repo}`, {
            method: 'DELETE'
        });
    }

    /**
     * 更新仓库信息
     */
    async updateRepository(owner, repo, updates) {
        return await this.request(`/repos/${owner}/${repo}`, {
            method: 'PATCH',
            body: updates
        });
    }

    // ==================== 文件操作（Contents API） ====================

    /**
     * 获取目录内容列表
     */
    async getDirectoryContents(owner, repo, path = '', ref = 'main') {
        const encodedPath = path ? encodeURIComponent(path).replace(/%2F/g, '/') : '';
        const url = `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`;
        try {
            return await this.request(url);
        } catch (e) {
            if (e.status === 404) return [];
            throw e;
        }
    }

    /**
     * 获取单个文件内容
     */
    async getFileContents(owner, repo, path, ref = 'main') {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        return await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`);
    }

    /**
     * 获取文件原始内容（文本）
     */
    async getFileRaw(owner, repo, path, ref = 'main') {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        try {
            const data = await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`);
            if (data.encoding === 'base64') {
                // atob 得到 latin1 字符串；转为 Uint8Array 保留原始字节
                const binary = atob(data.content);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes;
            }
            // Contents API 不返回 content（大文件），回退到 Git Data API
            return await this.getFileRawViaGit(owner, repo, path, ref);
        } catch (e) {
            // Contents API 报错（如大文件超过 1MB 限制），回退到 Git Data API
            return await this.getFileRawViaGit(owner, repo, path, ref);
        }
    }

    /**
     * 通过 Git Data API 获取文件原始内容（支持大文件，最大 100MB）
     */
    async getFileRawViaGit(owner, repo, path, ref = 'main') {
        const refData = await this.getRef(owner, repo, `heads/${ref}`);
        const commit = await this.getCommit(owner, repo, refData.object.sha);
        const tree = await this.getTree(owner, repo, commit.tree.sha, true);
        const treeItem = tree.tree.find(item => item.path === path);
        if (!treeItem) throw new Error('文件不存在: ' + path);
        const blob = await this.getBlob(owner, repo, treeItem.sha);
        const binary = atob(blob.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /**
     * 创建或更新文件（Contents API，单文件最大 1MB）
     */
    async createOrUpdateFile(owner, repo, path, content, message, branch = 'main', sha = null) {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        const body = {
            message,
            content: btoa(unescape(encodeURIComponent(content))),
            branch
        };
        if (sha) body.sha = sha;

        return await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
            method: 'PUT',
            body
        });
    }

    /**
     * 二进制文件上传（content 为 base64 字符串，避免 text() 损坏二进制）
     */
    async createOrUpdateFileBinary(owner, repo, path, base64Content, message, branch = 'main', sha = null) {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        const body = { message, content: base64Content, branch };
        if (sha) body.sha = sha;
        return await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
            method: 'PUT', body
        });
    }

    /**
     * 删除文件
     */
    async deleteFile(owner, repo, path, message, branch = 'main', sha) {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        return await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
            method: 'DELETE',
            body: { message, sha, branch }
        });
    }

    // ==================== Git Data API（大文件/批量操作） ====================

    /**
     * 获取分支引用
     */
    async getRef(owner, repo, ref = 'heads/main') {
        return await this.request(`/repos/${owner}/${repo}/git/ref/${ref}`);
    }

    /**
     * 获取 commit
     */
    async getCommit(owner, repo, sha) {
        return await this.request(`/repos/${owner}/${repo}/git/commits/${sha}`);
    }

    /**
     * 获取 tree
     */
    async getTree(owner, repo, sha, recursive = false) {
        const url = `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
        return await this.request(url);
    }

    /**
     * 创建 blob（用于大文件，最大 100MB）
     */
    async createBlob(owner, repo, content, encoding = 'base64') {
        return await this.request(`/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST',
            body: { content, encoding }
        });
    }

    /**
     * 获取 Blob 内容（Git Data API，支持大文件，最大 100MB）
     */
    async getBlob(owner, repo, sha) {
        return await this.request(`/repos/${owner}/${repo}/git/blobs/${sha}`);
    }

    /**
     * 从 ArrayBuffer 创建 blob（大文件）
     */
    async createBlobFromArrayBuffer(owner, repo, arrayBuffer) {
        // 将 ArrayBuffer 转为 base64
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        return await this.createBlob(owner, repo, base64, 'base64');
    }

    /**
     * 创建 tree
     */
    async createTree(owner, repo, tree, baseTree = null) {
        const body = { tree };
        if (baseTree) body.base_tree = baseTree;
        return await this.request(`/repos/${owner}/${repo}/git/trees`, {
            method: 'POST',
            body
        });
    }

    /**
     * 创建 commit
     */
    async createCommit(owner, repo, message, tree, parents = []) {
        return await this.request(`/repos/${owner}/${repo}/git/commits`, {
            method: 'POST',
            body: { message, tree, parents }
        });
    }

    /**
     * 更新引用（移动分支指针）
     */
    async updateRef(owner, repo, ref, sha, force = false) {
        return await this.request(`/repos/${owner}/${repo}/git/refs/${ref}`, {
            method: 'PATCH',
            body: { sha, force }
        });
    }

    /**
     * 上传大文件（使用 Git Data API，支持最大 100MB）
     */
    async uploadLargeFile(owner, repo, path, arrayBuffer, message, branch = 'main') {
        // 1. 获取当前分支的最新 commit
        const ref = await this.getRef(owner, repo, `heads/${branch}`);
        const latestCommitSha = ref.object.sha;
        const latestCommit = await this.getCommit(owner, repo, latestCommitSha);
        const baseTreeSha = latestCommit.tree.sha;

        // 2. 创建 blob
        const blob = await this.createBlobFromArrayBuffer(owner, repo, arrayBuffer);

        // 3. 创建新 tree（包含新文件）
        const tree = await this.createTree(owner, repo, [{
            path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha
        }], baseTreeSha);

        // 4. 创建新 commit
        const commit = await this.createCommit(owner, repo, message, tree.sha, [latestCommitSha]);

        // 5. 更新分支引用
        await this.updateRef(owner, repo, `heads/${branch}`, commit.sha);

        return commit;
    }

    /**
     * 批量上传文件（使用 Git Data API，一次 commit）
     */
    async batchUploadFiles(owner, repo, files, message, branch = 'main', onProgress = null) {
        // files: [{ path, content (string) | arrayBuffer, isBinary }]
        const ref = await this.getRef(owner, repo, `heads/${branch}`);
        const latestCommitSha = ref.object.sha;
        const latestCommit = await this.getCommit(owner, repo, latestCommitSha);
        const baseTreeSha = latestCommit.tree.sha;

        const treeItems = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            let blob;
            if (file.arrayBuffer) {
                blob = await this.createBlobFromArrayBuffer(owner, repo, file.arrayBuffer);
            } else {
                const base64 = btoa(unescape(encodeURIComponent(file.content)));
                blob = await this.createBlob(owner, repo, base64, 'base64');
            }
            treeItems.push({
                path: file.path,
                mode: '100644',
                type: 'blob',
                sha: blob.sha
            });
            if (onProgress) onProgress(i + 1, files.length);
        }

        const tree = await this.createTree(owner, repo, treeItems, baseTreeSha);
        const commit = await this.createCommit(owner, repo, message, tree.sha, [latestCommitSha]);
        await this.updateRef(owner, repo, `heads/${branch}`, commit.sha);

        return commit;
    }

    // ==================== 分支管理 ====================

    /**
     * 列出分支
     */
    async listBranches(owner, repo, perPage = 100) {
        return await this.request(`/repos/${owner}/${repo}/branches?per_page=${perPage}`);
    }

    /**
     * 创建分支
     */
    async createBranch(owner, repo, branchName, fromBranch = 'main') {
        const ref = await this.getRef(owner, repo, `heads/${fromBranch}`);
        return await this.request(`/repos/${owner}/${repo}/git/refs`, {
            method: 'POST',
            body: {
                ref: `refs/heads/${branchName}`,
                sha: ref.object.sha
            }
        });
    }

    // ==================== GitHub Pages ====================

    /**
     * 获取 Pages 配置
     */
    async getPages(owner, repo) {
        try {
            return await this.request(`/repos/${owner}/${repo}/pages`);
        } catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    /**
     * 启用 GitHub Pages
     */
    async enablePages(owner, repo, branch = 'main', path = '/') {
        return await this.request(`/repos/${owner}/${repo}/pages`, {
            method: 'POST',
            body: {
                source: {
                    branch,
                    path
                }
            }
        });
    }

    /**
     * 请求 Pages 构建
     */
    async requestPageBuild(owner, repo) {
        return await this.request(`/repos/${owner}/${repo}/pages/builds`, {
            method: 'POST'
        });
    }

    // ==================== 搜索 ====================

    /**
     * 搜索代码
     */
    async searchCode(query, perPage = 30) {
        return await this.request(`/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`);
    }

    /**
     * 搜索仓库
     */
    async searchRepositories(query, perPage = 30) {
        return await this.request(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=updated`);
    }

    // ==================== 工具方法 ====================

    /**
     * 检查 token 有效性
     */
    async validateToken() {
        try {
            await this.getMe();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取文件下载 URL（原始内容）
     */
    getRawUrl(owner, repo, path, branch = 'main') {
        const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodedPath}`;
    }

    /**
     * 获取仓库主页 URL
     */
    getRepoUrl(owner, repo) {
        return `https://github.com/${owner}/${repo}`;
    }

    /**
     * 获取 Pages URL
     */
    getPagesUrl(owner, repo) {
        return `https://${owner}.github.io/${repo}/`;
    }

    // 获取文件的提交历史
    async getFileHistory(owner, repo, path, branch = 'main') {
        try {
            const res = await this.request('/repos/' + owner + '/' + repo + '/commits?path=' + encodeURIComponent(path) + '&sha=' + branch + '&per_page=10');
            return res.map(commit => ({
                sha: commit.sha.substring(0, 7),
                fullSha: commit.sha,
                message: commit.commit.message,
                date: commit.commit.author.date,
                author: commit.commit.author.name
            }));
        } catch (e) { return []; }
    }
    
    // 获取特定版本的文件内容
    async getFileAtVersion(owner, repo, path, sha) {
        try {
            const res = await this.request('/repos/' + owner + '/' + repo + '/contents/' + encodeURIComponent(path) + '?ref=' + sha);
            if (res.content) return atob(res.content.replace(/\s/g, ''));
            return null;
        } catch (e) { return null; }
    }
}
