/**
 * 仓鼠联动模块（CangshuLink）
 *
 * 让 GitHub Drive 能读写「仓鼠」的管理配置，实现两个应用的数据互通。
 *
 * 关键设计：配置的真实来源是 GitHub 仓库，不是 localStorage
 *   仓鼠把管理清单存在私有仓库 cangshu-config/cangshu.json。
 *   所以这里直接用 Drive 自己的令牌走 GitHub API 读写即可 ——
 *   既拿到了跨设备一致的数据，又不必依赖 localStorage 共享
 *   （localStorage 只在同源同浏览器下有效，换个浏览器就没了）。
 *
 * 写操作必须先取 sha：GitHub Contents API 更新文件时要求带 sha，
 * 否则报 409。多端并发时取到旧 sha 也会 409，这里做了重试。
 */
class CangshuLink {
    /**
     * @param {Object} api GitHubAPI 实例（复用 Drive 已登录的实例）
     * @param {string} owner GitHub 用户名
     */
    constructor(api, owner) {
        this.api = api;
        this.owner = owner;
        this.configRepo = 'cangshu-config';
        this.configPath = 'cangshu.json';
    }

    /** 空配置模板（与仓鼠 config.js 的 blankConfig 保持一致） */
    static blankConfig() {
        return {
            version: 1,
            updatedAt: new Date().toISOString(),
            managed: [],
            settings: {
                configRepo: 'cangshu-config',
                theme: 'auto'
            }
        };
    }

    /** 仓库全名 */
    get repoPath() { return `${this.owner}/${this.configRepo}`; }

    /**
     * 读取配置
     * @returns {Promise<{ok, data?, exists?:boolean, error?}>}
     */
    async getConfig() {
        try {
            const r = await this.api.request(
                `/repos/${this.owner}/${this.configRepo}/contents/${this.configPath}`
            );
            if (!r.ok) {
                // 404 = 还没装过仓鼠，不是错误，返回空配置
                if (/404|Not Found/i.test(String(r.message || r.status || ''))) {
                    return { ok: true, exists: false, data: CangshuLink.blankConfig() };
                }
                return { ok: false, error: r.message || '读取配置失败' };
            }
            const raw = r.data.content || '';
            let text;
            try {
                // base64 解码要处理 UTF-8：中文备注名不能乱码
                const bin = atob(raw.replace(/\s/g, ''));
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                text = new TextDecoder('utf-8').decode(bytes);
            } catch (e) {
                return { ok: false, error: '配置解码失败: ' + e.message };
            }
            let data;
            try { data = JSON.parse(text); }
            catch (e) { return { ok: false, error: '配置不是合法 JSON: ' + e.message }; }

            return { ok: true, exists: true, data, sha: r.data.sha };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    /**
     * 写回配置
     * @param {Object} data 完整配置对象
     * @param {string} [sha] 已知 sha，省略则自动获取（多一次请求但更安全）
     */
    async saveConfig(data, sha) {
        try {
            data.updatedAt = new Date().toISOString();
            data.version = data.version || 1;

            let fileSha = sha;
            if (!fileSha) {
                const cur = await this.getConfig();
                // 只有文件已存在才需要 sha；不存在时创建
                if (cur.ok && cur.exists) fileSha = cur.sha;
            }

            const body = {
                message: 'chore: 更新管理列表（来自 GitHub Drive）',
                content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))))
            };
            if (fileSha) body.sha = fileSha;

            let r = await this.api.request(
                `/repos/${this.owner}/${this.configRepo}/contents/${this.configPath}`,
                { method: 'PUT', body }
            );

            // sha 过期（并发写入）→ 重取一次再试
            if (!r.ok && /409|sha/i.test(String(r.message || r.status || ''))) {
                const cur = await this.getConfig();
                if (cur.ok && cur.exists) {
                    body.sha = cur.sha;
                    r = await this.api.request(
                        `/repos/${this.owner}/${this.configRepo}/contents/${this.configPath}`,
                        { method: 'PUT', body }
                    );
                }
            }
            if (!r.ok) return { ok: false, error: r.message || '保存失败' };
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    /** 配置仓库是否存在（用来判断用户装没装仓鼠） */
    async isInstalled() {
        try {
            const r = await this.api.request(`/repos/${this.owner}/${this.configRepo}`);
            return { ok: true, installed: !!r.ok };
        } catch (e) {
            return { ok: true, installed: false };
        }
    }

