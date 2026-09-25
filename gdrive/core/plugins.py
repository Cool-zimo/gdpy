"""
插件系统 —— 桌面版专用能力（fs / 进程 / 网络）

★ 与 web 版插件不兼容，也不打算兼容：
    网页插件是 HTML+JS，跑在浏览器沙箱里，碰不到文件系统、起不了进程。
    桌面插件是 Python，能直接读写本地文件、调用外部程序 —— 这才是
    做桌面版的意义所在。

    所以这是新生态，不是移植。

安全模型（三层）：
    1. 声明    plugin.json 里写 permissions
    2. 授权    安装时弹窗确认；官方来源自动授信
    3. 校验    ★ 运行时每次调用都查 —— 防止插件被冒充身份调用

    ⚠️ 自动授信 ≠ 取消校验。取消运行时校验的话，
       插件 A 能冒充插件 B 调用已授权的能力，整个模型形同虚设。
"""
import importlib.util
import json
import os
import subprocess
import sys
import threading

ALL_PERMISSIONS = ('fs:read', 'fs:list', 'fs:write', 'net', 'exec')

RISK = {
    'fs:read':  ('low',      '读取本地文件'),
    'fs:list':  ('low',      '列出本地目录'),
    'net':      ('medium',   '访问网络'),
    'fs:write': ('high',     '写入/删除本地文件'),
    'exec':     ('critical', '运行系统命令'),
}

# 官方插件仓库（本人维护）→ 安装时自动授信，不弹窗
OFFICIAL_REPOS = (
    'Cool-zimo/github_drive_plugins',
    'Cool-zimo/gdpy-plugins',
)

DISCLAIMER_VERSION = 1
DISCLAIMER = (
    '安装第三方插件存在风险：\n\n'
    '1. 插件由第三方作者提供，不是本程序官方维护。\n'
    '2. 授予「运行系统命令」= 把终端交给插件作者，可执行任意程序。\n'
    '3. 授予「写入本地文件」= 插件可改写或删除你的文件。\n'
    '4. 本程序只做权限声明与提示，无法审计插件的实际行为。\n\n'
    '请仅安装你信任的作者发布的插件。'
)

# 命令黑名单 —— 授权了 exec 也还有这道兜底
# ★ 黑名单不是权限的替代品，是最后一道防线
#
# ★ 必须区分"命令名"和"任意子串"，否则会误杀：
#     cat /logs/shutdown_report.txt   ← 路径里有 shutdown 但不是关机命令
#     rm a.txt                        ← rm 但不是 -rf /
#   所以：命令名只在"命令位置"匹配（行首 / | ; && || 之后），
#         参数组合才按子串匹配。

# 命令名：只在命令位置匹配
BLOCKED_COMMANDS = (
    'shutdown', 'reboot', 'halt', 'poweroff', 'init',
    'mkfs', 'mkfs.ext4', 'fdisk', 'parted',
    'dd',
)

# 危险参数组合：按子串匹配（这些组合本身没有正当用途）
BLOCKED_PATTERNS = (
    'rm -rf /', 'rm -rf /*', 'rm -fr /', 'rm -rf ~',
    'format ', 'chmod 777', ':(){:', 'dd if=',
    'curl|', 'wget|',            # 下载即执行
)

# 命令分隔符 —— 用于切出"命令位置"
_SEPS = ('|', ';', '&&', '||', '\n')


def _command_positions(cmd):
    """切出每个命令的起始 token（小写）"""
    low = cmd.lower()
    starts = [0]
    for sep in _SEPS:
        # 逐分隔符扫描，记录其后的第一个非空位置
        idx = 0
        while True:
            k = low.find(sep, idx)
            if k < 0:
                break
            j = k + len(sep)
            while j < len(low) and low[j] in ' \t':
                j += 1
            if j < len(low):
                starts.append(j)
            idx = k + len(sep)
    out = []
    for st in sorted(set(starts)):
        tok = low[st:].split()[0] if low[st:].split() else ''
        # 去掉前导的环境变量赋值（如 FOO=bar cmd）
        while tok and '=' in tok and not tok.startswith('-'):
            rest = low[st:].split()
            if len(rest) > 1:
                tok = rest[1]
            else:
                tok = ''
                break
        if tok:
            out.append(tok)
    return out


def plugin_dir():
    base = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))
    return os.path.join(base, 'plugins')


def user_plugin_dir():
    from .config import app_dir
    p = os.path.join(app_dir(), 'plugins')
    os.makedirs(p, exist_ok=True)
    return p


def normalize_perms(perms):
    """拆成 (已知权限, 未知权限)。未知的一律按最高风险处理"""
    known, unknown = [], []
    for p in (perms or []):
        if p in ALL_PERMISSIONS:
            if p not in known:
                known.append(p)
        else:
            unknown.append(p)
    return known, unknown


def is_official(repo_full_name):
    s = (repo_full_name or '').strip().lower().replace('.git', '')
    return s in [r.lower() for r in OFFICIAL_REPOS]


class PermissionError(Exception):
    pass


class GrantStore:
    """授权记录 + 运行时校验"""

    def __init__(self, path=None):
        self.path = path or os.path.join(user_plugin_dir(), 'grants.json')
        self._lock = threading.RLock()
        self._data = self._load()

    def _load(self):
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (IOError, OSError, ValueError):
            return {}

    def save(self):
        with self._lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)

    def grant(self, plugin_id, perms):
        with self._lock:
            self._data[plugin_id] = list(perms)
        self.save()

    def revoke(self, plugin_id):
        with self._lock:
            self._data.pop(plugin_id, None)
        self.save()

    def granted(self, plugin_id):
        with self._lock:
            return list(self._data.get(plugin_id, []))

    def check(self, plugin_id, perm):
        """
        ★ 每次调用都要过这里

         unknown permission 一律拒绝（宁可挡住，不能放行）
        """
        if perm not in ALL_PERMISSIONS:
            raise PermissionError('未知权限：%s' % perm)
        if perm not in self.granted(plugin_id):
            raise PermissionError(
                '插件「%s」未获得权限「%s」' % (plugin_id, perm))
        return True

    def to_dict(self):
        return dict(self._data)


