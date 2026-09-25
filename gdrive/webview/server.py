"""
本地 HTTP 服务 —— 只为给页面一个"同源"origin

★ 为什么不用 file://
  1. file:// 下 localStorage 在 WebView2 里行为不一致（可能整个不可用）
  2. 页面里的相对路径、XHR 都会被 file 协议限制
  3. origin 是 "null"，部分逻辑会走异常分支

  起个 127.0.0.1 的服务就没有这些问题，而且不监听外网。
"""
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SHIM_ROUTE = '/__gdpy_shim__.js'

SHIM_TAG = '<script src="%s"></script>' % SHIM_ROUTE

# 常见后缀 → MIME（Windows 注册表里有时缺 .js/.mjs，会导致脚本不执行）
EXTRA_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        self._shim = kw.pop('shim_bytes', b'')
        super().__init__(*a, directory=kw.pop('directory', '.'), **kw)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def do_GET(self):
        if self.path.split('?')[0] == SHIM_ROUTE:
            self.send_response(200)
            self.send_header('Content-Type',
                             'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(self._shim)))
            self.end_headers()
            self.wfile.write(self._shim)
            return
        super().do_GET()

    def send_head(self):
        """index.html 注入 shim —— 必须在 </body> 前，那时所有 class 已定义"""
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        if (os.path.isfile(path) and os.path.basename(path) == 'index.html'):
            try:
                with open(path, 'rb') as f:
                    raw = f.read()
                tag = SHIM_TAG.encode('utf-8')
                if b'</body>' in raw:
                    body = raw.replace(b'</body>', tag + b'\n</body>')
                else:
                    # 页面里没有 </body>（不该发生），退化成追加到末尾
                    body = raw + b'\n' + tag
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                from io import BytesIO
                return BytesIO(body)
            except Exception:
                pass
        return super().send_head()

    def log_message(self, fmt, *args):
        pass        # 不刷控制台，Windows 下没有控制台可刷


def start(web_dir, shim_js=None):
    """启动服务，返回 (url, shutdown_callable)"""
    if shim_js is None:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, 'shim.js'), 'rb') as f:
            shim_js = f.read()

    def make(*a, **kw):
        return Handler(*a, directory=web_dir, shim_bytes=shim_js, **kw)

    # 端口 0 = 让系统分配空闲端口，避免冲突
    srv = ThreadingHTTPServer(('127.0.0.1', 0), make)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    def shutdown():
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass

    return 'http://127.0.0.1:%d/index.html' % port, shutdown
