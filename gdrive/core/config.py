"""
本地配置 + 存储配额记账

数据落地位置（跨平台）：
  Windows  %APPDATA%\\gdpy
  macOS    ~/Library/Application Support/gdpy
  Linux    ~/.config/gdpy      （或 $XDG_CONFIG_HOME）

★ 与 web 版的关系：
  跨端同步由 core/config_sync.py 负责（读写 github-drive-config/config.json）。
  本文件只是**本地缓存**，不是真实来源 —— 不要在这里找同步逻辑。

  ⚠️ 历史 bug：早期版本在 ui/app.py 里直接 put_file({'vfs': ...})，
  整体覆盖了网页版的 config.json，导致 repos/shares/repoUsage 等字段丢失。
  且网页版字段名是 fileIndex 不是 vfs，所以根本读不到。
  现在的规则：同步一律走 ConfigSync.push()（读-改-写），禁止整体覆盖。
"""
import json
import os
import sys
import threading

DEFAULT_CHUNK = 512 * 1024
DEFAULT_MIN_CHUNK = 10 * 1024 * 1024
DEFAULT_MAX_REPO = 900 * 1024 * 1024

# ★ 与 web 版线上 config.json 实测值对齐（不是 storage.js 的代码默认值）
#
#   线上真实值（2026-09-26 拉 github-drive-config 实测）:
#     chunkSize    = 524288      (512 KB)
#     minChunkSize = 10485760    (10 MB)   ←★
#
#   js/storage.js 的 getStorageConfig() 里两个都写 512KB，那是**代码默认**，
#   用户第一次保存设置后就被真实值覆盖了。**别照抄 js 默认值**。
#
#   差 20 倍的后果：minChunkSize 决定"多大的文件才分片"。
#   线上 10MB 意味着 512KB~10MB 的文件都是单片；桌面版若用 512KB，
#   这批文件会被切成 2~20 片 —— 与既有文件形态不一致，且多吃 20 倍 API 配额。
DEFAULT_STORAGE_CONFIG = {
    'maxRepoSize': DEFAULT_MAX_REPO,
    'autoCreateRepo': True,
    'repoNamePrefix': 'drive-storage',
    'warnThreshold': 0.8,
    'chunkSize': DEFAULT_CHUNK,
    'minChunkSize': DEFAULT_MIN_CHUNK,
    'configVersion': 2,
}

# ★ 桌面版禁止写入的字段
#
#   storageConfig 是**网页版用户的既有设置**（含用户自己调过的分片策略）。
#   桌面版改它 = 改掉用户的选择，且没有任何提示。
#   历史教训：config_sync 曾整体覆盖 config.json，把网页版配置清光。
#   现在虽然改成读-改-写，但仍有"写全量 storageConfig"的路径，必须封死。
READONLY_CONFIG_KEYS = ('storageConfig',)

# 旧版本遗留的 chunkSize 值 —— 命中就迁移到 512KB
# （与 web 版 storage.js 的迁移分支一一对应）
LEGACY_CHUNK_SIZES = (
    50 * 1024 * 1024,
    20 * 1024 * 1024,
    5 * 1024 * 1024,
)


def app_dir():
    """跨平台配置目录"""
    if sys.platform.startswith('win'):
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
    elif sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support')
    else:
        base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    path = os.path.join(base, 'gdpy')
    os.makedirs(path, exist_ok=True)
    return path