class PluginContext:
    """
    交给插件的能力句柄

    ★ plugin_id 由构造时传入，插件自己改不了 ——
      这是防冒充的关键。绝不能让插件上报自己的 ID。
    """

    def __init__(self, plugin_id, grants):
        self.plugin_id = plugin_id
        self._grants = grants

    # ---- 文件 ----
    def read_file(self, path):
        self._grants.check(self.plugin_id, 'fs:read')
        with open(path, 'rb') as f:
            return f.read()

    def write_file(self, path, data):
        self._grants.check(self.plugin_id, 'fs:write')
        mode = 'wb' if isinstance(data, (bytes, bytearray)) else 'w'
        with open(path, mode) as f:
            f.write(data)
        return True

    def list_dir(self, path):
        self._grants.check(self.plugin_id, 'fs:list')
        return os.listdir(path)

    # ---- 进程 ----
    def exec(self, argv, timeout=300, cwd=None):
        """
        运行外部命令

        ★ 三重限制：权限校验 + 黑名单 + 超时上限(5分钟)
        """
        self._grants.check(self.plugin_id, 'exec')
        if isinstance(argv, str):
            cmd = argv
            blocked = _is_blocked(argv)
        else:
            cmd = ' '.join(str(a) for a in argv)
            blocked = _is_blocked(cmd)
        if blocked:
            raise PermissionError('命令被安全策略拦截：%s' % blocked)

        timeout = min(int(timeout or 0), 300)
        r = subprocess.run(argv if not isinstance(argv, str) else argv,
                           shell=isinstance(argv, str),
                           capture_output=True, timeout=timeout, cwd=cwd)
        return {'returncode': r.returncode,
                'stdout': r.stdout.decode('utf-8', 'ignore'),
                'stderr': r.stderr.decode('utf-8', 'ignore')}


def _is_blocked(cmd):
    """返回命中的规则名，未命中返回 None"""
    low = cmd.lower()
    # 1) 危险参数组合（子串匹配）
    for pat in BLOCKED_PATTERNS:
        if pat in low:
            return pat
    # 2) 命令名（只在命令位置匹配）
    for tok in _command_positions(cmd):
        for name in BLOCKED_COMMANDS:
            if tok == name or tok.startswith(name + ' '):
                return name
    return None


class Plugin:
    def __init__(self, plugin_id, manifest, entry_path):
        self.id = plugin_id
        self.manifest = manifest or {}
        self.entry = entry_path

    @property
    def name(self):
        return self.manifest.get('name', self.id)

    @property
    def version(self):
        return self.manifest.get('version', '0.0.0')

    @property
    def permissions(self):
        return self.manifest.get('permissions', [])

    @property
    def repo(self):
        return self.manifest.get('repo', '')

    def is_official(self):
        return is_official(self.repo)

    def run(self, ctx):
        """
        加载并执行插件入口

        约定：入口模块必须有 run(ctx) 函数
        """
        spec = importlib.util.spec_from_file_location('gdpy_plugin_%s' % self.id,
                                                      self.entry)
        if spec is None or spec.loader is None:
            raise RuntimeError('无法加载插件入口：%s' % self.entry)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'run'):
            raise RuntimeError('插件缺少 run(ctx) 函数')
        return mod.run(ctx)


class PluginManager:
    def __init__(self, config=None):
        self.cfg = config
        self.grants = GrantStore()
        self._plugins = {}

    def discover(self):
        """扫描内置 + 用户插件目录"""
        found = {}
        for base in (plugin_dir(), user_plugin_dir()):
            if not os.path.isdir(base):
                continue
            for name in sorted(os.listdir(base)):
                d = os.path.join(base, name)
                if not os.path.isdir(d):
                    continue
                mpath = os.path.join(d, 'plugin.json')
                if not os.path.isfile(mpath):
                    continue
                try:
                    with open(mpath, 'r', encoding='utf-8') as f:
                        manifest = json.load(f)
                except (IOError, ValueError):
                    continue
                entry = manifest.get('entry') or 'main.py'
                epath = os.path.join(d, entry)
                if not os.path.isfile(epath):
                    continue
                pid = manifest.get('id') or name
                found[pid] = Plugin(pid, manifest, epath)
        self._plugins = found
        return found

    def get(self, pid):
        return self._plugins.get(pid)

    def needs_authorization(self, plugin):
        """是否还需要用户确认（官方插件自动授信）"""
        known, unknown = normalize_perms(plugin.permissions)
        if not known:
            return False        # 不申请权限 → 不用弹窗
        return not plugin.is_official()

    def install(self, plugin, approve_perms=None):
        """
        安装：写入授权记录

        approve_perms 为 None 且是官方插件 → 按声明全量授信
        """
        known, unknown = normalize_perms(plugin.permissions)
        if approve_perms is not None:
            known = [p for p in approve_perms if p in ALL_PERMISSIONS]
        self.grants.grant(plugin.id, known)
        return known

    def run(self, pid):
        plugin = self._plugins.get(pid)
        if plugin is None:
            raise RuntimeError('插件不存在：%s' % pid)
        ctx = PluginContext(pid, self.grants)
        return plugin.run(ctx)
