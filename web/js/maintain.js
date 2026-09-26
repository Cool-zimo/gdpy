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
