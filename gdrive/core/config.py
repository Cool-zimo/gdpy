"""
本地配置 + 存储配额记账

数据落地位置（跨平台）：
  Windows  %APPDATA%\\gdpy
  macOS    ~/Library/Application Support/gdpy
  Linux    ~/.config/gdpy      （或 $XDG_CONFIG_HOME）

★ 与 web 版的关系：
  web 版把 VFS 存 localStorage，并通过 github-drive-config 仓库跨设备同步。
  本程序直接以「配置仓库」为真实来源，本地 JSON 只是缓存 ——
  这样在网页版上传的文件，桌面版打开就能看见，反之亦然。
"""
import json
import os
import sys
import threading

DEFAULT_CHUNK = 512 * 1024
DEFAULT_MAX_REPO = 900 * 1024 * 1024

# 与 web 版 js/storage.js getStorageConfig() 的默认值保持一致
DEFAULT_STORAGE_CONFIG = {
    'maxRepoSize': DEFAULT_MAX_REPO,
    'autoCreateRepo': True,
    'repoNamePrefix': 'drive-storage',
    'warnThreshold': 0.8,
    'chunkSize': DEFAULT_CHUNK,
    'minChunkSize': DEFAULT_CHUNK,
    'configVersion': 2,
}

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
        self.set('storageConfig', cfg)
        self.save()

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
