/**
 * 仓库维护 —— 孤儿/幽灵检测与恢复
 *
 * ★ 为什么要有这个模块：
 *   覆盖上传同名文件时，旧目录（Date.now().toString(36)/文件名）
 *   不会被清理，VFS 只指向最新那份 —— 于是旧数据变成"孤儿"：
 *   物理上还在仓库里占着容量，界面上永远看不见、下载不了、删不掉。
 *
 *   实测：界面 15 个文件，仓库里躺着 45 个（56MB），丢的比留的多 3 倍。
 *
 * ★ 术语
 *   孤儿 orphan：仓库里有 blob，VFS 没有记录 → 用户看不见但占容量
 *   幽灵 ghost ：VFS 有记录，仓库里没有 blob → 用户看得见但下载必失败
 *
 * ★ 恢复策略：只增不删
 *   孤儿一律落到 /drive_home/_recovered，不覆盖现有文件。
 *   重名自动加序号（a.txt → a(1).txt），因为无法判断哪个版本是用户要的。
 *   **绝不删除任何东西** —— 判定依赖 VFS 完整，而 VFS 本身可能残缺。
 */
const MAINTAIN_RECOVER_DIR = '/drive_home/_recovered';

// 面包屑契约（与桌面版 gdrive/core/textutil.py 保持一致）
const BREADCRUMB_ROOT_LABEL = '网盘';
const BREADCRUMB_MAX = 5;
const BREADCRUMB_ELLIPSIS = '\u2026';
const BREADCRUMB_NAME_LIMIT = 24;

/** 单段名过长时截断，保留后缀（文件名后缀往往更重要） */
function shortenName(name, limit) {
    limit = limit || BREADCRUMB_NAME_LIMIT;
    if (!name || name.length <= limit) return name;
    const keep = Math.max(1, limit - 1);        // ELLIPSIS 占 1 个字符
    const head = Math.floor(keep * 2 / 3);
    const tail = keep - head;
    return name.substring(0, head) + BREADCRUMB_ELLIPSIS +
           (tail ? name.substring(name.length - tail) : '');
}

/** 重名加序号：a.txt → a(1).txt */
function dedupeName(name, used) {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.substring(0, dot) : name;
    const ext = dot > 0 ? name.substring(dot) : '';
    let i = 1;
    while (used.has(base + '(' + i + ')' + ext)) i++;
    const final = base + '(' + i + ')' + ext;
    used.add(final);
    return final;
}

