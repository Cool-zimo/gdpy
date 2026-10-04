"""
暴露给 JS 的 Python 能力（pywebview js_api）

★ 线程规则：
  pywebview 的 js_api 方法在**独立线程**执行，不在主线程。
  所以这里不能碰 GUI（窗口控件）；文件对话框是例外 ——
  用 pywebview 自己的 create_file_dialog，它是线程安全的。

★ 安全：
  exec_command 默认关闭。打开后仍走命令黑名单 ——
  黑名单不是权限的替代品，是最后一道防线。
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from ..core.api import _ascii_safe
from . import netpool

DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 300

# 网络层失败的重试次数（不含 netpool 内部那次连接重建）
HTTP_RETRIES = 3

# 全局连接池 —— 跨请求复用 TCP/TLS
_POOL = netpool._Pool()

# 允许被代理的域名 —— 其余一律拒绝，避免变成任意 HTTP 代理
#
# ★ localhost / 127.0.0.1 为什么在这里：
#   设置里的「后端服务管理」会 fetch http://localhost:8787/api/status。
#   桌面页 origin 是 http://127.0.0.1:<随机端口>，端口不同即跨源，
#   会被 shim 转到这里；不放到白名单就是 status 0 —— 面板永远显示"未运行"。
#   走桥还有个好处：Python 发请求不受 CORS 限制。
#
#   风险可控：只能访问用户自己机器上的端口，且页面本身是我们打包进去的。
#   云元数据地址（169.254.169.254）不在其中，仍然拒绝。
ALLOWED_HOSTS = (
    'api.github.com',
    'raw.githubusercontent.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'codeload.github.com',
    'cool-zimo.github.io',
    'api.qrserver.com',
    'ghproxy.com',
    'ghproxy.net',
    'localhost',
)

# 只认这几个本机地址，避免把整个 127.0.0.0/8 放开
_LOCAL_HOSTS = ('localhost', '127.0.0.1', '[::1]', '::1')


def _host_of(url):
    try:
        from urllib.parse import urlsplit
        return (urlsplit(url).hostname or '').lower()
    except Exception:
        return ''


def _host_allowed(url):
    """后缀匹配，覆盖子域（如 ghproxy.net 的镜像节点）

    127.0.0.1 单独判：它在 ALLOWED_HOSTS 里写不进去 ——
    `h.endswith('.127.0.0.1')` 毫无意义，只能精确匹配。
    """
    h = _host_of(url)
    if not h:
        return False
    if h in _LOCAL_HOSTS:
        return True
    for a in ALLOWED_HOSTS:
        if h == a or h.endswith('.' + a):
            return True
    return False


def blocked_reason(cmd):
    """返回拦截原因，不被拦截返回 None

    ★★ 判据必须复用 plugins.is_blocked()，绝不自己再写一份。

      早期这里有一份"看起来一样"的实现，实际两处不一致：
        - 环境变量赋值：plugins 会跳过 FOO=bar，这里不会
          → `FOO=bar shutdown` plugins 拦、这里放行
        - 提权前缀：两边都漏（sudo shutdown 都放行）
        - 注释却写着"判据与 plugins.is_blocked() 保持一致"

      两份判据必然漂移。现在这里只做一次调用，
      由 plugins.is_blocked() 唯一负责安全判据。
    """
    if not (cmd or '').strip():
        return '空命令'
    return _plugins_is_blocked(cmd)


def _plugins_is_blocked(cmd):
    try:
        from ..core.plugins import is_blocked
        return is_blocked(cmd)
    except Exception:
        # 导入失败绝不能变成"放行" —— 保守拒绝
        return '安全模块加载失败，拒绝执行'


class Bridge:
    """js_api 实例 —— 所有 public 方法都会暴露成 window.pywebview.api.xxx"""

    def __init__(self, window=None, cfg=None, exec_enabled=False):
        self.window = window
        self.cfg = cfg
        # ★★ exec 开关只能是 Python 侧决定的，绝不能由 JS 打开
        #
        #   pywebview 会把 js_api 实例上所有**不带下划线前缀**的方法
        #   暴露成 window.pywebview.api.xxx。所以曾经的
        #       def set_exec_enabled(self, on): ...
        #   等于给了页面里任意一段 JS 一个"一键解锁终端"的开关：
        #       pywebview.api.set_exec_enabled(true).then(() => gdpy.exec(...))
        #   黑名单仍在，但门本身是敞开的。
        #
        #   现在开关只由 webview_main 依据启动参数 --enable-exec 决定，
        #   页面无法翻转它。
        self._exec_enabled = bool(exec_enabled)
        self._n_http = 0

    # ---------- 网络 ----------
    def http_request(self, req):
        """代理 HTTP 请求

        req: {method, url, headers, body_b64}
        返回 {status, status_text, headers, body_b64}
        """
        method = (req or {}).get('method', 'GET').upper()
        url = (req or {}).get('url', '')
        headers = dict((req or {}).get('headers') or {})

        if not url.lower().startswith(('http://', 'https://')):
            return {'status': 0, 'status_text': '只允许 http/https'}
        if not _host_allowed(url):
            return {'status': 0,
                    'status_text': '域名不在白名单：%s' % _host_of(url)}

        # ★ 中文 URL 必须编码 —— http.client 用 ascii 编码 request line
        url = _ascii_safe(url)

        body = None
        b64 = (req or {}).get('body_b64')
        if b64:
            try:
                body = base64.b64decode(b64)
            except Exception:
                return {'status': 0, 'status_text': 'body_b64 不是合法 base64'}

        # ★ 去掉浏览器语义的头 —— 交给 urllib 自己管，不然会出错
        for k in list(headers.keys()):
            if k.lower() in ('content-length', 'host', 'connection',
                             'origin', 'referer', 'accept-encoding'):
                del headers[k]
        headers.pop('Content-Length', None)

        # 浏览器语义的头不能透传，交给连接层自己管
        for k in list(headers.keys()):
            if k.lower() in ('content-length', 'host', 'connection',
                             'origin', 'referer', 'accept-encoding',
                             'transfer-encoding'):
                del headers[k]

        # ★ 走带 Keep-Alive 的连接池，不再用 urllib.request.urlopen
        #
        #   urlopen 每次都新建 TCP + TLS。实测同一批 8 个 api.github.com 请求：
        #       新建连接  19.0 ~ 34.3 s
        #       复用连接   2.8 ~  8.2 s（8 个请求只建了 1 次连接）
        #   列一次文件列表要发 15 个请求 —— 在国内网络下 TLS 握手的 RTT 更贵，
        #   这个差距就是"慢到像卡住"和"秒开"的区别。
        #
        #   netpool 内部已对"连接被服务端关掉"自动重建重试一次；
        #   这里再兜一层：整体失败后重试 HTTP_RETRIES 次。
        msg = ''
        for i in range(HTTP_RETRIES):
            try:
                resp = netpool.request(method, url, headers=headers,
                                       body=body, timeout=DEFAULT_TIMEOUT,
                                       pool=_POOL)
                self._n_http += 1
                return resp.as_bridge_dict()
            except netpool.Error as e:
                msg = e.msg
                if i + 1 < HTTP_RETRIES:
                    time.sleep(0.4 * (i + 1))
                    continue
        return {'status': 0, 'status_text': msg, 'headers': {}, 'body_b64': ''}

    # ---------- 文件对话框 ----------
    def pick_open_file(self, req=None):
        req = req or {}
        if not self.window:
            return []
        try:
            import webview
            res = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=bool(req.get('multiple')),
                file_types=_filetypes(req.get('filetypes')),
            )
            return list(res) if res else []
        except Exception:
            return []

    def pick_save_file(self, req=None):
        req = req or {}
        if not self.window:
            return ''
        try:
            import webview
            res = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=req.get('default_name') or '',
                file_types=_filetypes(req.get('filetypes')),
            )
            return res if isinstance(res, str) else (res[0] if res else '')
        except Exception:
            return ''

    def pick_folder(self, req=None):
        req = req or {}
        if not self.window:
            return ''
        try:
            import webview
            res = self.window.create_file_dialog(
                webview.FOLDER_DIALOG)
            return res[0] if isinstance(res, (list, tuple)) and res else (
                res if isinstance(res, str) else '')
        except Exception:
            return ''

    # ---------- 本地文件 ----------
    def read_file_b64(self, req):
        path = (req or {}).get('path', '')
        try:
            with open(path, 'rb') as f:
                return {'ok': True, 'b64': base64.b64encode(f.read()).decode('ascii')}
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    def write_file_b64(self, req):
        req = req or {}
        path, b64 = req.get('path', ''), req.get('b64', '')
        try:
            data = base64.b64decode(b64)
            d = os.path.dirname(os.path.abspath(path))
            if d:
                os.makedirs(d, exist_ok=True)
            with open(path, 'wb') as f:
                f.write(data)
            return {'ok': True, 'size': len(data)}
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    # ---------- 执行外部命令 ----------
    def exec_enabled(self):
        """只读查询 —— 页面可以知道能不能用，但改不了

        （无下划线前缀 = 暴露给 JS；只读，所以无风险）
        """
        return bool(self._exec_enabled)

    def _set_exec_enabled(self, on):
        """内部方法：下划线开头，pywebview 不会暴露给 JS"""
        self._exec_enabled = bool(on)
        return self._exec_enabled

    def exec_command(self, req):
        req = req or {}
        cmd = req.get('cmd', '')
        if not self._exec_enabled:
            return {'ok': False, 'error': 'exec 默认关闭（安全策略）'}
        why = blocked_reason(cmd)
        if why:
            return {'ok': False, 'error': why, 'blocked': True}
        timeout = min(int(req.get('timeout', DEFAULT_TIMEOUT)), MAX_TIMEOUT)
        cwd = req.get('cwd') or None
        try:
            p = subprocess.run(cmd, shell=True, cwd=cwd, timeout=timeout,
                               capture_output=True)
            return {
                'ok': p.returncode == 0,
                'code': p.returncode,
                'stdout': _safe_text(p.stdout),
                'stderr': _safe_text(p.stderr),
            }
        except subprocess.TimeoutExpired:
            return {'ok': False, 'error': '执行超时（>%ds）' % timeout}
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    # ---------- 杂项 ----------
    def open_external(self, req):
        """用系统默认浏览器打开链接

        ★ 前端有 9 处 window.open()。在 pywebview 里 window.open 会开一个
          新的 webview 窗口 —— 那个窗口没有 js_api 桥，页面里的分享下载、
          仓库链接全都是坏的。桌面版必须把这 9 处改道到系统浏览器。

        ★ 只放行 http/https，且必须是白名单域名：
          javascript: / file: 这类协议交给系统浏览器等于把本机交出去。
        """
        url = ((req or {}).get('url') or '').strip()
        low = url.lower()
        if not low.startswith(('http://', 'https://')):
            return {'ok': False, 'error': '只允许 http/https 链接'}
        if not _host_allowed(url):
            return {'ok': False,
                    'error': '域名不在白名单：%s' % _host_of(url)}
        try:
            import webbrowser
            webbrowser.open(url)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    def open_in_explorer(self, req):
        path = (req or {}).get('path', '')
        try:
            if sys.platform.startswith('win'):
                os.startfile(os.path.dirname(os.path.abspath(path)) or '.')
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', os.path.dirname(os.path.abspath(path)) or '.'])
            else:
                subprocess.Popen(['xdg-open', os.path.dirname(os.path.abspath(path)) or '.'])
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def app_version(self):
        """版本号 —— 三级回退，且每级都比上一级更可能是真的

        ★ 早期只有 `from .._version import`，而 _version.py 从来没被
          创建过，于是**永远返回 '0.0.0'**，界面显示的版本跟实际完全不符。

          回退链：_version.py（CI 写入的真实值）
                  → gdrive.__version__（源码兜底）
                  → '0.0.0'
        """
        try:
            from .._version import __version__
            v = (__version__ or '').strip()
            # '0.0.0-dev' 说明 CI 没写入，继续回退
            if v and not v.endswith('-dev'):
                return v
        except Exception:
            pass
        try:
            from .. import __version__ as _v
            if _v:
                return _v
        except Exception:
            pass
        return '0.0.0'

    def js_log(self, req):
        """JS 侧 console 落到 Python 日志 —— Windows 下没法开 DevTools"""
        try:
            from ..core.config import app_dir
            p = os.path.join(app_dir(), 'js.log')
            with open(p, 'a', encoding='utf-8') as f:
                f.write('%s %s\n' % (time.strftime('%H:%M:%S'),
                                     (req or {}).get('msg', '')))
        except Exception:
            pass
        return True


def _filetypes(spec):
    """[[描述, 'txt;md'], ...] → pywebview 格式

    形如 ['文本文件 (*.txt)', 'txt']，可多组。传空表示不限。
    """
    out = []
    for item in (spec or []):
        if isinstance(item, str):
            out.append((item, item))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            out.append((item[0], item[1]))
    return out or None


def _safe_text(b):
    if not b:
        return ''
    try:
        return b.decode('utf-8', 'replace')
    except Exception:
        return repr(b[:200])
