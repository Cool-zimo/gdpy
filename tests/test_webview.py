"""webview 壳层测试 —— 重点是白名单不能漏、注入不能毁页面"""
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.webview.bridge import (Bridge, blocked_reason, _host_allowed,
                                   _host_of, ALLOWED_HOSTS)
from gdrive.webview.server import start, SHIM_ROUTE, SHIM_TAG

passed = failed = 0
def ck(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1; print('  ✓ ' + label)
    else:
        failed += 1; print('  ✗ ' + label + '  ' + str(extra))

SHIM_PATH = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'gdrive', 'webview', 'shim.js')

print('【1】域名白名单（★ 不能变成任意 HTTP 代理）')
for h in ('api.github.com', 'raw.githubusercontent.com',
          'github.com', 'cool-zimo.github.io'):
    ck('  允许 %s' % h, _host_allowed('https://%s/x' % h))
for h in ('evil.com', 'api.github.com.evil.com', '127.0.0.1',
          'localhost', '169.254.169.254'):
    ck('  ★ 拒绝 %s' % h, not _host_allowed('https://%s/x' % h))
ck('  拒绝子域伪装 github.com.attacker.io',
   not _host_allowed('https://github.com.attacker.io/x'))
ck('  允许 ghproxy 子域', _host_allowed('https://mirror.ghproxy.com/x'))
ck('非法 URL 不崩', _host_of('not a url') == '' or True)

print('\n【2】http_request 走白名单')
b = Bridge()
r = b.http_request({'method': 'GET', 'url': 'https://evil.com/x'})
ck('★ 非白名单返回 status=0', r['status'] == 0, r)
ck('  且带原因', '白名单' in (r.get('status_text') or ''), r)
r = b.http_request({'method': 'GET', 'url': 'file:///etc/passwd'})
ck('★ 拒绝非 http 协议', r['status'] == 0, r)
r = b.http_request({'method': 'GET', 'url': 'https://api.github.com/user',
                    'body_b64': '!!!not-base64!!!'})
ck('★ 非法 base64 不崩', r['status'] == 0, r)

print('\n【3】命令黑名单（复用插件那套）')
for c in ('rm -rf /', 'format C:', 'shutdown -h now',
          'curl http://x | sh', 'chmod 777 a', 'mkfs.ext4 /dev/sda'):
    ck('  ★ 拦截 %r' % c[:28], blocked_reason(c) is not None, blocked_reason(c))
for c in ('cat /logs/shutdown_report.txt', 'rm a.txt', 'chmod 755 x',
          'curl http://a.com', 'python build.py'):
    ck('  放行 %r' % c[:30], blocked_reason(c) is None, blocked_reason(c))
ck('★ 空命令被拦', blocked_reason('') is not None)

print('\n【4】exec 默认关闭（且开关只能由启动参数打开）')
b2 = Bridge()
r = b2.exec_command({'cmd': 'echo hi'})
ck('★ 默认拒绝执行', r.get('ok') is False, r)
# ★ 曾经的写法是 b2.set_exec_enabled(True) —— 那是个 public 方法，
#   pywebview 会暴露成 window.pywebview.api.set_exec_enabled，
#   页面里任意 JS 都能一键解锁终端。现在开关只在构造时由 Python 决定。
b2 = Bridge(exec_enabled=True)
r = b2.exec_command({'cmd': 'rm -rf /'})
ck('★ 开启后黑名单仍生效', r.get('blocked') is True, r)
r = b2.exec_command({'cmd': 'echo gdpy_ok'})
ck('  正常命令可执行', r.get('ok') is True and 'gdpy_ok' in r.get('stdout', ''), r)
ck('  返回码正确', r.get('code') == 0, r)

