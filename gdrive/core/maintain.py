"""
仓库维护工具：孤儿清理 / 记账校准 / 僵尸条目清理

★ 为什么需要这个模块（线上数据核验的结果，2026-09-26 实测）：

    VFS 记录的文件总量        77.0 MB
    4 个存储仓实际 blob 总量  133.3 MB
    ★ 孤儿数据（无 VFS 记录） 56.2 MB —— 占 42%

  这些孤儿界面上看不到、下载不了，但一直占容量和仓库配额。

★ 三个概念必须分清：

    孤儿 orphan  —— 物理存在（仓库里有 blob），但 VFS 没有记录
                    后果：占容量、拿不回来。只能靠本模块发现。
    幽灵 ghost   —— VFS 有记录，但物理不存在
                    后果：下载必失败，且失败前看不出来。
    偏差 drift   —— 记账与实际不符
                    ★ 低估比虚高危险：pick_repo 靠记账判断剩余空间，
                      低估会让它持续往一个已满的仓库写，且不报错。

★ 本模块全部是**只读扫描 + 生成计划**，不直接删任何东西。
  删除必须由用户确认后单独调用，且逐条列出。
  理由：删错了不可逆（GitHub API 不能真删历史）。
"""
import time

from .config import READONLY_CONFIG_KEYS

# 扫描时忽略的文件（仓库自身的说明文件，不是分片）
IGNORE_BLOBS = ('README.md', '.gitignore', 'index.html', '_config.yml')