    /**
     * 列出被管理的仓库
     * @param {boolean} withDetail 是否附带仓库详情（Pages、体积等，需额外请求）
     */
    async listRepos(withDetail = false) {
        const r = await this.getConfig();
        if (!r.ok) return r;
        const managed = (r.data && r.data.managed) || [];
        if (!withDetail) return { ok: true, repos: managed };

        // 并发拉取详情，单个失败不影响其它（比如仓库被删了）
        const detailed = await Promise.all(managed.map(async (m) => {
            try {
                const d = await this.api.request(`/repos/${m.owner}/${m.repo}`);
                if (!d.ok) return { ...m, missing: true };
                const repo = d.data;
                let pages = null;
                try {
                    const p = await this.api.request(`/repos/${m.owner}/${m.repo}/pages`);
                    if (p.ok) pages = { enabled: true, url: p.data.html_url, status: p.data.status };
                } catch (e) { /* Pages 未启用 */ }
                return {
                    ...m,
                    html_url: repo.html_url,
                    description: repo.description || '',
                    private: !!repo.private,
                    language: repo.language || '',
                    stars: repo.stargazers_count || 0,
                    size: repo.size || 0,
                    default_branch: repo.default_branch || 'main',
                    updated_at: repo.updated_at,
                    pages
                };
            } catch (e) {
                return { ...m, missing: true };
            }
        }));
        return { ok: true, repos: detailed };
    }

    /** 是否已管理某仓库 */
    async hasRepo(owner, repo) {
        const r = await this.getConfig();
        if (!r.ok) return { ok: false, error: r.error };
        const list = (r.data && r.data.managed) || [];
        return { ok: true, has: list.some(m => m.owner === owner && m.repo === repo) };
    }

    /** 添加仓库到管理列表 */
    async addRepo(owner, repo, meta = {}) {
        const r = await this.getConfig();
        if (!r.ok) return r;
        const data = r.data || CangshuLink.blankConfig();
        data.managed = data.managed || [];
        if (data.managed.some(m => m.owner === owner && m.repo === repo)) {
            return { ok: false, error: '该仓库已在管理列表中', duplicated: true };
        }
        data.managed.push({
            owner, repo,
            alias: meta.alias || '',
            note: meta.note || '',
            addedAt: new Date().toISOString()
        });
        const s = await this.saveConfig(data, r.sha);
        if (!s.ok) return s;
        return { ok: true, count: data.managed.length };
    }

    /** 从管理列表移除（只改配置，不删仓库） */
    async removeRepo(owner, repo) {
        const r = await this.getConfig();
        if (!r.ok) return r;
        const data = r.data || CangshuLink.blankConfig();
        const before = (data.managed || []).length;
        data.managed = (data.managed || []).filter(m => !(m.owner === owner && m.repo === repo));
        if (data.managed.length === before) return { ok: false, error: '该仓库不在管理列表中' };
        const s = await this.saveConfig(data, r.sha);
        if (!s.ok) return s;
        return { ok: true, count: data.managed.length };
    }

    /** 重命名（改 alias 备注名，仓库真名不变） */
    async setAlias(owner, repo, alias) {
        const r = await this.getConfig();
        if (!r.ok) return r;
        const data = r.data || CangshuLink.blankConfig();
        const item = (data.managed || []).find(m => m.owner === owner && m.repo === repo);
        if (!item) return { ok: false, error: '该仓库不在管理列表中' };
        item.alias = alias || '';
        const s = await this.saveConfig(data, r.sha);
        if (!s.ok) return s;
        return { ok: true };
    }