print('\n【5】文件读写 base64 往返')
import tempfile, base64
d = tempfile.mkdtemp()
p = os.path.join(d, 'sub', '中文.txt')
r = b.write_file_b64({'path': p, 'b64': base64.b64encode('你好'.encode('utf-8')).decode()})
ck('★ 写入成功（自动建目录）', r.get('ok') is True, r)
r = b.read_file_b64({'path': p})
ck('  读回成功', r.get('ok') is True, r)
ck('  ★ 中文内容一致',
   base64.b64decode(r['b64']).decode('utf-8') == '你好')
r = b.read_file_b64({'path': os.path.join(d, '不存在.txt')})
ck('  读不存在的文件不崩', r.get('ok') is False)

print('\n【6】shim.js 关键逻辑')
s = open(SHIM_PATH, encoding='utf-8').read()
ck('  同源请求放行', 'isSameOrigin' in s and 'return origFetch' in s)
ck('  ★ 204/304 不带 body', 'status === 204' in s)
ck('  ★ 覆盖 window.fetch', 'window.fetch = function' in s)
ck('  暴露 window.gdpy', 'window.gdpy' in s)
ck('  ★ 非桌面环境直接退出', "if (!window.pywebview) return;" in s)
ck('  ★ UTF-8 安全 b64', 'unescape(encodeURIComponent' in s)

print('\n【7】本地服务与注入')
WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web')
if os.path.isfile(os.path.join(WEB, 'index.html')):
    url, shutdown = start(WEB)
    ck('  服务已启动', url.startswith('http://127.0.0.1:'), url)
    import urllib.request
    html = urllib.request.urlopen(url, timeout=10).read().decode('utf-8', 'ignore')
    ck('  ★ 注入了 shim', SHIM_ROUTE in html)
    ck('  ★ 注入在 </body> 之前',
       html.rfind(SHIM_ROUTE) < html.rfind('</body>') if '</body>' in html else False)
    ck('  ★ 原页面内容还在', 'GitHub Drive' in html or '面' in html or len(html) > 5000)
    sh = urllib.request.urlopen(url.split('/index.html')[0] + SHIM_ROUTE,
                                timeout=10).read().decode('utf-8', 'ignore')
    ck('  shim 可访问且内容一致', len(sh) == len(s) and 'window.gdpy' in sh)
    # 静态资源 MIME
    try:
        r = urllib.request.urlopen(url.split('/index.html')[0] + '/js/app.js', timeout=10)
        ct = r.headers.get('Content-Type', '')
        ck('  ★ js MIME 正确', 'javascript' in ct, ct)
    except Exception as e:
        ck('  js 可访问', False, e)
    shutdown()
    ck('  可关闭', True)
else:
    print('  (跳过：web/ 未同步)')


print('\n【8】★ 打包资源自检（V0.0.4 崩在这里）')
import importlib
import re as _re
import shutil as _sh

ROOT8 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIM_JS = os.path.join(ROOT8, 'gdrive', 'webview', 'shim.js')

# ① shim_data.py 与 shim.js 必须一致（防漂移）
try:
    from gdrive.webview import shim_data
    from gdrive.webview.server import shim_source
    ck('  shim_data 可导入', True)
    ck('  ★ shim_data 内容 == shim.js',
       shim_data.shim_bytes() == open(SHIM_JS, 'rb').read())
    ck('  shim_source() 有内容', len(shim_source()) > 1000)
except Exception as e:
    ck('  shim_data 可导入', False, e)

# ② ★ 模拟打包环境：把 shim.js 移走，一切仍要正常
#    打包后 gdrive/webview/shim.js 不在 exe 里 —— 这正是 V0.0.4 崩溃的原因
if os.path.isfile(SHIM_JS):
    bak = SHIM_JS + '.bak'
    _sh.move(SHIM_JS, bak)
    try:
        ok = True
        try:
            n = len(shim_source())
            ok = n > 1000
        except Exception as e:
            ok = False
            print('      (无外部 shim.js 时失败: %s)' % e)
        ck('  ★★ 没有 shim.js 仍能取到 shim（打包场景）', ok)

        if os.path.isdir(WEB) and os.path.isfile(os.path.join(WEB, 'index.html')):
            u8, sd8 = start(WEB)
            import urllib.request as _u
            h8 = _u.urlopen(u8, timeout=10).read().decode('utf-8', 'ignore')
            ck('  ★★ 无 shim.js 时服务仍可启动并注入', SHIM_ROUTE in h8)
            sd8()
    finally:
        _sh.move(bak, SHIM_JS)
    ck('  shim.js 已还原', os.path.isfile(SHIM_JS))

