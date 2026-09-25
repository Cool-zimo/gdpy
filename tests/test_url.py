"""URL 非 ASCII 编码测试 —— Windows 上中文文件名会崩的根因"""
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.api import _ascii_safe

passed = failed = 0
def ck(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1; print('  ✓ ' + label)
    else:
        failed += 1; print('  ✗ ' + label + '  ' + str(extra))

print('【1】★ ASCII URL 必须原样返回（零风险的前提）')
plain = 'https://api.github.com/repos/a/b/contents/x.txt?ref=main'
ck('全 ASCII 不改动', _ascii_safe(plain) == plain, _ascii_safe(plain))
ck('★ 已编码的 %20 不被二次编码',
   _ascii_safe('https://x.com/a%20b') == 'https://x.com/a%20b',
   _ascii_safe('https://x.com/a%20b'))
ck('★ %2F 不被二次编码',
   _ascii_safe('https://x.com/a%2Fb') == 'https://x.com/a%2Fb',
   _ascii_safe('https://x.com/a%2Fb'))

print('\n【2】★ 中文路径被编码')
u = _ascii_safe('https://raw.githubusercontent.com/o/r/main/中文文件.txt')
ck('中文已编码', '中文' not in u, u)
ck('结果是纯 ASCII', u.isascii(), u)
ck('%E4 前缀正确（UTF-8 百分号编码）', '%E4%B8%AD' in u, u)

print('\n【3】★ 编码后能被 http.client 发送（不再崩）')
import urllib.request
class FakeResp:
    def read(self): return b'{}'
    headers = {'Content-Type': 'application/json'}
    def __enter__(self): return self
    def __exit__(self, *a): return False

sent = {}
def fake_urlopen(req, timeout=None):
    sent['url'] = req.full_url
    return FakeResp()

orig = urllib.request.urlopen
urllib.request.urlopen = fake_urlopen
try:
    req = urllib.request.Request(_ascii_safe('https://x.com/中文'), method='GET')
    urllib.request.urlopen(req, timeout=1)
    ck('★ 不再抛 UnicodeEncodeError', True)
    ck('实际发出的是编码后 URL', sent['url'].isascii(), sent['url'])
except UnicodeEncodeError as e:
    ck('★ 不再抛 UnicodeEncodeError', False, e)
except Exception as e:
    ck('其他异常', False, '%s: %s' % (type(e).__name__, e))
finally:
    urllib.request.urlopen = orig

print('\n【4】对照：不编码确实会崩（证明修复有价值）')
try:
    req = urllib.request.Request('https://x.com/中文', method='GET')
    real = urllib.request.urlopen
    urllib.request.urlopen = lambda r, timeout=None: FakeResp()
    try:
        # http.client 需要真实连接才编码，这里手动触发同等路径
        'https://x.com/中文'.encode('ascii')
        ck('未编码会崩', False, '未复现')
    except UnicodeEncodeError:
        ck('★ 未编码确实抛 ascii 错误（修复必要）', True)
    finally:
        urllib.request.urlopen = real
except Exception as e:
    print('  (跳过对照: %s)' % e)

print('\n【5】边界')
ck('空字符串', _ascii_safe('') == '')
ck('bytes 原样', _ascii_safe(b'abc') == b'abc')
ck('★ query 里的中文也编码',
   _ascii_safe('https://x.com/p?q=中文').isascii())
ck('斜杠保留', _ascii_safe('https://x.com/a/中文/b').count('/') ==
   'https://x.com/a/中文/b'.count('/'))

print('\n【6】★ 集成：所有 API 出口在中文文件名下都不产生非 ASCII URL')
from gdrive.core.api import GitHubAPI

seen = []
def spy(self, method, path, data=None, headers=None, raw_url=False,
        accept='application/vnd.github+json'):
    url = path if raw_url else ('https://api.github.com' + path)
    seen.append(url)
    return {}

orig_req = GitHubAPI._req
GitHubAPI._req = spy
try:
    api = GitHubAPI('tok')
    cn = '中文 文件#1?.txt'
    api.get_file('o', 'r', cn)
    api.put_file('o', 'r', cn, b'x', '上传中文文件')
    api.delete_file('o', 'r', cn, '删除', sha='deadbeef')
    api.raw('o', 'r', cn)
    api.create_repo('gd-share-ab', private=False, description='中文描述')
finally:
    GitHubAPI._req = orig_req

bad = [u for u in seen if not u.isascii()]
ck('产生了 %d 个 URL' % len(seen), len(seen) >= 5)
ck('★ 全部是 ASCII（无一会崩）', not bad, bad)
ck('★ raw 的中文被编码',
   any('%E4' in u for u in seen), seen[-1] if seen else '')

print('\n' + '='*46)
print('  %d 通过 / %d 失败' % (passed, failed))
print('='*46)
sys.exit(1 if failed else 0)
