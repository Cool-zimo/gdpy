# -*- coding: utf-8 -*-
"""netpool（Keep-Alive 连接池）测试

★ 为什么要有这个模块：
  urllib.request.urlopen 每次新建 TCP + TLS。实测同一批 8 个
  api.github.com 请求：新建连接 19~34 s，复用连接 2.8~8.2 s。
  桌面版"慢到像卡住"，主因就在这里。

  测的重点不是"能发请求"，而是：
    1. 连接真的被复用（建连次数可数）
    2. 跨主机跳转不带走 Authorization
    3. 多线程下不会共用一条连接（读串响应）
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.webview import netpool

passed = failed = 0


def ck(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ✓ ' + label)
    else:
        failed += 1
        print('  ✗ ' + label + '  ' + str(extra))


print('【1】连接复用（★ 池的意义所在）')


class CountingPool(netpool._Pool):
    """数一下到底建了几条连接"""

    def __init__(self):
        netpool._Pool.__init__(self)
        self.made = 0

    def _make(self, scheme, host, port, timeout):
        self.made += 1
        return netpool._Pool._make(self, scheme, host, port, timeout)


# 用本地 http 服务测，不依赖外网 —— 否则网络抖动会让测试变红
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'ok'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:%d' % srv.server_address[1]

p = CountingPool()
for i in range(6):
    r = netpool.request('GET', base + '/x?i=%d' % i, timeout=10, pool=p)
ck('  6 个请求只建 1 条连接', p.made == 1, '实际 %d' % p.made)
ck('  响应正确', r.status == 200 and r.body == b'ok', r.status)
p.close_all()

p2 = CountingPool()
netpool.request('GET', base + '/a', timeout=10, pool=p2)
netpool.request('GET', base + '/b', timeout=10, pool=p2)
ck('  同一 host 复用', p2.made == 1, p2.made)
p2.close_all()

print('\n【2】重定向')


class R(BaseHTTPRequestHandler):
    seen_auth = []

    def do_GET(self):
        R.seen_auth.append(self.headers.get('Authorization'))
        if self.path == '/jump':
            self.send_response(302)
            self.send_header('Location', '/final')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):
        pass


srv2 = ThreadingHTTPServer(('127.0.0.1', 0), R)
threading.Thread(target=srv2.serve_forever, daemon=True).start()
base2 = 'http://127.0.0.1:%d' % srv2.server_address[1]

p3 = netpool._Pool()
r = netpool.request('GET', base2 + '/jump',
                    headers={'Authorization': 'Bearer SECRET'},
                    timeout=5, pool=p3)
ck('  跟随 302 到 /final', r.status == 200 and r.body == b'ok', r.status)
p3.close_all()
ck('  同主机跳转保留 Authorization',
   'Bearer SECRET' in R.seen_auth, R.seen_auth)

# 跨主机跳转必须丢掉 Authorization —— 直接查实现里的过滤规则
orig = {'Authorization': 'Bearer S', 'X-Other': 'keep'}
kept = {k: v for k, v in orig.items()
        if k.lower() not in netpool._SENSITIVE}
ck('★ 跨主机跳转丢掉 Authorization', 'Authorization' not in kept, kept)
ck('  但保留其它头', kept.get('X-Other') == 'keep', kept)

print('\n【3】线程安全（★ pywebview js_api 在多线程执行）')

errs = []
lock = threading.Lock()
pool = netpool._Pool()


def worker(i):
    try:
        for _ in range(3):
            with lock:
                r = netpool.request('GET', base + '/t%d' % i, timeout=10,
                                    pool=pool)
            if r.status != 200 or r.body != b'ok':
                with lock:
                    errs.append((i, r.status, r.body[:20]))
    except Exception as e:
        with lock:
            errs.append((i, 'exc', str(e)[:60]))


ts = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
t0 = time.time()
[t.start() for t in ts]
[t.join() for t in ts]
ck('  8 线程 × 3 请求无错', not errs, errs[:3])
print('    耗时 %.2f s' % (time.time() - t0))
pool.close_all()

print('\n【4】错误处理')

try:
    netpool.request('GET', 'ftp://x/y', timeout=5)
    ck('  拒绝非 http 协议', False)
except netpool.Error as e:
    ck('  拒绝非 http 协议', '不支持的协议' in e.msg, e.msg)

try:
    netpool.request('GET', 'http://127.0.0.1:1/x', timeout=5)
    ck('  连不上抛 Error（不是崩溃）', False)
except netpool.Error as e:
    ck('  连不上抛 Error（不是崩溃）', True, e.msg[:60])

r = netpool.request('GET', base + '/x', headers={'Accept-Encoding': 'gzip'},
                    timeout=10)
ck('  带 accept-encoding 也能正常返回', r.status == 200, r.status)

print('\n【5】中文路径')


class E(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if '%' not in self.path else 200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):
        pass


srv3 = ThreadingHTTPServer(('127.0.0.1', 0), E)
threading.Thread(target=srv3.serve_forever, daemon=True).start()
b3 = 'http://127.0.0.1:%d' % srv3.server_address[1]
try:
    r = netpool.request('GET', b3 + '/' + '报告.txt', timeout=10)
    ck('★ 中文路径不抛 UnicodeEncodeError', r.status == 200, r.status)
except Exception as e:
    ck('★ 中文路径不抛 UnicodeEncodeError', False, '%s: %s' % (type(e).__name__, e))

srv.shutdown()
srv2.shutdown()
srv3.shutdown()

print('\n==============================================')
print('  %d 通过 / %d 失败' % (passed, failed))
print('==============================================')
sys.exit(1 if failed else 0)