class Maintain {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
    }

    /**
     * 扫描：比对 VFS 记录与仓库实际 blob
     *
     * onProgress(done, total, label) 可选
     * 返回与桌面版 maintain.py 同形的结果
     */
    async scan(onProgress) {
        const vfs = this.storage.getVFS();
        const repos = this.storage.getRepos() || [];

        // ---- 1. VFS 记录的所有分片 ----
        // ★ 用 \u0000 分隔，不能用 '/' —— 分片 path 本身含 '/'
        const recorded = new Map();
        let recordedBytes = 0;
        for (const vpath of Object.keys(vfs.files || {})) {
            const info = vfs.files[vpath];
            for (const ch of (info.chunks || [])) {
                const key = ch.owner + '\u0000' + ch.repo + '\u0000' + ch.path;
                const size = parseInt(ch.size || 0, 10) || 0;
                recorded.set(key, { vpath: vpath, size: size });
                recordedBytes += size;
            }
        }

        // ---- 2. 确定要扫的仓库 ----
        // repos 列表 + VFS 里引用过但已不在列表里的（否则会漏判幽灵）
        const repoMap = new Map();       // 'owner\u0000repo' -> branch
        for (const r of repos) {
            repoMap.set(r.owner + '\u0000' + r.repo, r.branch || 'main');
        }
        for (const key of recorded.keys()) {
            const parts = key.split('\u0000');
            const rk = parts[0] + '\u0000' + parts[1];
            if (!repoMap.has(rk)) repoMap.set(rk, 'main');
        }

        // ---- 3. 逐仓扫描 ----
        const orphans = [];
        const usageActual = {};
        const errors = [];
        const blobmap = new Map();       // 'owner\u0000repo' -> Map(path->blob)

        const keys = Array.from(repoMap.keys());
        let done = 0;
        for (const rk of keys) {
            const parts = rk.split('\u0000');
            const owner = parts[0], repo = parts[1];
            const branch = repoMap.get(rk);
            if (onProgress) onProgress(done + 1, keys.length, owner + '/' + repo);

            let blobs;
            try {
                const tree = await this.api.getTree(owner, repo, branch, true);
                blobs = (tree && tree.tree ? tree.tree : [])
                    .filter(function (t) { return t.type === 'blob'; });
            } catch (e) {
                errors.push({ repo: owner + '/' + repo, error: String(e && e.message || e) });
                done++;
                continue;
            }

            const map = new Map();
            let total = 0;
            for (const b of blobs) {
                map.set(b.path, b);
                total += parseInt(b.size || 0, 10) || 0;
            }
            blobmap.set(rk, map);
            usageActual[owner + '/' + repo] = total;
            done++;
        }

        // ---- 4. 孤儿：物理存在、VFS 无记录 ----
        for (const rk of blobmap.keys()) {
            const parts = rk.split('\u0000');
            const owner = parts[0], repo = parts[1];
            const branch = repoMap.get(rk);
            for (const b of blobmap.get(rk).values()) {
                const key = owner + '\u0000' + repo + '\u0000' + b.path;
                if (recorded.has(key)) continue;
                if (Maintain.isSystemFile(b.path)) continue;   // README/.gitignore 不是孤儿
                orphans.push({
                    owner: owner, repo: repo, path: b.path,
                    size: parseInt(b.size || 0, 10) || 0,
                    sha: b.sha || '', branch: branch
                });
            }
        }

        // ---- 5. 幽灵：VFS 有记录、物理不存在 ----
        const ghosts = [];
        for (const key of recorded.keys()) {
            const parts = key.split('\u0000');
            const rk = parts[0] + '\u0000' + parts[1];
            const map = blobmap.get(rk);
            // 仓库扫失败时不判幽灵 —— 没扫到不等于不存在
            if (!map) continue;
            if (!map.has(parts[2])) {
                ghosts.push({
                    vpath: recorded.get(key).vpath,
                    owner: parts[0], repo: parts[1], path: parts[2]
                });
            }
        }

        const actualBytes = Object.values(usageActual)
            .reduce(function (a, b) { return a + b; }, 0);

        return {
            orphans: orphans,
            ghosts: ghosts,
            usage_actual: usageActual,
            errors: errors,
            orphan_bytes: orphans.reduce(function (a, o) { return a + o.size; }, 0),
            // 统计字段（CLI/UI 依赖，别漏）
            file_count: Object.keys(vfs.files || {}).length,
            recorded_bytes: recordedBytes,
            actual_bytes: actualBytes,
            repo_count: keys.length
        };
    }

    /**
     * 校准用量登记值。
     *
     * ★ 这才是"存储满了"最常见的真正原因，而不是孤儿。
     *
     *   repoUsage 是每次上传时**累加**出来的（addToRepoUsage）。
     *   覆盖上传、失败重试、并发回滚不完整都会让它只增不减，
     *   长期下来明显高于仓库里真实存在的字节数。
     *
     *   而 maxRepoSize / getRepoRemaining / 选仓库 全部读的是这个登记值 ——
     *   于是仓库明明还有空间，系统却判定它满了，不肯再往里写，
     *   表现出来就是"传不进去 / 一直在建新仓库"。
     *
     *   实测（Cool-zimo）：
     *     主仓登记 996.8 MB，实际内容只有 806.1 MB，虚高 190 MB，
     *     直接把 900 MB 的 maxRepoSize 顶穿了。
     *
     *   校准用扫描已经算出的 usage_actual（tree 逐 blob 求和，最准）覆盖登记值。
     *
     * @param {Object} report - scan() 的返回值
     * @returns {{fixed:Array, beforeBytes:number, afterBytes:number, freedBytes:number}}
     */
    async recalibrateUsage(report) {
        const actual = (report && report.usage_actual) || {};
        const before = this.storage.getRepoUsage();
        const fixed = [];
        let beforeBytes = 0;
        let afterBytes = 0;

        for (const key of Object.keys(actual)) {
            const idx = key.indexOf('/');
            if (idx < 0) continue;
            const owner = key.slice(0, idx);
            const repo = key.slice(idx + 1);
            const oldSize = (before[key] && before[key].size) || 0;
            // ★ 必须四舍五入，不能用 parseInt ——
            //   parseInt(46766489.6) 会截成 46766489，
            //   于是"本来就没偏差"的仓库也被判定需要改写，
            //   白白触发一次全量配置同步，还引入 1 字节以内的误差。
            const newSize = Math.round(actual[key]) || 0;
            beforeBytes += oldSize;
            afterBytes += newSize;
            // 偏差小于 1MB 不动：浮点噪声不值得触发一次全量同步
            if (Math.abs(oldSize - newSize) >= 1048576) {
                this.storage.setRepoUsage(owner, repo, newSize);
                fixed.push({ key: key, before: oldSize, after: newSize, delta: newSize - oldSize });
            }
        }
        return {
            fixed: fixed,
            beforeBytes: beforeBytes,
            afterBytes: afterBytes,
            freedBytes: Math.max(0, beforeBytes - afterBytes)
        };
    }

    /**
     * 移除幽灵记录。
     *
     * 幽灵 = VFS 里有记录、仓库里文件已不存在（下载必失败）。
     * 数据其实已经丢了，留着这条记录只会让人一点就报错，
     * 而且它还算在"已用容量"里。这里把整条文件记录删掉，让界面干净。
     *
     * ★ 只删 VFS 记录，不动仓库任何东西（本来也没东西可动）。
     *
     * @param {Array} ghosts - scan() 返回的 ghosts
     * @param {Object} opts - { dryRun }
     */
    async dropGhosts(ghosts, opts) {
        const o = opts || {};
        const list = (ghosts || []).filter(g => g && g.vpath);
        // 同一个虚拟路径可能缺多个分片，去重后再删
        const paths = Array.from(new Set(list.map(g => g.vpath)));
        if (!paths.length) return { would_remove: 0, removed: [], dryRun: !!o.dryRun };
        if (o.dryRun) return { would_remove: paths.length, removed: [], dryRun: true };

        const vfs = this.storage.getVFS();
        const removed = [];
        for (const p of paths) {
            if (vfs.files && vfs.files[p]) {
                delete vfs.files[p];
                removed.push(p);
            }
        }
        if (removed.length) this.storage.setVFS(vfs);
        return { would_remove: paths.length, removed: removed, dryRun: false };
    }

    /**
     * 系统文件：仓库自建时 GitHub 生成的、以及 Drive 自己的元数据。
     *
     * ★ 必须过滤。否则扫一遍就会把 README.md / .gitignore 报成"孤儿"，
     *   用户点一键清理就把仓库说明删了 —— 而且删了之后 autoInit
     *   不会再生成，仓库变成空的。
     */
    static isSystemFile(path) {
        const name = (path || '').substring((path || '').lastIndexOf('/') + 1);
        if (!name) return true;
        const sys = new Set([
            'readme.md', '.gitignore', 'license', 'licence', 'index.html',
            'status.js', 'share.json', 'vfs.json', 'config.json', '_config.yml'
        ]);
        return sys.has(name.toLowerCase());
    }

    /**
     * 彻底删除孤儿，释放仓库容量。（recover 是"只增不删"，purge 才是清理）
     *
     * ★ 用 tree API 一次提交删掉一批，不用 deleteFile 逐个删。
     *   逐个删是每个文件一次 commit（实测每笔固定 ~5.7 秒），
     *   45 个孤儿就是 4 分多钟；tree 一次提交只要几秒。
     *
     * ★ 删之前必须重新比对当前 VFS。
     *   扫描到点击之间用户可能又上传了文件，那份文件就不再是孤儿了。
     *   拿陈旧的孤儿列表去删会把刚传的文件删掉。
     *
     * @param {Array} orphans scan() 的结果
     * @param {{dryRun?:boolean, onProgress?:Function}} opts
     * @returns {Promise<{freed_bytes, deleted, skipped, failed, dryRun}>}
     */
    async purge(orphans, opts = {}) {
        const dryRun = !!opts.dryRun;
        const list = (orphans || []).filter(o => o && o.path && !Maintain.isSystemFile(o.path));
        const sysSkipped = (orphans || []).length - list.length;

        // ── 重新比对当前 VFS，剔除已经不再是孤儿的路径 ──
        const vfs = this.storage.getVFS();
        const live = new Set();
        for (const vpath of Object.keys(vfs.files || {})) {
            for (const ch of (vfs.files[vpath].chunks || [])) {
                live.add(ch.owner + '\u0000' + ch.repo + '\u0000' + ch.path);
            }
        }
        const stale = [];
        const todo = [];
        for (const o of list) {
            const key = o.owner + '\u0000' + o.repo + '\u0000' + o.path;
            if (live.has(key)) stale.push(o); else todo.push(o);
        }

        const freedBytes = todo.reduce((a, o) => a + (parseInt(o.size || 0, 10) || 0), 0);
        if (dryRun) {
            return { dryRun: true, would_delete: todo.length, freed_bytes: freedBytes,
                     skipped_stale: stale.length, skipped_system: sysSkipped, deleted: [], failed: [] };
        }

        // ── 按仓库分组，每组一次 tree + 一次 commit ──
        const byRepo = new Map();
        for (const o of todo) {
            const k = o.owner + '\u0000' + o.repo;
            if (!byRepo.has(k)) byRepo.set(k, { owner: o.owner, repo: o.repo, branch: o.branch || 'main', items: [] });
            byRepo.get(k).items.push(o);
        }

        const deleted = [];
        const failed = [];
        let gi = 0;
        const groups = Array.from(byRepo.values());

        for (const g of groups) {
            if (opts.onProgress) opts.onProgress(gi + 1, groups.length, g.owner + '/' + g.repo);
            try {
                const ref = await this.api.getRef(g.owner, g.repo, `heads/${g.branch}`);
                const cm = await this.api.getCommit(g.owner, g.repo, ref.object.sha);
                // ★ sha: null 就是删除。GitHub tree API 的约定。
                const tree = await this.api.createTree(g.owner, g.repo,
                    g.items.map(o => ({ path: o.path, mode: '100644', type: 'blob', sha: null })),
                    cm.tree.sha);
                const commit = await this.api.createCommit(g.owner, g.repo,
                    `清理 ${g.items.length} 个孤儿分片`, tree.sha, [ref.object.sha]);
                await this.api.updateRef(g.owner, g.repo, `heads/${g.branch}`, commit.sha);

                for (const o of g.items) {
                    deleted.push(o);
                    if (this.storage.subtractFromRepoUsage) {
                        this.storage.subtractFromRepoUsage(o.owner, o.repo, parseInt(o.size || 0, 10) || 0);
                    }
                }
            } catch (e) {
                for (const o of g.items) {
                    failed.push({ ...o, error: String(e && e.message || e) });
                }
            }
            gi++;
        }

        return {
            dryRun: false,
            deleted: deleted,
            failed: failed,
            freed_bytes: deleted.reduce((a, o) => a + (parseInt(o.size || 0, 10) || 0), 0),
            skipped_stale: stale.length,
            skipped_system: sysSkipped
        };
    }

    /**
     * 把孤儿转成 VFS 补丁。**不修改任何东西。**
     */
    buildPlan(orphans, targetDir) {
        targetDir = targetDir || MAINTAIN_RECOVER_DIR;
        const files = {};
        const skipped = [];
        const used = new Set();

        for (const o of (orphans || [])) {
            const path = o.path || '';
            const name = path.substring(path.lastIndexOf('/') + 1);
            if (!name || name.charAt(0) === '.') {
                skipped.push({ path: path, why: '空名或隐藏文件' });
                continue;
            }
            const size = parseInt(o.size || 0, 10) || 0;
            const final = dedupeName(name, used);
            const vpath = targetDir.replace(/\/$/, '') + '/' + final;
            const ts = new Date().toISOString();
            files[vpath] = {
                name: final,
                type: 'file',
                size: size,
                chunks: [{
                    owner: o.owner || '',
                    repo: o.repo || '',
                    path: path,
                    size: size,
                    sha: o.sha || '',
                    branch: o.branch || 'main'
                }],
                createdAt: ts,
                updatedAt: ts,
                recovered: true        // ★ 标记来源，便于用户识别与后续清理
            };
        }

        let folderEntry = null;
        if (Object.keys(files).length) {
            folderEntry = {
                name: targetDir.substring(targetDir.lastIndexOf('/') + 1),
                type: 'folder',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                recovered: true
            };
        }

        return {
            folder: targetDir,
            files: files,
            folder_entry: folderEntry,
            skipped: skipped
        };
    }

    /**
     * 应用补丁到 VFS。**仍然不写远端。**
     * 返回 {added, skipped, conflicts}
     */
    applyPlan(plan) {
        const vfs = this.storage.getVFS();
        const added = [];
        const conflicts = [];

        vfs.files = vfs.files || {};
        vfs.folders = vfs.folders || {};

        for (const vpath of Object.keys(plan.files || {})) {
            if (vfs.files[vpath]) {
                conflicts.push(vpath);      // ★ 已存在就跳过，绝不覆盖
                continue;
            }
            vfs.files[vpath] = plan.files[vpath];
            added.push(vpath);
        }

        if (added.length && plan.folder_entry) {
            if (!vfs.folders[plan.folder]) vfs.folders[plan.folder] = plan.folder_entry;
        }

        return {
            added: added,
            conflicts: conflicts,
            skipped: plan.skipped || [],
            vfs: vfs
        };
    }

    /** 一步到位：buildPlan + applyPlan */
    recover(orphans, targetDir) {
        return this.applyPlan(this.buildPlan(orphans, targetDir));
    }

    /**
     * 统计仓库真实占用（用于"存储优化"面板显示前后对比）
     */
    async usageSnapshot() {
        const repos = this.storage.getRepos() || [];
        const out = [];
        for (const r of repos) {
            try {
                const tree = await this.api.getTree(r.owner, r.repo, r.branch || 'main', true);
                const blobs = (tree && tree.tree ? tree.tree : []).filter(t => t.type === 'blob');
                const bytes = blobs.reduce((a, b) => a + (parseInt(b.size || 0, 10) || 0), 0);
                const cfg = this.storage.getStorageConfig ? this.storage.getStorageConfig() : {};
                const cap = cfg.maxRepoSize || 900 * 1024 * 1024;
                out.push({ owner: r.owner, repo: r.repo, bytes: bytes, cap: cap,
                           pct: cap ? Math.min(100, bytes / cap * 100) : 0 });
            } catch (e) {
                out.push({ owner: r.owner, repo: r.repo, bytes: 0, cap: 0, pct: 0, error: String(e && e.message || e) });
            }
        }
        return out;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Maintain: Maintain,
        shortenName: shortenName,
        dedupeName: dedupeName,
        MAINTAIN_RECOVER_DIR: MAINTAIN_RECOVER_DIR,
        BREADCRUMB_ROOT_LABEL: BREADCRUMB_ROOT_LABEL,
        BREADCRUMB_MAX: BREADCRUMB_MAX,
        BREADCRUMB_ELLIPSIS: BREADCRUMB_ELLIPSIS,
        BREADCRUMB_NAME_LIMIT: BREADCRUMB_NAME_LIMIT
    };
}