class Config:
    """线程安全的本地配置（Tkinter 后台线程会读写）"""

    def __init__(self, path=None):
        self.path = path or os.path.join(app_dir(), 'config.json')
        self._lock = threading.RLock()
        self._data = self._load()

    # ---------- 持久化 ----------
    def _load(self):
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
        except (IOError, OSError, ValueError):
            pass
        return {}

    def save(self):
        with self._lock:
            tmp = self.path + '.tmp'
            try:
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(self._data, f, ensure_ascii=False, indent=2)
                os.replace(tmp, self.path)
            except (IOError, OSError) as e:
                # 原子写失败不能崩，但必须让用户知道
                raise IOError('配置保存失败：%s' % e)

    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, default)

    def set(self, key, value):
        with self._lock:
            self._data[key] = value
        return value

    def remove(self, key):
        with self._lock:
            self._data.pop(key, None)

    # ---------- 令牌 ----------
    @property
    def token(self):
        return self.get('token', '')

    @token.setter
    def token(self, v):
        self.set('token', v)
        self.save()

    # ---------- 账号 ----------
    @property
    def owner(self):
        return self.get('owner', '')

    @owner.setter
    def owner(self, v):
        self.set('owner', v)
        self.save()

    def accounts(self):
        return self.get('accounts', [])

    def add_account(self, login, token):
        """多账号：同一 login 只保留一条"""
        accs = self.accounts()
        for a in accs:
            if a.get('login') == login:
                a['token'] = token
                self.set('accounts', accs)
                self.save()
                return a
        accs.append({'login': login, 'token': token})
        self.set('accounts', accs)
        self.save()
        return accs[-1]

    def remove_account(self, login):
        accs = [a for a in self.accounts() if a.get('login') != login]
        self.set('accounts', accs)
        self.save()

    # ---------- 存储配置 ----------
    def storage_config(self):
        saved = self.get('storageConfig')
        cfg = dict(DEFAULT_STORAGE_CONFIG)
        if isinstance(saved, dict):
            cfg.update(saved)
        # ★ 迁移：旧 chunkSize 一律拉回 512KB
        if cfg.get('chunkSize') in LEGACY_CHUNK_SIZES:
            cfg['chunkSize'] = DEFAULT_CHUNK
        # 补齐缺失字段
        for k, v in DEFAULT_STORAGE_CONFIG.items():
            if cfg.get(k) is None:
                cfg[k] = v
        return cfg

    def set_storage_config(self, cfg):
        """★ 只允许改本地缓存，禁止同步回远端

        远端 storageConfig 归网页版所有（用户在网页上调过分片策略）。
        桌面版若写回去，会静默改掉用户设置 —— 见 READONLY_CONFIG_KEYS。
        """
        if not isinstance(cfg, dict):
            raise ValueError('storageConfig 必须是 dict')
        # 本地只保留已知键，避免把脏数据带进后续计算
        clean = {k: v for k, v in cfg.items()
                 if k in DEFAULT_STORAGE_CONFIG}
        merged = dict(DEFAULT_STORAGE_CONFIG)
        merged.update(clean)
        self.set('storageConfig', merged)
        self.save()

    def writable_config_keys(self):
        """可同步回远端的字段白名单 —— 不含 READONLY_CONFIG_KEYS"""
        return [k for k in ('repos', 'fileIndex', 'vfs', 'repoUsage',
                            'shares', 'starred', 'recent')
                if k not in READONLY_CONFIG_KEYS]

    # ---------- 仓库列表 ----------
    def repos(self):
        return self.get('repos', [])

    def add_repo(self, owner, repo, branch='main', is_default=False):
        repos = self.repos()
        for r in repos:
            if r.get('owner') == owner and r.get('repo') == repo:
                return r
        if is_default or not repos:
            for r in repos:
                r['isDefault'] = False
        repos.append({'owner': owner, 'repo': repo, 'branch': branch,
                      'isDefault': bool(is_default or not repos)})
        self.set('repos', repos)
        self.save()
        return repos[-1]

    def remove_repo(self, owner, repo):
        repos = [r for r in self.repos()
                 if not (r.get('owner') == owner and r.get('repo') == repo)]
        self.set('repos', repos)
        self.save()

    def default_repo(self):
        for r in self.repos():
            if r.get('isDefault'):
                return r
        return self.repos()[0] if self.repos() else None

    # ---------- 容量记账 ----------
    def usage(self):
        return self.get('repoUsage', {})

    def add_usage(self, owner, repo, nbytes):
        u = self.usage()
        key = '%s/%s' % (owner, repo)
        u[key] = u.get(key, 0) + int(nbytes)
        self.set('repoUsage', u)

    def sub_usage(self, owner, repo, nbytes):
        u = self.usage()
        key = '%s/%s' % (owner, repo)
        # ★ 不能扣成负数 —— 记账错乱会让"仓库已满"的判断失真
        u[key] = max(0, u.get(key, 0) - int(nbytes))
        self.set('repoUsage', u)

    def set_usage(self, owner, repo, nbytes):
        u = self.usage()
        u['%s/%s' % (owner, repo)] = int(nbytes)
        self.set('repoUsage', u)

    # ---------- VFS 缓存 ----------
    def vfs(self):
        return self.get('vfs', {'files': {}, 'folders': {}})

    def set_vfs(self, vfs):
        self.set('vfs', vfs)
        self.save()

    # ---------- 分享记录（本地元信息） ----------
    def shares(self):
        return self.get('shares', [])

    def add_share(self, info):
        s = self.shares()
        for i, x in enumerate(s):
            if x.get('repoName') == info.get('repoName'):
                s[i] = info
                self.set('shares', s)
                self.save()
                return
        s.append(info)
        self.set('shares', s)
        self.save()

    def remove_share(self, repo_name):
        s = [x for x in self.shares() if x.get('repoName') != repo_name]
        self.set('shares', s)
        self.save()