class Maintain:
    """仓库维护

    api   : core.api.Api 实例
    owner : 账号名
    """

    def __init__(self, api, owner=''):
        self.api = api
        self.owner = owner

    # ------------------------------------------------------------------
    # 1. 列出所有 blob
    # ------------------------------------------------------------------
    def list_blobs(self, owner, repo, branch='main', ignore=frozenset(IGNORE_BLOBS)):
        """列出仓库里所有 blob。返回 [(path, size)]

        ★ 用 Git tree API（recursive=1），不是 Contents API：
          Contents API 一次只能列一层，递归要 N 次请求；
          tree API 一次拿全，且能直接拿到 size。
        """
        # ★ 不吞异常：历史上这里写成 `except: return []`，
        #   结果网络一抖 / 仓库无权限，就表现为"这个仓库是空的"——
        #   调用方拿到空列表，既不报错也不重试，用户看到的是凭空少了一堆文件。
        #   现在让异常抛出，由 scan() 捕获并记进 errors。
        data = self.api._req('GET',
                             '/repos/%s/%s/git/trees/%s?recursive=1'
                             % (owner, repo, branch))
        if not isinstance(data, dict):
            raise ValueError('%s/%s 返回的 tree 不是 dict' % (owner, repo))
        # ★ truncated=True 表示结果被截断，必须让调用方知道
        #   否则会误判"孤儿"（其实只是没列全）
        out = []
        for item in data.get('tree', []):
            if item.get('type') != 'blob':
                continue
            path = item.get('path', '')
            base = path.rsplit('/', 1)[-1]
            if base in ignore:
                continue
            out.append((path, int(item.get('size', 0) or 0)))
        return out, bool(data.get('truncated'))

    # ------------------------------------------------------------------
    # 2. 孤儿 / 幽灵
    # ------------------------------------------------------------------
    def scan(self, vfs, repos, progress=None):
        """扫描全部存储仓，返回完整报告 dict

        vfs   : VFS dict（{'files': {...}, 'folders': {...}}）
        repos : [{'owner','repo','branch'}]

        返回：
          {
            'orphans': [{'owner','repo','path','size'}],   # 物理有、VFS 无
            'ghosts' : [{'owner','repo','path'}],          # VFS 有、物理无
            'usage_actual': {'owner/repo': bytes},
            'truncated': [repo],                           # 结果被截断的仓库
            'errors': [{'repo', 'error'}],
          }
        """
        # 先收集 VFS 里记录的所有分片
        recorded = {}
        for path, info in (vfs.get('files') or {}).items():
            for ch in (info.get('chunks') or []):
                key = (ch.get('owner'), ch.get('repo'), ch.get('path'))
                recorded[key] = int(ch.get('size', 0) or 0)

        orphans, ghosts = [], []
        usage_actual, truncated, errors = {}, [], []
        # ★ 一次扫完所有仓库，blob 留在内存里
        #   幽灵检测要反查 path，不缓存的话每个文件都要重扫一遍仓库
        blobmap = {}          # (owner, repo) -> {path: size}

        repo_keys = set()
        for r in repos:
            repo_keys.add((r.get('owner'), r.get('repo')))
        # VFS 里引用了、但不在 repos 列表里的仓库也要扫
        for (o, rp, _p) in recorded:
            repo_keys.add((o, rp))

        total = len(repo_keys)
        for i, (o, rp) in enumerate(sorted(repo_keys)):
            if progress:
                progress(i + 1, total, '%s/%s' % (o, rp))
            branch = 'main'
            for r in repos:
                if r.get('owner') == o and r.get('repo') == rp:
                    branch = r.get('branch') or 'main'
                    break
            try:
                got = self.list_blobs(o, rp, branch)
            except Exception as e:
                errors.append({'repo': '%s/%s' % (o, rp), 'error': str(e)})
                continue
            if not got:
                continue
            blobs, trunc = got
            if trunc:
                truncated.append('%s/%s' % (o, rp))
            m = dict(blobs)
            blobmap[(o, rp)] = m
            for path, size in blobs:
                if (o, rp, path) not in recorded:
                    orphans.append({'owner': o, 'repo': rp,
                                    'path': path, 'size': size})
            usage_actual['%s/%s' % (o, rp)] = sum(m.values())

        # 幽灵：VFS 有记录、物理不存在 —— 下载必失败，且不报错
        for (o, rp, path) in recorded:
            m = blobmap.get((o, rp))
            if m is None:
                continue          # 仓库扫不到，无法判定，不误报
            if path not in m:
                ghosts.append({'owner': o, 'repo': rp, 'path': path})

        return {
            'orphans': orphans,
            'ghosts': ghosts,
            'usage_actual': usage_actual,
            'truncated': truncated,
            'errors': errors,
            'orphan_bytes': sum(o['size'] for o in orphans),
        }

    # ------------------------------------------------------------------
    # 3. 记账校准
    # ------------------------------------------------------------------
    def reconcile_usage(self, usage_recorded, usage_actual):
        """记账 vs 实际，返回差异列表（按偏差绝对值降序）

        ★ 只返回差异，不修改任何东西。调用方决定要不要覆盖。
        """
        keys = set(usage_recorded) | set(usage_actual)
        out = []
        for k in sorted(keys):
            rec = int(usage_recorded.get(k, 0) or 0)
            act = int(usage_actual.get(k, 0) or 0)
            out.append({
                'repo': k,
                'recorded': rec,
                'actual': act,
                'drift': rec - act,
                # ★ 低估 = 危险：会让 pick_repo 往已满仓库继续写
                'dangerous': (rec - act) < 0,
            })
        out.sort(key=lambda x: -abs(x['drift']))
        return out

    # ------------------------------------------------------------------
    # 4. 僵尸记账条目
    # ------------------------------------------------------------------
    def find_zombie_usage(self, usage_recorded, repos):
        """记账里有、但仓库已不在 repos 列表里的条目

        实测：repoUsage 有 10 条、repos 只有 5 条，
        差的 5 条全是 Feng-zimo 的存储仓（已不可见）。
        金额都是 0，不影响容量，但每次同步都要传输。
        """
        live = set('%s/%s' % (r.get('owner'), r.get('repo')) for r in repos)
        return [{'repo': k, 'size': int(v if isinstance(v, int) else
                                        (v or {}).get('size', 0) or 0)}
                for k, v in usage_recorded.items() if k not in live]

    # ------------------------------------------------------------------
    # 5. 生成清理计划（不执行）
    # ------------------------------------------------------------------
    def plan_purge(self, report, keep_recent_days=0):
        """把孤儿转成删除计划。**不执行删除。**

        ★ 默认不删任何东西。理由：
          1. GitHub API 不能真删数据，删了仍在 Git 历史里
          2. 误删不可逆 —— 孤儿判定依赖 VFS 完整性，VFS 本身可能就是残缺的
        """
        cutoff = None
        if keep_recent_days > 0:
            cutoff = time.time() - keep_recent_days * 86400
        plan = []
        for o in report.get('orphans', []):
            plan.append({
                'owner': o['owner'], 'repo': o['repo'],
                'path': o['path'], 'size': o['size'],
                'action': 'delete',
            })
        return plan


def normalize_usage(usage):
    """{key: int | {'size': int}} → {key: int}

    ★ web 版 repoUsage 的值是 {'size': n, 'updatedAt': ...}，
      桌面版历史格式是裸 int。两种都要认，否则加起来会 TypeError。
    """
    out = {}
    for k, v in (usage or {}).items():
        if isinstance(v, dict):
            out[k] = int(v.get('size', 0) or 0)
        else:
            out[k] = int(v or 0)
    return out


def assert_no_readonly_write(cfg_before, cfg_after):
    """★ 防复发断言：只读字段不能在同步过程中被改写

    放在 config_sync.push 之后调用，确保 storageConfig 等字段原样保留。
    """
    changed = []
    for k in READONLY_CONFIG_KEYS:
        if cfg_before.get(k) != cfg_after.get(k):
            changed.append(k)
    if changed:
        raise AssertionError('只读字段被改写：%s' % ', '.join(changed))
    return True
