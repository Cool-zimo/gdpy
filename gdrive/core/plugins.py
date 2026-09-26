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

from .config import app_dir

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
    'Cool-zimo/gdpy',          # 内置插件随主程序分发
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
)

# ★ 下载程序 —— 单独处理"下载即执行"
#
#   早期版本在 BLOCKED_PATTERNS 里写了 'curl|' / 'wget|'，
#   但真实命令是 `curl http://x | sh`（管道两侧有空格），
#   子串匹配根本匹配不到 —— 这条规则一直是失效的，
#   直到 test_webview 里加了这条断言才暴露出来。
#
#   正确判据：curl/wget 处在"非最后一段"的管道位置。
#   这样 `curl http://a.com`（单纯下载）仍然放行。
DOWNLOADERS = ('curl', 'wget')

# 命令分隔符 —— 用于切出"命令位置"
_SEPS = ('|', ';', '&&', '||', '\n')

# ★ 提权/包装命令 —— 这些后面跟的才是真正要执行的命令
#
#   这是个真实漏洞：早期版本只取每段的第一个 token 去比对
#   BLOCKED_COMMANDS，于是 `sudo shutdown -h now` 的第一个 token 是
#   'sudo'，不在黑名单里 → 放行。`sudo mkfs.ext4 /dev/sda1`、
#   `sudo parted /dev/sda`、`pkexec shutdown` 全都能过。
#
#   修法：把它们当成"透明前缀"穿透过去，检查它们后面那个命令。
#   注意 BLOCKED_PATTERNS 是子串匹配，所以 `sudo rm -rf /` 本来就被拦 ——
#   漏的只是 BLOCKED_COMMANDS 这一路（shutdown/reboot/mkfs/fdisk/parted/dd）。
PRIV_PREFIX = (
    'sudo', 'su', 'pkexec', 'doas', 'env', 'nice', 'nohup',
    'timeout', 'setsid', 'stdbuf', 'xargs',
)


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
        toks = low[st:].split()
        if not toks:
            continue
        j = 0
        # 跳过前导环境变量赋值（FOO=bar cmd）
        while j < len(toks) and '=' in toks[j] and not toks[j].startswith('-'):
            j += 1
        # ★ 穿透提权前缀，并检查被包装的那个命令本身
        #   同时把前缀自身也记为命令位置（万一以后把 sudo 加进黑名单）
        while j < len(toks) and toks[j] in PRIV_PREFIX:
            if j > 0 or True:
                pass
            j += 1
            # sudo -S / sudo -n / sudo -u root 这类参数要吃掉，
            # 否则 -u 后面的 'root' 会被当成命令名
            while j < len(toks) and toks[j].startswith('-'):
                j += 1
                # -u root / -g wheel 这种"带值参数"要再吃一个
                # ★ 注意 '-c' 不能算带值参数：sudo 没有 -c；
                #   而 su -c shutdown 里 -c 后面直接就是命令，
                #   若当带值吃掉，shutdown 就被跳过了。
                if j < len(toks) and toks[j - 1] in ('-u', '-g', '-C',
                                                     '-U', '-l'):
                    j += 1
        if j < len(toks):
            out.append(toks[j])
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
        # ★★ 授权文件绝不能放在插件目录里
        #
        #   早期版本是 user_plugin_dir()/grants.json —— 那正是插件安装目录。
        #   后果：插件只要申请到 fs:write（中风险，很容易获批），
        #   就能直接改写同目录的 grants.json，给自己加上 exec。
        #   实测可提权成功：授权 ['fs:read','fs:list','fs:write'] → 自改成含 'exec'。
        #
        #   移到 app_dir() 根目录，与 plugins/ 分离。
        self.path = path or os.path.join(app_dir(), 'grants.json')
        self.key_path = os.path.join(app_dir(), '.grant-key')
        self._lock = threading.RLock()
        self._data = self._load()

    # ---------- 完整性校验 ----------
    #
    # ★ 说明清楚这个校验能防什么、不能防什么：
    #   能防：随手篡改、不懂签名的修改、文件损坏 —— 篡改会被检测到并告警
    #   不能防：插件同时有 fs:read 时，它可以连密钥一起读走
    #
    #   根本事实：fs:read + fs:write 的插件本质上能做任何事。
    #   所以真正的防线是【授权时用户看清楚】，而不是事后校验。
    #   文档里必须写明：fs:write = 完全控制本机文件。
    def _key(self):
        try:
            with open(self.key_path, 'rb') as f:
                k = f.read()
            if len(k) >= 16:
                return k
        except Exception:
            pass
        import secrets
        k = secrets.token_bytes(32)
        d = os.path.dirname(self.key_path)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(self.key_path, 'wb') as f:
            f.write(k)
        return k

    def _sign(self, data):
        import hashlib
        import hmac as _hmac
        payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
        return _hmac.new(self._key(), payload.encode('utf-8'),
                         hashlib.sha256).hexdigest()

    def _load(self):
        """读授权记录；签名不符或损坏 → 视为全部未授权（保守方向）"""
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                blob = json.load(f)
        except Exception:
            return {}
        if not isinstance(blob, dict):
            return {}
        if 'data' not in blob:
            # ★ 老格式兼容：以前是扁平的 {plugin_id: [perms]}
            #   不迁移的话，升级后所有已授权插件都会变成未授权，
            #   用户会被迫重新授权一遍 —— 升级不该有这种代价。
            data = {k: v for k, v in blob.items() if isinstance(v, list)}
            # 迁移：下次 save 时自动带上签名
            if data:
                try:
                    self._save(data)
                except Exception:
                    pass
            return data
        data = blob.get('data')
        sig = blob.get('sig')
        if not isinstance(data, dict):
            return {}
        # 签名缺失（老文件）→ 兼容接受，但下次写入会补上签名
        if sig is not None and sig != self._sign(data):
            # ★ 篡改检测到：不能静默放行，也不能静默清空 —— 要让用户知道
            try:
                from .config import app_dir as _ad   # noqa: F401
                import time as _t
                with open(os.path.join(app_dir(), 'error.log'), 'a',
                          encoding='utf-8') as f:
                    f.write('%s [安全] 授权文件签名不符，已按未授权处理。'
                            '如非你自己修改，请检查插件目录\n'
                            % _t.strftime('%Y-%m-%d %H:%M:%S'))
            except Exception:
                pass
            return {}
        return data

    def _save(self, data):
        d = os.path.dirname(self.path)
        if d:
            os.makedirs(d, exist_ok=True)
        blob = {'data': data, 'sig': self._sign(data)}
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(blob, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def save(self):
        with self._lock:
            self._save(self._data)

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

    def __init__(self, plugin_id, grants, params=None):
        self.plugin_id = plugin_id
        self._grants = grants
        # 插件参数（由调用方传入）。约定为 dict，读不到键时用 .get() 取默认
        self.params = params or {}
        # 日志收集：插件不用自己 print，UI 侧拿不到
        self.logs = []
        # 进度：0.0 ~ 1.0，UI 侧可选显示
        self.progress_value = 0.0
        self.progress_text = ''

    def log(self, msg):
        """记一行日志（同时写进 error.log，方便排查）"""
        line = str(msg)
        self.logs.append(line)
        try:
            from ..util.log import elog
            elog('[plugin:%s] %s' % (self.plugin_id, line))
        except Exception:
            pass
        return line

    def progress(self, value, text=''):
        """上报进度。value 为 0.0~1.0"""
        try:
            self.progress_value = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            self.progress_value = 0.0
        self.progress_text = str(text or '')

    def param(self, key, default=None):
        return self.params.get(key, default)

    def require(self, perm):
        """显式声明要用的权限 —— 没授权就在这里炸，而不是用到一半才炸

        用于那些不走 read_file/write_file/exec 封装、
        直接 open() 的场景（比如只读文件头、流式拷贝大文件）。
        """
        self._grants.check(self.plugin_id, perm)
        return True

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


def _is_download_pipe(cmd):
    """下载即执行：curl/wget 后面还接着管道段

    例：curl http://x | sh      → 拦
        wget -O- http://x | bash → 拦
        curl http://a.com        → 放行（单纯下载）
    """
    segs = (cmd or '').split('|')
    if len(segs) < 2:
        return None
    for i, seg in enumerate(segs[:-1]):
        toks = seg.strip().lower().split()
        if not toks:
            continue
        # 跳过前导环境变量赋值（FOO=bar curl ...）
        j = 0
        while j < len(toks) and '=' in toks[j] and not toks[j].startswith('-'):
            j += 1
        # ★ 同样要穿透 sudo 等前缀，否则 `sudo curl http://x | sh` 会漏
        k = j
        while k < len(toks) and toks[k] in PRIV_PREFIX:
            k += 1
            while k < len(toks) and toks[k].startswith('-'):
                k += 1
        if k < len(toks) and toks[k] in DOWNLOADERS:
            return 'download-pipe(%s)' % toks[k]
    return None


def is_blocked(cmd):
    """返回命中的规则名，未命中返回 None"""
    low = (cmd or '').lower()
    # 1) 危险参数组合（子串匹配）
    for pat in BLOCKED_PATTERNS:
        if pat in low:
            return pat
    # 2) 下载即执行
    hit = _is_download_pipe(cmd)
    if hit:
        return hit
    # 3) 命令名（只在命令位置匹配）
    for tok in _command_positions(cmd):
        for name in BLOCKED_COMMANDS:
            if tok == name or tok.startswith(name + ' '):
                return name
    return None


# 兼容旧名
_is_blocked = is_blocked


class Plugin:
    def __init__(self, plugin_id, manifest, entry_path, builtin=False):
        self.id = plugin_id
        self.manifest = manifest or {}
        self.entry = entry_path
        # ★ 是否来自程序内置目录 —— 这是"官方"的唯一可信依据
        self.builtin = bool(builtin)

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
        """是否可信到"免弹窗自动授信"

        ★★ 判据是【是否在内置目录】，不是 manifest 里写的 repo 字段。

          早期版本只看 self.repo（manifest 自报的字符串）——
          那等于任何人都能在 plugin.json 里写
              "repo": "Cool-zimo/gdpy"
          就骗到自动全量授信，还不用弹一次窗。自动授信形同虚设。

          repo 字段只能用于"展示来源"，不能用于"决定是否授信"。
        """
        return self.builtin

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
        # ★ 顺序有意为之：先内置，后用户目录。
        #   用户目录里的同名插件会覆盖内置 —— 但它是 builtin=False，
        #   仍然要弹窗，覆盖不等于自动授信。
        for base, is_builtin in ((plugin_dir(), True),
                                 (user_plugin_dir(), False)):
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
                found[pid] = Plugin(pid, manifest, epath, builtin=is_builtin)
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

    def run(self, pid, params=None):
        """执行插件

        返回统一结构，方便 UI 展示：
            {'ok': True,  'result': 插件返回值, 'logs': [...], 'error': None}
            {'ok': False, 'result': None,       'logs': [...], 'error': '...'}

        ★ 插件抛异常不往外抛 —— UI 弹窗看不到 traceback，
          把消息收进 error 字段，日志留 ctx.logs。
        """
        plugin = self._plugins.get(pid)
        if plugin is None:
            raise RuntimeError('插件不存在：%s' % pid)
        ctx = PluginContext(pid, self.grants, params)
        try:
            r = plugin.run(ctx)
            return {'ok': True, 'result': r, 'logs': ctx.logs, 'error': None}
        except PermissionError as e:
            # 权限/安全策略拦截 —— 单独归类，UI 可以提示"去设置里授权"
            return {'ok': False, 'result': None, 'logs': ctx.logs,
                    'error': str(e), 'denied': True}
        except Exception as e:
            import traceback
            ctx.log(traceback.format_exc())
            return {'ok': False, 'result': None, 'logs': ctx.logs,
                    'error': '%s: %s' % (type(e).__name__, e)}