    /** 创建配置仓库（用户没装过仓鼠时，帮他把仓库建出来） */
    async ensureConfigRepo() {
        const chk = await this.isInstalled();
        if (chk.installed) return { ok: true, created: false };

        try {
            const r = await this.api.createRepository(this.configRepo, {
                description: '仓鼠（Cangshu）配置仓库 · GitHub 仓库管理面板',
                private: true,
                autoInit: true
            });
            if (!r.ok) return { ok: false, error: r.message || '创建配置仓库失败' };

            // 写入初始配置
            const init = CangshuLink.blankConfig();
            const w = await this.api.request(
                `/repos/${this.owner}/${this.configRepo}/contents/${this.configPath}`,
                {
                    method: 'PUT',
                    body: {
                        message: 'chore: 初始化仓鼠配置',
                        content: btoa(unescape(encodeURIComponent(JSON.stringify(init, null, 2))))
                    }
                }
            );
            if (!w.ok) return { ok: false, error: '写入初始配置失败: ' + (w.message || '') };
            return { ok: true, created: true };
        } catch (e) {
            // request() 失败是 throw，所以创建失败实际走的是这里。
            // 针对最常见的几种情况给出能 actionable 的提示，
            // 而不是把 GitHub 那句 "Repository creation failed." 原样丢给用户。
            return { ok: false, error: this._explainCreateError(e) };
        }
    }

    /**
     * 把创建仓库的失败翻译成人能看懂的话
     *
     * 最坑的一种：仓库其实已经存在，但当前 token 看不到它
     * （fine-grained token 只授权了部分仓库时就会这样）。
     * 这时 GET 返回 404 → 判定"没装" → 去创建 → 422 "name already exists"。
     * 用户看到的现象就是"明明装了却说没有，点创建又失败"，完全无从下手。
     *
     * @param {Error} e
     * @returns {string}
     */
    _explainCreateError(e) {
        const raw = e.message || String(e);
        const status = e.status;
        const details = Array.isArray(e.errors) ? e.errors : [];
        const joined = (raw + ' ' + details.join(' ')).toLowerCase();

        // 已存在 —— 说明仓库在，但当前令牌没权限看到
        if (status === 422 && /already exists|name already/.test(joined)) {
            return `创建失败：${this.owner}/${this.configRepo} 已存在，但当前令牌看不到它。\n`
                + `这通常意味着令牌权限不足（fine-grained token 只授权了部分仓库）。\n`
                + `解决办法：换一个能访问全部仓库的令牌，或在令牌设置里把 ${this.configRepo} 加进授权范围。`;
        }

        // 无权限创建
        if (status === 403 || /forbidden|permission|denied/.test(joined)) {
            return `创建失败：令牌没有创建仓库的权限（${raw}）。\n`
                + `fine-grained token 需要勾选 "All repositories" 并给 Administration 写权限，\n`
                + `或者改用带 repo scope 的经典 token。`;
        }

        // 名字不合法等其它校验失败。
        // 正常情况下 request() 已经把 errors 拼进 message 了，
        // 这里再兜一次底：万一上层没拼（比如换了实现），也不能把原因弄丢。
        if (status === 422) {
            const extra = details.length && !details.some(d => raw.includes(d))
                ? `（${details.join('；')}）` : '';
            return `创建失败：${raw}${extra}`;
        }

        // 认证问题
        if (status === 401) {
            return `创建失败：令牌无效或已过期，请重新登录。`;
        }

        return raw;
    }

    /** 跳转到仓鼠（同源则带上下文，跨源则退化为直接打开） */
    open(params = {}) {
        const B = window.Bridge;
        if (B && B.go) {
            B.go(params);
            return { ok: true, mode: 'bridge' };
        }
        // 没有 Bridge（比如插件被单独打开）就直接跳首页
        window.open('https://cool-zimo.github.io/cangshu/', '_blank');
        return { ok: true, mode: 'fallback' };
    }

    /** 仓鼠页面 URL */
    get url() { return 'https://cool-zimo.github.io/cangshu/'; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = CangshuLink;
else window.CangshuLink = CangshuLink;
