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
    /**
     * 预留容量表。
     *
     * ★ 核心 bug：规划阶段连续调用 autoSelectRepo 选仓库，但真正登记用量
     *   （addToRepoUsage）要等到分片上传完之后。中间这段时间里每个分片
     *   看到的都是同一份"还没扣"的剩余容量 ——
     *
     *   实测：仓库只剩 100MB，连选 5 次 32MB（共 160MB），
     *   五次全选中同一个仓库，超额 60MB 却不报错。
     *
     *   后果就是"存储满了"：VFS 以为还有空间，实际仓库被撑爆。
     *
     * 现在规划时先记账（reserved），上传完成转正式、失败则退回。
     */
    _reservedGet(key) { return (this._reserved && this._reserved[key]) || 0; }
    _reservedAdd(key, size) {
        this._reserved = this._reserved || {};
        this._reserved[key] = (this._reserved[key] || 0) + size;
    }
    _reservedSub(key, size) {
        if (!this._reserved) return;
        this._reserved[key] = Math.max(0, (this._reserved[key] || 0) - size);
    }
    _remainingOf(repo, neededSize) {
        const key = `${repo.owner}/${repo.repo}`;
        const base = this.storage.getRepoRemaining(repo.owner, repo.repo);
        const reserved = this._reservedGet(key);
        // 建仓时会预留，所以减掉已经规划出去的部分
        return Math.max(0, base - reserved);
    }

    /**
     * 当前 token 的真实身份。
     *
     * ★ 不能只信 storage.getUser()。
     *   本地缓存的 user 可能和 token 不是同一个人（切换账号、桥接同步、
     *   或某条路径漏更新）。一旦如此，下面按 owner 过滤就会【保留别人的
     *   仓库、滤掉自己的】，然后拿自己的 token 去写 → 401 Bad credentials。
     *   拿不到缓存时现拉一次真实身份，宁可多一个请求也不要 401 风暴。
     */
    async _resolveLogin() {
        if (this._verifiedLogin) return this._verifiedLogin;   // 本会话已复核过
        const cached = this.storage.getUser()?.login;
        if (cached) return cached;
        if (this._loginPromise) return this._loginPromise;
        this._loginPromise = (async () => {
            try {
                const me = await this.api.getMe();
                const login = me && me.login;
                if (login) { this.storage.setUser(me); return login; }
            } catch (e) {
                console.warn('[FileManager] 无法确认 token 身份:', e.message);
            }
            return null;
        })();
        return this._loginPromise;
    }

    /**
     * 上传前用 token 复核一次身份（整个会话只问一次 GitHub）。
     *
     * ★ 这是「A 的仓库目录 + B 的 token」最直接的兜底。
     *   storage 里的 user 是缓存，和当前 token 可能不是同一个人。
     *   只信缓存的话，按 owner 过滤反而会帮倒忙。
     */
    async _ensureIdentity() {
        if (this._verifiedLogin) return this._verifiedLogin;
        const cached = this.storage.getUser()?.login;
        try {
            const me = await this.api.getMe();
            const real = me && me.login;
            if (!real) { this._verifiedLogin = cached || null; return this._verifiedLogin; }
            if (cached && cached !== real) {
                console.warn(
                    `[FileManager] 身份不符：本地缓存 ${cached}，token 实际 ${real}，` +
                    `已按 token 修正并重新同步仓库归属`);
                this.storage.setUser(me);
                // 缓存的仓库列表属于旧身份，必须清掉，
                // 否则会拿新身份去写旧身份的仓库。
                const all = this.storage.getRepos() || [];
                const stale = all.filter(r => r.owner !== real);
                if (stale.length) {
                    console.warn(`[FileManager] 清理 ${stale.length} 个不属于 ${real} 的仓库`);
                    this.storage.setRepos(all.filter(r => r.owner === real));
                }
            }
            this._verifiedLogin = real;
            return real;
        } catch (e) {
            console.warn('[FileManager] 身份复核失败，回退到本地缓存:', e.message);
            this._verifiedLogin = cached || null;
            return this._verifiedLogin;
        }
    }

    /**
     * ★ 分片级归属校验（v0.0.83）
     *
     * v0.0.82 只修了「往哪儿写」——校验装在 autoSelectRepo 上，那是上传新文件时
     * 选仓库的入口。但读和删走的是另一条路：
     *
     *     _fetchChunks      → api.getBlobBytes(chunk.owner, ...)   // 下载/预览
     *     _cleanupOrphanChunks / deleteFile
     *                       → api.deleteFile(chunk.owner, ...)     // 删除分片
     *
     * 这些用的是 VFS 文件条目里写死的 chunk.owner，根本不经过 autoSelectRepo。
     * 所以界面上能看到旧账号的文件夹（"学习""BINGBING"），一点就必然 401 —
     * 不是 token 失效，是拿 Feng-zimo 的 token 去打 Cool-zimo 的仓库。
     *
     * 这里的策略是「明确报错」而不是「静默尝试」：
     * 静默尝试 = 一串 401 刷屏，用户只会以为 token 坏了，
     * 于是去重新申请令牌 —— 白折腾，根因完全没碰到。
     */
    async _guardChunks(chunks, action) {
        if (!Array.isArray(chunks) || !chunks.length) return chunks;
        const me = await this._ensureIdentity();
        if (!me) return chunks;                      // 拿不到身份时不误伤
        const foreign = chunks.find(c => c && c.owner && c.owner !== me);
        if (!foreign) return chunks;
        throw new Error(
            `无法${action}：这些分片属于 ${foreign.owner}，` +
            `当前登录的是 ${me}。文件实体仍在 ${foreign.owner} 的仓库里（没丢），` +
            `只是这个账号没有权限操作。请切换到 ${foreign.owner}，或到设置里清理跨账号残留。`);
    }

    /**
     * 扫描 VFS，列出不属于当前账号的文件条目（只报告，不改动）。
     *
     * 刻意不自动删除 —— 这些条目背后的文件实体是真实存在的，
     * 一键清掉等于「我的文件凭空消失」。先列出来让用户自己决定。
     */
    async scanForeignFiles() {
        const me = await this._ensureIdentity();
        if (!me) return { me: null, foreign: [] };
        const vfs = this.storage.getVFS();
        const foreign = [];
        for (const [path, info] of Object.entries(vfs.files || {})) {
            const owners = [...new Set((info.chunks || []).map(c => c.owner).filter(Boolean))];
            const bad = owners.filter(o => o !== me);
            if (bad.length) {
                foreign.push({
                    path, name: info.name, size: info.size || 0,
                    owners: bad, chunks: (info.chunks || []).length
                });
            }
        }
        return { me, foreign };
    }

    /**
     * 清掉 VFS 里不属于当前账号的条目（只删本地索引，不动远端文件）。
     */
    async purgeForeignFiles(paths = null) {
        const { me, foreign } = await this.scanForeignFiles();
        if (!me) throw new Error('无法确定当前身份');
        const targets = paths
            ? foreign.filter(f => paths.includes(f.path))
            : foreign;
        if (!targets.length) return { removed: 0, me };
        const vfs = this.storage.getVFS();
        for (const f of targets) delete vfs.files[f.path];
        this.storage.setVFS(vfs);
        return { removed: targets.length, me, names: targets.map(t => t.name) };
    }

    async autoSelectRepo(neededSize) {
        const config = this.storage.getStorageConfig();
        // ★ 放在这里而不是 uploadFile 里：autoSelectRepo 是【所有】写入路径的
        //   必经之地，uploadFile 只是其中之一。放在上游才能覆盖全部。
        const currentUser = await this._ensureIdentity();
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

        // ★ 统一出口校验：不管仓库是从哪来的（缓存、迁移、自动新建），
        //   只要 owner 和当前身份不符就拦下。
        //
        //   这是最后一道防线。上游任何一处污染（迁移、切换账号漏清理、
        //   身份缓存过期）都会在这里被挡住，而不是发出一串必然 401 的请求。
        const guard = (repo) => {
            if (currentUser && repo && repo.owner !== currentUser) {
                throw new Error(
                    `仓库 ${repo.owner}/${repo.repo} 不属于当前账号 ${currentUser}，` +
                    `已阻止写入（否则会 401 Bad credentials）。请在设置里重新同步仓库列表。`);
            }
            return repo;
        };

        const defaultRepo = this.storage.getDefaultRepo();
        if (defaultRepo && defaultRepo.owner === currentUser && this._remainingOf(defaultRepo) >= neededSize) {
            this._reservedAdd(`${defaultRepo.owner}/${defaultRepo.repo}`, neededSize);
            return guard(defaultRepo);
        }

        const otherRepos = repos
            .filter(r => !r.isDefault)
            .sort((a, b) => this._remainingOf(b) - this._remainingOf(a));
        for (const repo of otherRepos) {
            if (this._remainingOf(repo) >= neededSize) {
                this._reservedAdd(`${repo.owner}/${repo.repo}`, neededSize);
                return guard(repo);
            }
        }

        if (config.autoCreateRepo) {
            return guard(await this.autoCreateStorageRepo());
        }

        throw new Error('所有仓库容量不足，且未开启自动创建仓库功能');
    }

    async autoCreateStorageRepo() {
        const config = this.storage.getStorageConfig();
        const date = new Date().toISOString().split('T')[0];
        const random = Math.random().toString(16).substring(2, 6);
        const repoName = `${config.repoNamePrefix}-${date}-${random}`;

        console.log(`[FileManager] 自动创建存储仓库: ${repoName}`);
        // ★ 第二个参数是 options 对象，不是布尔。
        //   之前传 `true`：`true.description` 是 undefined，描述丢了；
        //   private/autoInit 只是碰巧对（undefined !== false），纯属运气。
        const repo = await this.api.createRepository(repoName, {
            description: 'GitHub Drive 自动创建的存储仓库',
            private: true,
            autoInit: true
        });
        const repoInfo = {
            owner: repo.owner.login,
            repo: repo.name,
            name: repo.name,
            branch: 'main',
            isDefault: this.storage.getRepos().length === 0
        };
        this.storage.addRepo(repoInfo);
        this._reservedAdd(`${repoInfo.owner}/${repoInfo.repo}`, 0);   // 确保 key 存在
        return repoInfo;
    }

    // ==================== 文件上传（支持自动拆分） ====================

    /**
     * 分片规划。
     *
     * 实测结论（详见 COOL-DOC → GitHub Drive → 传输性能与分片算法）：
     *   1. 每片约 1~2 秒固定开销（TLS 握手 + API 往返），按片数付
     *   2. 并发 4 相比串行快 4 倍；再往上收益很小，瓶颈在 GitHub 侧
     *   3. 一次 commit 固定约 5.7 秒，与提交多少个文件无关 → 批次数越少越好
     *   4. 单个 blob 上限 ~38MB（卡的是 base64 之后的 payload，膨胀 33%）
     *
     * 所以最优解不是"固定一个分片大小"，而是：
     *   片数 ≈ 并发数，单片尽量大，最后所有片挤进一次 tree + commit。
     *
     * @returns {{direct:boolean, chunkSize:number, totalChunks:number, concurrency:number}}
     */
    /**
     * 分片 + 并发规划。
     *
     * 实测依据（详见 COOL-DOC → GitHub Drive → 传输性能与分片算法）：
     *   1. 每片约 1~2 秒固定开销（TLS 握手 + API 往返），按片数付
     *   2. 单片越大越接近带宽上限（实测封顶 ~7.9MB/s），所以大文件要少分片
     *   3. 单片上限 ~38MB（卡的是 base64 之后的 payload）
     *   4. 并发不是越大越好：32 片实测 conc16 = 14.63s 最优，conc24 = 20.52s 反而变慢
     *   5. 片数多时并发收益明显（32 片：conc4 18.46s → conc16 14.63s）
     *
     * 三个参数互相牵制，所以分三步定：
     *   分片大小 → 片数 → 并发数（受内存与实测上限双重约束）
     *
     * @returns {{direct:boolean, chunkSize:number, totalChunks:number, concurrency:number}}
     */
    planUpload(totalSize, config) {
        const DIRECT_MAX  = config.directMaxSize || 1 * 1024 * 1024;
        const MIN_CHUNK   = config.minChunkSize  || 1 * 1024 * 1024;
        const MAX_CHUNK   = config.chunkSize     || 32 * 1024 * 1024;
        // 并发硬上限：实测 conc24 已劣化，conc16 是拐点
        const HARD_CONC   = Math.max(1, Math.min(16, config.maxConcurrency || 16));
        // 内存预算：base64 膨胀 1.34 倍，一次只允许这么多字节在内存里
        const MEM_BUDGET  = config.memoryBudget || 512 * 1024 * 1024;

        // 小文件直传：切分只会多付固定开销，没有任何收益
        if (totalSize <= DIRECT_MAX) {
            return { direct: true, chunkSize: totalSize, totalChunks: 1, concurrency: 1 };
        }

        // ── 第一步：分片大小 ──
        // 目标片数 4（够吃满并发即可，再多纯付固定开销），再套上下限。
        // 32MB 上限是 blob 的硬约束；1MB 下限是因为更小的片固定开销占比过高。
        let chunkSize = Math.ceil(totalSize / 4);
        chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, chunkSize));
        const totalChunks = Math.ceil(totalSize / chunkSize);

        // ── 第二步：并发数 ──
        // 上限一：内存。单片越大，能同时编码的数量越少。
        //         512MB/(32MB×1.34) ≈ 11 —— 一次性编码 16 个 32MB 分片要 672MB，
        //         实测会直接被系统杀掉（512MB 那次就是这么没的）。
        const maxByMemory = Math.max(1, Math.floor(MEM_BUDGET / (chunkSize * 1.34)));

        // 上限二：实测拐点 16，再加只会劣化
        const concurrency = Math.max(1, Math.min(totalChunks, maxByMemory, HARD_CONC));

        return { direct: false, chunkSize, totalChunks, concurrency };
    }

    async uploadFile(file, targetPath = this.currentPath, onProgress = null) {
        const config = this.storage.getStorageConfig();
        const virtualPath = Storage.normalizePath(targetPath) + '/' + file.name;
        const totalSize = file.size;

        // ★ 覆盖上传会泄漏旧分片（线上实测：56.2MB / 45 个文件因此丢失）
        //   成因：每次上传都新建随机目录 `mtrand/filename`，VFS 只指向最新那份，
        //   旧目录的 blob 从不删除。所以先记住旧记录，新版本写成功后再清理。
        //   ★ 顺序不能反：先删旧的、新上传又失败 = 文件彻底没了。
        const oldFile = this.storage.getFile(virtualPath);
        const oldChunks = (oldFile && Array.isArray(oldFile.chunks))
            ? oldFile.chunks.slice() : [];

        const plan = this.planUpload(totalSize, config);
        console.log(`[FileManager] 上传 ${file.name} (${Storage.formatBytes(totalSize)})` +
            (plan.direct ? ' → 直传' : ` → ${plan.totalChunks} 片 × ${Storage.formatBytes(plan.chunkSize)}`));

        const chunks = [];

        try {
            if (plan.direct) {
                // ── 小文件：一次 contents API 直传，不建 blob 不建 tree ──
                const repo = await this.autoSelectRepo(totalSize);
                const chunkPath = `${Date.now().toString(36)}/${file.name}`;
                const arrayBuffer = await file.arrayBuffer();
                const base64 = this.arrayBufferToBase64(arrayBuffer);
                const res = await this.api.createOrUpdateFileBinary(
                    repo.owner, repo.repo, chunkPath, base64,
                    `上传文件: ${file.name}`, repo.branch);

                chunks.push({
                    owner: repo.owner,
                    repo: repo.repo,
                    path: chunkPath,
                    size: totalSize,
                    sha: (res && res.content && res.content.sha) || '',
                    branch: repo.branch
                });
                this.storage.addToRepoUsage(repo.owner, repo.repo, totalSize);
                this._reservedSub(`${repo.owner}/${repo.repo}`, totalSize);   // 规划预留转正
                if (onProgress) onProgress(100);

            } else {
                // ── 阶段 1：规划 + 选仓库（串行，纯本地计算，很快）──
                const dir = Date.now().toString(36);   // 本次上传共用一个目录
                const tasks = [];
                for (let i = 0; i < plan.totalChunks; i++) {
                    const start = i * plan.chunkSize;
                    const end = Math.min(start + plan.chunkSize, totalSize);
                    const size = end - start;
                    const repo = await this.autoSelectRepo(size);
                    tasks.push({
                        index: i,
                        start, end, size, repo,
                        name: `${file.name}.${i + 1}`,
                        path: `${dir}/${file.name}.${i + 1}`
                    });
                }
                if (onProgress) onProgress(5);

                // ── 阶段 2：并发建 blob ──
                // 只建 blob，不做 tree/commit —— 那两笔留到最后各仓库各做一次。
                // 旧实现是每个分片一次完整提交（getRef + getCommit + createBlob
                // + createTree + createCommit + updateRef + 再查一次 sha = 7 次
                // API 调用），100MB 文件就是 200 × 7 = 1400 次请求。
                //
                // ★ 必须分批：一次性把全部切片读进内存会爆。512MB 按 32MB 分片
                //   是 16 片，每片 base64 后 42MB，全编码就是 672MB 字符串同时在
                //   内存里（实测直接被系统杀掉，且没有任何报错）。
                const uploaded = [];
                for (let s = 0; s < tasks.length; s += plan.concurrency) {
                    const batch = tasks.slice(s, s + plan.concurrency);
                    const results = await Promise.all(batch.map(async (t) => {
                        const arrayBuffer = await file.slice(t.start, t.end).arrayBuffer();
                        const blob = await this.api.createBlobFromArrayBuffer(
                            t.repo.owner, t.repo.repo, arrayBuffer);
                        return { task: t, sha: blob.sha };
                    }));
                    uploaded.push(...results);

                    if (onProgress) {
                        const done = Math.min(tasks.length, s + batch.length);
                        onProgress(Math.round(5 + (done / tasks.length) * 85));
                    }
                }

                // ── 阶段 3：按仓库分组，每组一次 tree + 一次 commit ──
                // 为什么必须分组：不同分片可能被 autoSelectRepo 分到不同仓库。
                // 为什么每组只做一次：commit 那 5.7 秒是付给"一笔提交"的，
                // 跟提交多少个文件无关 —— 拆成多次就是白送 5.7 × N 秒。
                const byRepo = new Map();
                for (const { task, sha } of uploaded) {
                    const key = `${task.repo.owner}/${task.repo.repo}`;
                    if (!byRepo.has(key)) byRepo.set(key, { repo: task.repo, items: [] });
                    byRepo.get(key).items.push({ task, sha });
                }

                let groupIndex = 0;
                for (const { repo, items } of byRepo.values()) {
                    // blob 的 sha 就是 contents API 的文件 sha（已实测验证：
                    // 同一份内容两种方式拿到的 sha 完全相同），所以不用像旧实现
                    // 那样每片再查一次 getFileContents —— 省掉 N 次请求。
                    const ref = await this.api.getRef(repo.owner, repo.repo, `heads/${repo.branch}`);
                    const latestCommitSha = ref.object.sha;
                    const latestCommit = await this.api.getCommit(repo.owner, repo.repo, latestCommitSha);

                    let baseTreeSha = latestCommit.tree.sha;
                    let parentSha = latestCommitSha;

                    // tree 一次最多放这么多条目（保守值，实测 256 也可行，
                    // 但 payload 会明显变大）。超过就分多批 —— 但仍是同一条链，
                    // 每批一次 commit。
                    const TREE_MAX = 128;
                    for (let b = 0; b < items.length; b += TREE_MAX) {
                        const slice = items.slice(b, b + TREE_MAX);
                        const tree = await this.api.createTree(repo.owner, repo.repo,
                            slice.map(({ task, sha }) => ({
                                path: task.path, mode: '100644', type: 'blob', sha
                            })), baseTreeSha);
                        const commit = await this.api.createCommit(repo.owner, repo.repo,
                            `上传分片: ${file.name} (${slice.length})`, tree.sha, [parentSha]);
                        await this.api.updateRef(repo.owner, repo.repo,
                            `heads/${repo.branch}`, commit.sha);
                        baseTreeSha = tree.sha;
                        parentSha = commit.sha;
                    }

                    for (const { task, sha } of items) {
                        chunks.push({
                            owner: repo.owner,
                            repo: repo.repo,
                            path: task.path,
                            size: task.size,
                            sha: sha,
                            branch: repo.branch
                        });
                        this.storage.addToRepoUsage(repo.owner, repo.repo, task.size);
                        this._reservedSub(`${repo.owner}/${repo.repo}`, task.size);   // 规划预留转正
                    }
                    groupIndex++;
                    if (onProgress) {
                        onProgress(Math.round(90 + (groupIndex / byRepo.size) * 10));
                    }
                }
            }
        } catch (uploadError) {
            console.warn(`[FileManager] 上传失败，正在清理 ${chunks.length} 个已写入分片...`);

            // 401/404：可能是仓库列表里有无效仓库（其他账号的或已删除的）
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
            // ★ 失败也要退回预留：否则这份"幽灵占用"会一直挂着，
            //   后续上传会误以为仓库满了，白白多建仓库
            for (const t of (typeof tasks !== 'undefined' ? tasks : [])) {
                this._reservedSub(`${t.repo.owner}/${t.repo.repo}`, t.size);
            }
            for (const chunk of chunks) {
                try {
                    if (chunk.sha) {
                        await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path,
                            `清理上传失败的分片: ${chunk.path}`, chunk.branch, chunk.sha);
                        this.storage.subtractFromRepoUsage?.(chunk.owner, chunk.repo, chunk.size);
                    }
                } catch (cleanupError) {
                    console.warn(`[FileManager] 清理分片失败: ${chunk.path}`, cleanupError.message);
                }
            }
            // 注意：只建了 blob、还没进 tree 的那些分片是"游离"的，
            // contents API 删不掉（它们不在任何 tree 里）。GitHub 会自行回收，
            // 且不计入仓库配额，所以这里不逐个尝试删除。
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
        return { virtualPath, fileInfo, chunks, split: chunks.length > 1 };
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

    // ==================== 分片批量读取（下载/预览共用） ====================
    /**
     * 并发拉取一个文件的所有分片，按**原顺序**返回字节数组。
     *
     * @param {Array} chunks - [{owner, repo, path, sha, branch}]
     * @param {Function} onChunkDone - (已完成片数) => void
     * @param {number} concurrency - 并发上限
     * @returns {Promise<Uint8Array[]>}
     */
    async _fetchChunks(chunks, onChunkDone = null, concurrency = 6) {
        // ★ 读路径的归属校验：下载/预览都走这里，而 chunk.owner 来自 VFS 历史记录，
        //   不经过 autoSelectRepo。少了这道就会用当前 token 去打别人的仓库。
        await this._guardChunks(chunks, '读取');
        const total = chunks.length;
        const bufs = new Array(total);
        const treeCache = new Map();        // 老数据没 sha 时的兜底：复用同一棵树
        const queue = chunks.map((c, i) => ({ chunk: c, i }));
        let done = 0;

        async function worker() {
            while (queue.length) {
                const { chunk, i } = queue.shift();
                try {
                    let bytes;
                    if (chunk.sha) {
                        // 快路径：内容寻址，一步到位
                        bytes = await this.api.getBlobBytes(chunk.owner, chunk.repo, chunk.sha);
                    } else {
                        // 慢路径：老数据没有 sha，至少复用 tree
                        const raw = await this.api.getFileRaw(
                            chunk.owner, chunk.repo, chunk.path, chunk.branch || 'main', treeCache);
                        bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                    }
                    // ★ 必须按下标 i 放，不能 push。
                    //   并发完成的先后不等于分片顺序 —— 用 push 拼出来的文件是乱的，
                    //   而且不报错，只是打不开。
                    bufs[i] = bytes;
                } catch (e) {
                    // ★ 必须在这里就把片号带上。
                    //   worker 里直接抛的话，Promise.all 只会把原始错误（如 "404"）
                    //   冒出去，用户看到的就是一句没头没尾的 404，不知道是哪片、
                    //   也不知道总共几片 —— 而下面那段空洞检查根本没机会执行。
                    throw new Error(`分片 ${i + 1}/${total} 读取失败：${e.message}`);
                }
                done++;
                if (onChunkDone) onChunkDone(done);
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) },
            () => worker.call(this)));

        // 有空洞说明那一片失败，不能拼
        for (let i = 0; i < total; i++) {
            if (!bufs[i]) throw new Error(`分片 ${i + 1}/${total} 下载失败`);
        }
        return bufs;
    }

    // ==================== 仓库整理（合并碎片仓库、回收空仓） ====================
    /**
     * 规划整理方案：把零散的小仓并进大仓，腾出来的仓可以删掉。
     *
     * 场景：用久了会出现 5 个仓，其中 1 个快满、另外 4 个各占几十 MB。
     *   能写的只剩那 4 个的零散空间，仓库列表却越来越长、越来越难管。
     *   整理后：内容集中到尽量少的仓里，剩下的整仓删除。
     *
     * ★ 排序必须是**用量降序**：
     *   大仓当"桶"从不动，只搬小仓 —— 迁移量最小。
     *   升序会让大仓的内容被搬来搬去，迁移量暴涨（实测差别是数量级的）。
     *
     * @returns {{bins:Array, moves:Array, deletable:Array, beforeCount:number, afterCount:number, moveBytes:number}}
     */
    /**
     * 规划整理：**把仓填满，腾空的删掉**。
     *
     * ★ v0.0.64 重写。旧算法是"把整个仓当一个物品装箱"：
     *     A 仓剩 94MB、B 仓 124MB → 124 装不进 94 → B 只能独立成仓。
     *   结果 A 永远停在 806MB 填不满，B 也留着，仓数降不下去。
     *
     *   正确做法：以**分片**为单位装箱。
     *     按用量降序遍历每个仓当作"目标"，拿它的剩余空间
     *     从后面的小仓里挑分片搬进来（大分片优先，减少碎片）。
     *     这样 A 那 94MB 会被塞满，B 剩下的部分继续留在 B。
     *
     *   ★ 只从"后面的仓"往"前面的仓"搬，绝不倒过来：
     *     把大仓的数据往小仓倒，迁移量会暴涨，而且下次整理又倒回来，
     *     来回震荡。单向搬运保证收敛。
     *
     *   ★ 副作用要说清楚：一个文件的分片可能被拆到不同仓。
     *     storage 本来就支持跨仓分片（下载按 chunks 顺序拼），
     *     但拆开后若其中某个仓被删，文件就坏了 ——
     *     所以 deletable 只含"搬完后真的空了"的仓，且执行前还会再校验一次。
     */
    planRepoCompaction() {
        const config = this.storage.getStorageConfig();
        const currentUser = this.storage.getUser()?.login;
        const max = config.maxRepoSize || 943718400;

        let repos = this.storage.getRepos();
        if (currentUser) repos = repos.filter(r => r.owner === currentUser);

        const usage = this.storage.getRepoUsage ? (this.storage.getRepoUsage() || {}) : {};
        // 用量降序：大仓先填满
        const bins = repos.map(r => {
            const key = `${r.owner}/${r.repo}`;
            const u = (usage[key] && usage[key].size) || 0;
            return { key, owner: r.owner, repo: r.repo, branch: r.branch || 'main', used: u };
        }).sort((a, b) => b.used - a.used);

        const binIndex = new Map(bins.map((b, i) => [b.key, i]));

        // 收集所有分片（大分片优先 —— 更容易把剩余空间塞满，碎片更少）
        const vfs = this.storage.getVFS();
        const files = (vfs && vfs.files) || {};
        const items = [];
        for (const vp of Object.keys(files)) {
            const arr = (files[vp] && Array.isArray(files[vp].chunks)) ? files[vp].chunks : [];
            arr.forEach((chunk, idx) => {
                if (!chunk) return;
                items.push({
                    vp, idx, chunk,
                    size: chunk.size || 0,
                    fromKey: `${chunk.owner}/${chunk.repo}`
                });
            });
        }
        items.sort((a, b) => b.size - a.size);

        const moves = [];
        for (let i = 0; i < bins.length; i++) {
            const target = bins[i];
            let space = max - target.used;
            if (space <= 0) continue;
            for (const it of items) {
                if (space <= 0) break;
                if (it._moved) continue;
                const si = binIndex.get(it.fromKey);
                if (si === undefined || si <= i) continue;   // 只从后面的仓往前搬
                if (it.size > space) continue;               // 装不下就看更小的
                it._moved = true;
                space -= it.size;
                target.used += it.size;
                bins[si].used -= it.size;
                moves.push({
                    vp: it.vp, idx: it.idx, chunk: it.chunk, size: it.size,
                    from: bins[si], to: target
                });
            }
        }

        // 腾空的仓 → 可删。bins[0] 永远保留（它只进不出，且至少要留一个仓）
        const empties = bins.filter((b, i) => b.used <= 0 && i > 0);

        return {
            max,
            bins,
            moves,
            targets: [...new Set(moves.map(m => m.to.key))],
            deletable: empties.map(b => ({
                key: b.key, owner: b.owner, repo: b.repo, branch: b.branch
            })),
            beforeCount: bins.length,
            afterCount: bins.length - empties.length,
            moveBytes: moves.reduce((s, m) => s + m.size, 0),
            totalBytes: bins.reduce((s, b) => s + Math.max(0, b.used), 0)
        };
    }

    /**
     * 执行整理：把待迁分片搬进目标仓，校验通过后才改 VFS、再删空仓。
     *
     * ★ 顺序不能反，这是唯一不会丢数据的做法：
     *     1) 先把分片写进目标仓
     *     2) 校验每一片（用 blob 的内容寻址特性，sha 对得上就是字节一致）
     *     3) 全部通过 → 改 VFS 指向新位置
     *     4) 最后才删源仓
     *   如果先改 VFS 再上传，中途失败就是真丢数据。
     *
     * ★ 校验是"免费"的：blob 内容寻址，同内容必然同 sha。
     *   所以源分片有 sha 时，只要新 sha == 旧 sha，就证明字节完全一致，
     *   不需要再下载比对。
     *
     * @param {object} plan - planRepoCompaction() 的结果
     * @param {Function} onProgress - (阶段, 已完成, 总数, 说明)
     * @param {boolean} deleteSources - 是否删除源仓库
     */
    async compactRepos(plan, onProgress = null, deleteSources = true) {
        const vfs = this.storage.getVFS();
        const files = vfs.files || {};

        // ① 待迁分片：v0.0.64 起 plan.moves 已经是分片级，直接用
        const byTarget = new Map();
        for (const mv of plan.moves) {
            if (!byTarget.has(mv.to.key)) byTarget.set(mv.to.key, { move: mv, items: [] });
            byTarget.get(mv.to.key).items.push({ vpath: mv.vp, idx: mv.idx, chunk: mv.chunk });
        }

        const totalItems = [...byTarget.values()].reduce((s, g) => s + g.items.length, 0);
        // ★ 不能只看 totalItems：可能一个分片都不用搬，但有空仓要删。
        //   （例：大仓已满、小仓也满，只剩一个新建的空仓 —— 该删却删不掉）
        if (totalItems === 0 && (!plan.deletable || plan.deletable.length === 0)) {
            return { moved: 0, deleted: [], totalItems: 0, skipped: true };
        }
        console.log(`[FileManager] 整理仓库：${totalItems} 个分片待迁移`);

        let done = 0;
        const emit = (stage, msg) => {
            if (onProgress) onProgress(stage, done, totalItems, msg);
        };

        // ② 逐个目标仓迁移
        const migrated = [];   // {vpath, idx, newChunk}
        const usedPaths = new Map();   // 目标仓内已占用的路径，防覆盖

        for (const [targetKey, group] of byTarget) {
            const to = group.move.to;
            emit('migrate', `迁移到 ${to.repo}`);

            // 目标仓现有路径（防覆盖）
            const existing = new Set();
            try {
                const contents = await this.api.getDirectoryContents(to.owner, to.repo, '', to.branch);
                (contents || []).forEach(c => existing.add(c.path));
            } catch (e) {
                console.warn('[FileManager] 读取目标仓目录失败（按空仓处理）:', e.message);
            }
            usedPaths.set(targetKey, existing);

            // 读源分片字节（有 sha 就直连，1 次请求）
            const failed = [];
            const concurrency = 4;
            const queue = group.items.slice();
            const results = new Array(group.items.length);

            async function worker() {
                while (queue.length) {
                    const job = queue.shift();
                    const { chunk, idx, vpath } = job;
                    try {
                        const bytes = chunk.sha
                            ? await this.api.getBlobBytes(chunk.owner, chunk.repo, chunk.sha)
                            : await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch || 'main');
                        results[group.items.indexOf(job)] = { job, bytes };
                    } catch (e) {
                        failed.push({ job, err: e });
                    }
                    done++;
                    emit('migrate', `读取 ${done}/${totalItems}`);
                }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, group.items.length || 1) },
                () => worker.call(this)));

            if (failed.length) {
                throw new Error(
                    `${failed.length} 个分片读取失败（首个：${failed[0].err.message}）。` +
                    `未改动任何记录，源数据完好。`);
            }

            // 建 blob（并发）+ 一次 tree + commit
            const stamp = Date.now().toString(36);
            const entries = [];
            const newChunks = new Array(group.items.length);

            const blobQueue = results.map((r, i) => ({ r, i }));
            const blobFail = [];
            async function blobWorker() {
                while (blobQueue.length) {
                    const { r, i } = blobQueue.shift();
                    const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
                    try {
                        const base64 = this.arrayBufferToBase64(bytes.buffer || bytes);
                        const blob = await this.api.createBlob(to.owner, to.repo, base64, 'base64');
                        const newSha = blob && blob.sha;
                        if (!newSha) throw new Error('建 blob 未返回 sha');

                        // ★ 免费校验：内容寻址 ⇒ 同内容必然同 sha
                        if (r.job.chunk.sha && newSha !== r.job.chunk.sha) {
                            throw new Error(`分片校验失败：新 sha ${newSha.slice(0, 8)} ≠ 原 sha ${r.job.chunk.sha.slice(0, 8)}`);
                        }

                        const base = (r.job.chunk.path || 'chunk').split('/').pop();
                        let path = `${stamp}/c${i}_${base}`;
                        const set = usedPaths.get(targetKey);
                        let n = 0;
                        while (set.has(path)) { path = `${stamp}/c${i}_${++n}_${base}`; }
                        set.add(path);

                        entries.push({ path, mode: '100644', type: 'blob', sha: newSha });
                        newChunks[i] = {
                            owner: to.owner,
                            repo: to.repo,
                            path,
                            size: r.job.chunk.size || bytes.length,
                            sha: newSha,
                            branch: to.branch
                        };
                    } catch (e) {
                        blobFail.push({ i, err: e });
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(4, blobQueue.length || 1) },
                () => blobWorker.call(this)));

            if (blobFail.length) {
                throw new Error(
                    `${blobFail.length} 个分片写入失败（首个：${blobFail[0].err.message}）。` +
                    `未改动任何记录，源数据完好。`);
            }

            // 分批提交（tree API 单次条数有上限）
            const BATCH = 100;
            let ref = await this.api.getRef(to.owner, to.repo, `heads/${to.branch}`);
            let parentSha = ref.object.sha;
            for (let b = 0; b < entries.length; b += BATCH) {
                const part = entries.slice(b, b + BATCH);
                const cm = await this.api.getCommit(to.owner, to.repo, parentSha);
                const tree = await this.api.createTree(to.owner, to.repo, part, cm.tree.sha);
                const commit = await this.api.createCommit(
                    to.owner, to.repo, `整理仓库：迁入 ${part.length} 个分片`, tree.sha, [parentSha]);
                await this.api.updateRef(to.owner, to.repo, `heads/${to.branch}`, commit.sha);
                parentSha = commit.sha;
            }

            group.items.forEach((job, i) => {
                migrated.push({ vpath: job.vpath, idx: job.idx, newChunk: newChunks[i] });
            });
        }

        // ③ 全部校验通过才改 VFS
        for (const m of migrated) {
            const f = vfs.files[m.vpath];
            if (f && f.chunks && f.chunks[m.idx]) f.chunks[m.idx] = m.newChunk;
        }
        this.storage.setVFS(vfs);

        // ④ 重算用量 —— 必须**全量重算**，不能加减。
        //
        //   ★ v0.0.64 修正：原来的写法是 subtract(mv.from.used)，
        //     但 moves 改成分片级之后，mv.from.used 是**整个仓**的用量，
        //     而实际只搬走了其中一部分 —— 照旧写会把整个仓的用量扣光，
        //     登记凭空少掉一大截，后续上传就会误判"还有空间"而超额写入。
        //
        //   全量重算的另一个理由：孤儿分片不进 VFS，加减法永远算不到它们，
        //   漏记只会越滚越大。
        const newUsage = {};
        for (const f of Object.values(vfs.files || {})) {
            for (const c of (f.chunks || [])) {
                if (!c) continue;
                const k = `${c.owner}/${c.repo}`;
                newUsage[k] = (newUsage[k] || 0) + (c.size || 0);
            }
        }
        const oldUsage = this.storage.getRepoUsage ? (this.storage.getRepoUsage() || {}) : {};
        for (const k of new Set([...Object.keys(oldUsage), ...Object.keys(newUsage)])) {
            const [owner, repo] = k.split('/');
            this.storage.setRepoUsage?.(owner, repo, newUsage[k] || 0);
        }

        // ⑤ 删源仓（只有到这一步才不可逆）
        //
        // ★ 删除前必须**重新读一遍源仓**，确认里面确实没有 VFS 还在用的分片。
        //   为什么不能只信 plan：plan 是几分钟前算的，这期间用户可能又传了东西、
        //   也可能有别的设备往里写。拿陈旧的结论去删仓库 = 删掉还在用的数据。
        //   这是唯一不可逆的一步，所以宁可多花一次请求。
        const deleted = [];
        const skipped = [];
        if (deleteSources) {
            for (const src of plan.deletable) {
                const key = src.key;
                try {
                    const empty = await this._isRepoUnused(src);
                    if (!empty.ok) {
                        skipped.push({ key, reason: empty.reason });
                        console.warn(`[FileManager] 跳过删除 ${key}：${empty.reason}`);
                        continue;
                    }
                    await this.api.deleteRepository(mv.from.owner, mv.from.repo);
                    deleted.push(key);
                } catch (e) {
                    console.warn('[FileManager] 删除源仓失败（数据已迁移，不影响）:', key, e.message);
                    skipped.push({ key, reason: e.message });
                }
            }
        }

        // 从本地仓库列表移除已删的
        if (deleted.length && this.storage.setRepos) {
            const gone = new Set(deleted);
            this.storage.setRepos(
                this.storage.getRepos().filter(r => !gone.has(`${r.owner}/${r.repo}`)));
        }

        console.log(`[FileManager] 整理完成：迁移 ${migrated.length} 片，删除 ${deleted.length} 个空仓`);
        return { moved: migrated.length, deleted, totalItems };
    }

    /**
     * 判断一个仓库是不是真的可以删了。
     *
     * 判据不是"我刚把它的东西搬走了"，而是"现在还有没有 VFS 记录指向它"。
     * 只要还有一个 chunk 住在里面，就不能删 ——
     * 哪怕那个 chunk 是我以为已经搬走的（可能中途又写了新的）。
     *
     * @returns {{ok:boolean, reason:string}}
     */
    async _isRepoUnused(repo) {
        const vfs = this.storage.getVFS();
        const files = vfs.files || {};
        for (const f of Object.values(files)) {
            if (!Array.isArray(f.chunks)) continue;
            for (const c of f.chunks) {
                if (c.owner === repo.owner && c.repo === repo.repo) {
                    return { ok: false, reason: `仍有分片被记录引用（${c.path}）` };
                }
            }
        }
        // 再看远端实际还有没有文件（防止 VFS 漏记的情况）
        try {
            const contents = await this.api.getDirectoryContents(
                repo.owner, repo.repo, '', repo.branch || 'main');
            const left = (contents || []).filter(c =>
                c.type === 'file' && c.name !== 'README.md' && c.name !== '.gitkeep');
            if (left.length) {
                return { ok: false, reason: `仓库里还有 ${left.length} 个文件` };
            }
        } catch (e) {
            // 读不到（可能已被删）就不拦，交给下面的 delete 自己报错
            console.debug('[FileManager] 读源仓目录失败（按可删处理）:', e.message);
        }
        return { ok: true, reason: '' };
    }

    // ==================== 文件下载（自动合并分片） ====================
    async downloadFile(virtualPath, onProgress = null) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        const totalChunks = fileInfo.chunks.length;
        console.log(`[FileManager] 下载文件: ${virtualPath}, 分片数: ${totalChunks}`);

        /**
         * ★ 这里原本是下载慢的主因，两层问题叠在一起：
         *
         *   1) 分片**串行**：32 片的文件就是 32 次串行往返。
         *
         *   2) 每片都要重跑 getRef → getCommit → getTree(递归) → getBlob。
         *      其中 getTree 拉的是**整棵仓库树** —— 跟要读的那个分片毫无关系，
         *      仓库越大越慢。实测小仓库（tree 9 条）单分片：
         *        老路径  4 次请求 2006ms
         *        sha直连 1 次请求  520ms
         *
         *   而 VFS 里每个 chunk **早就记了 sha**（上传时就写进去了），
         *   blob 又是内容寻址的 —— 有 sha 就能一步拿到内容，那三步全是绕路。
         *
         *   所以：有 sha → 直连（1 次请求）；没有 → 退回老路径并复用 tree。
         */
        const parts = await this._fetchChunks(fileInfo.chunks, (done) => {
            if (onProgress) onProgress(Math.round(done / totalChunks * 100), done, totalChunks);
        });

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

        // 走同一套并发 + sha 直连（原来是串行 + 每片重拉整棵 tree）
        const parts = await this._fetchChunks(fileInfo.chunks);
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

        // ★ 预览走的是这条路（点开图片看），原来也是串行 + 每片重拉整棵 tree。
        //   现在与下载共用同一套并发 + sha 直连。
        let parts;
        try {
            parts = await this._fetchChunks(fileInfo.chunks);
        } catch (e) {
            console.error('[FileManager] 读取分片失败:', e);
            throw new Error('读取分片失败: ' + e.message);
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
        // ★ 删路径的归属校验：跨账号的删请求必然 401，
        //   而且会被记成"孤儿清理失败"，越积越多，真正的孤儿反而淹没在里面。
        await this._guardChunks(chunks, '清理');
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

        // ★ 删路径的归属校验：跨账号删除必然 401，
        //   且原逻辑会把失败静默记成孤儿，用户看到的是"删不掉"而不是"不属于你"。
        await this._guardChunks(fileInfo.chunks, '删除');

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
    /**
     * ★ 之前签名是 searchFiles(query)，把第二个参数丢了 ——
     *   app.searchFiles 明明传了 searchContent=true，
     *   到这里被截断成 undefined，storage 侧永远走 false，
     *   于是"内容搜索"开了也跟没开一样。
     */
    searchFiles(query, searchContent = false) {
        return this.storage.searchFiles(query, searchContent);
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