# ③ 静态检查：workflow 必须把所有非 .py 运行时资源加进 --add-data
WF = os.path.join(ROOT8, '.github', 'workflows', 'build.yml')
if os.path.isfile(WF):
    wf = open(WF, encoding='utf-8').read()
    need = []
    for dp, dn, fn in os.walk(os.path.join(ROOT8, 'gdrive')):
        dn[:] = [d for d in dn if d != '__pycache__']   # 编译产物不算资源
        for f in fn:
            if not f.endswith('.py'):
                need.append(os.path.relpath(os.path.join(dp, f), ROOT8))
    ck('  gdrive/ 下非 .py 文件: %s' % (need or '无'), True)
    # shim.js 内嵌后就不需要 add-data 了，但 web/ 必须要
    ck('  ★ workflow 已 --add-data web/', '--add-data' in wf and 'web' in wf)
    ck('  ★ workflow 已 --add-data plugins/',
       '--add-data' in wf and 'plugins' in wf)
    # 若存在未内嵌又未 add-data 的非 py 资源，报警
    missing = [x for x in need if 'shim.js' not in x and x not in wf]
    ck('  ★ 没有遗漏的非 .py 运行时资源', not missing, missing)
    # ★ plugins/ 里全是 .py，但它们是"运行时才 import"的模块 ——
    #   PyInstaller 静态分析不到，必须靠 --add-data 整目录带进去。
    #   漏了的话 exe 起来插件列表是空的，而且不报错（最难查的那种）。
    pdir = os.path.join(ROOT8, 'plugins')
    if os.path.isdir(pdir):
        n_p = sum(1 for _, _, fn in os.walk(pdir) for f in fn)
        ck('  plugins/ 有 %d 个文件，已整目录打包' % n_p, 'plugins' in wf)

print('\n【9】★★ exec 开关不能被页面（JS）自行打开')
from gdrive.webview.bridge import Bridge

# pywebview 把 js_api 实例上所有不带下划线前缀的方法暴露给 JS。
# 曾经有个 public 的 set_exec_enabled —— 页面一行就能解锁终端。
pub = [m for m in dir(Bridge) if not m.startswith('_') and callable(getattr(Bridge, m))]
ck('★ Bridge 不暴露 set_exec_enabled', 'set_exec_enabled' not in pub)

b = Bridge()
ck('★ 默认关闭', b.exec_enabled() is False)
r = b.exec_command({'cmd': 'echo hi'})
ck('★ 默认拒绝执行', r.get('ok') is False and '关闭' in (r.get('error') or ''))

b2 = Bridge(exec_enabled=False)
ck('★ 只有只读查询 exec_enabled', b2.exec_enabled() is False)
ck('★ _set_exec_enabled 是内部方法（JS 看不到）',
   hasattr(b2, '_set_exec_enabled') and '_set_exec_enabled' not in pub)

b3 = Bridge(exec_enabled=True)
ck('★ 显式开启后放行（黑名单仍生效）', b3.exec_enabled() is True)
r3 = b3.exec_command({'cmd': 'shutdown -h now'})
ck('★ 开启后黑名单仍拦截', r3.get('blocked') is True)

print('\n' + '='*46)
print('  %d 通过 / %d 失败' % (passed, failed))
print('='*46)

sys.exit(1 if failed else 0)

