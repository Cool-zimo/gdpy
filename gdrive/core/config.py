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

# ★★ 这里**故意不定义**任何业务默认值
#
#   曾经这里有一整套 DEFAULT_STORAGE_CONFIG（chunkSize / minChunkSize /
#   maxRepoSize…），是"契约的 Python 副本"。为此付过代价：
#
#     minChunkSize 差 20 倍 —— Python 写 512KB，线上真实值是 10MB
#     （用户在网页版保存设置时写进 config.json 的）。
#     桌面版一写回 config.json，就把用户的分片策略改掉了。
#
#   教训：**Python 不该持有"应该是什么"的意见，只该读取"现在是什么"。**
#
#   → 需要契约值时从线上 config.json 读（core/config_sync.py）
#   → 读不到就报错，绝不用本地默认值兜底
#   → 纯格式约定（路径前缀 / base36 编码）在 core/contract.py
#
# ★ 桌面版禁止写入的远端字段
#
#   storageConfig 是**网页版用户的既有设置**（含用户自己调过的分片策略）。
#   桌面版改它 = 改掉用户的选择，且没有任何提示。
#   历史教训：config_sync 曾整体覆盖 config.json，把网页版配置清光。
#   现在虽然改成读-改-写，但仍有"写全量 storageConfig"的路径，必须封死。
READONLY_CONFIG_KEYS = ('storageConfig',)

#   ★ 想往这个文件里加 DEFAULT_ 常量时，先问：
#     这个值线上是多少？我在定义它，还是在读取它？
#     如果是定义 —— 那就是在制造下一处漂移。


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

    # ★ 曾经这里有 storage_config() / set_storage_config()，
    #   会用 DEFAULT_STORAGE_CONFIG 补齐默认值、做 chunkSize 迁移。
    #   那是"契约副本"的藏身处：Python 在这里定义了"分片策略应该是什么"。
    #   已删除 —— 无人调用，且语义错误（远端 storageConfig 归网页版所有）。
    #
    #   现在要读分片策略：从线上 config.json 读（config_sync 读-改-写）。
    #   要写：不写（READONLY_CONFIG_KEYS 封死）。

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
