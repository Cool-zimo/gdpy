"""核心逻辑测试（不依赖 tkinter，纯逻辑）"""
import base64
import json
import os
import sys
import tempfile

# ★ Windows 上 stdout 被重定向时（CI 就是），Python 会用 locale 编码
#   （中文环境是 cp936/GBK），而下面的输出含 ✓ ✗ ⚠️ 等符号 →
#   UnicodeEncodeError 直接崩掉测试。必须强制 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.contract import DRIVE_HOME, _b36, is_chunk_dir
from gdrive.core.textutil import (human_size, breadcrumb_segments, shorten,
                                  ROOT_LABEL, ELLIPSIS)
from gdrive.core.plugins import (GrantStore, normalize_perms, is_official,
                                 RISK, PermissionError, _is_blocked)

passed = failed = 0
def ck(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ✓ ' + label)
    else:
        failed += 1
        print('  ✗ ' + label + ' ' + str(extra))

# ★ 原本 tmpdir 定义在已删除的旧业务测试段落里，删那段时把它带走了。
#   这说明：删测试不能只删"看起来无关"的段落，要跑一遍看有没有悬空引用。
tmpdir = tempfile.mkdtemp()

print('\n【10】★ 插件权限：未知权限按最高风险')
known, unknown = normalize_perms(['fs:read', 'evil:thing'])
ck('已知权限被识别', known == ['fs:read'])
ck('未知权限被分离', unknown == ['evil:thing'])

print('\n【11】★ 运行时校验（防冒充的关键）')
gd = os.path.join(tmpdir, 'grants.json')
gs = GrantStore(gd)
gs.grant('good', ['fs:read'])
try:
    gs.check('good', 'exec')
    ck('未授权应拒绝', False)
except PermissionError:
    ck('未授权 exec 被拒绝', True)
try:
    gs.check('good', 'whatever')
    ck('未知权限应拒绝', False)
except PermissionError:
    ck('★ 未知权限一律拒绝', True)
ck('已授权的放行', gs.check('good', 'fs:read') is True)
gs.revoke('good')
ck('撤销后失效', gs.granted('good') == [])

print('\n【12】★ 官方仓库白名单不能被绕过')
ck('官方 repo', is_official('Cool-zimo/gdpy-plugins'))
ck('带 .git 后缀', is_official('Cool-zimo/gdpy-plugins.git'))
ck('★ 前缀追加不算', not is_official('Cool-zimo/gdpy-plugins2'))
ck('★ 加路径不算', not is_official('evil/Cool-zimo/gdpy-plugins'))
ck('空值不算', not is_official(''))

print('\n【13】★ 命令黑名单：既拦危险，也不误杀')
for bad in ['rm -rf /', 'mkfs.ext4 /dev/sda', 'shutdown now', 'chmod 777 x']:
    ck('拦截: %s' % bad, _is_blocked(bad) is not None)
for okc in ['cat /logs/shutdown_report.txt', 'rm a.txt', 'chmod 755 x',
            'curl http://a.com']:
    ck('放行: %s' % okc, _is_blocked(okc) is None, _is_blocked(okc))

print('\n【14】human_size')
ck('B', human_size(512) == '512 B')
ck('KB', human_size(1024) == '1.0 KB')
ck('MB', human_size(1024*1024) == '1.0 MB')

print('\n【15】分片路径命名（与 web 版同形）')
print('\n【15】★ 分片路径命名（与 web 版同形）')

# ★ 对照值是真跑 node 的 `(n).toString(36)` 得来的，不是 Python 自己算自己比。
#   曾经的断言是 `_b36(x) == _b36(x)` —— 恒真，等于没测。
#   js 用它生成分片目录 `mt` + _b36(Date.now())，Python 用它**识别**这类目录。
#   两边一旦不一致，扫描孤儿时就会漏掉整个目录。
_JS_B36 = [
    (0, '0'), (1, '1'), (35, 'z'), (36, '10'),
    (123456789, '21i3v9'),
    (1760000000000, 'mgj6k3cw'),
    (1760000000123, 'mgj6k3gb'),
]
for _n, _want in _JS_B36:
    ck('★ 与 JS toString(36) 一致: %d' % _n, _b36(_n) == _want,
       '%s != %s' % (_b36(_n), _want))

ck('★ 字符集限定 36 进制',
   all(c in '0123456789abcdefghijklmnopqrstuvwxyz' for c in _b36(123456789)))

# ★ 分片目录识别 —— 56MB 丢失事件的根因就是这种目录不断累积
ck('识别分片目录', is_chunk_dir('mtmgj6k3cw'))
ck('★ 不是分片目录: 普通名', not is_chunk_dir('photos'))
ck('★ 不是分片目录: mt 后含非法字符', not is_chunk_dir('mtABC-1'))
ck('★ 不是分片目录: 太短', not is_chunk_dir('mt'))
ck('DRIVE_HOME 契约', DRIVE_HOME == '/drive_home')

# ★ 下面三段一度被误删：删 vfs.py 时以为 breadcrumb_segments / shorten
#   也随之下线了。实际上它们早被抽到 core/textutil.py（活代码，
#   tools/maintain_cli.py 在用 human_size）。
#   教训：删测试前必须确认被删的**函数**还活着，不能只看模块在不在。

print('\n【16】面包屑路径切分')
ck('根显示为「网盘」不是 drive_home',
   breadcrumb_segments('/drive_home') == [('网盘', '/drive_home')])
ck('★ 根标签不含内部实现名',
   'drive_home' not in breadcrumb_segments('/drive_home')[0][0])
s2 = breadcrumb_segments('/drive_home/a/b')
ck('两级路径', [x[0] for x in s2] == ['网盘', 'a', 'b'])
ck('★ 每级都带完整可跳转路径',
   [x[1] for x in s2] == ['/drive_home', '/drive_home/a', '/drive_home/a/b'])
s6 = breadcrumb_segments('/drive_home/a/b/c/d/e/f')
ck('深路径被折叠', len(s6) == 5, s6)
ck('★ 折叠项路径为 None（不可点击）', s6[1] == (ELLIPSIS, None))
ck('折叠后末尾仍可跳转', s6[-1][1] == '/drive_home/a/b/c/d/e/f')
ck('★ 折叠不超过上限',
   len(breadcrumb_segments('/drive_home/' + '/'.join('abcdefghij'), 3)) <= 3)
ck('相对路径也能切', breadcrumb_segments('a/b')[0][1] == '/drive_home')
for name, path in breadcrumb_segments('/drive_home/x/y/z'):
    if path is None:
        continue
    ck('  项 %s 路径自洽' % name,
       path == '/drive_home' or path.split('/')[-1] == name)

print('\n【17】长名截断')
ck('短名不变', shorten('abc.txt') == 'abc.txt')
ck('None 安全', shorten(None) is None)
print('\n【18】★ 版本号三处一致（防漂移）')
# ★ 历史 bug：VERSION 文件停在 0.0.1 而实际已发布到 0.0.7；
#   后来又发现 __init__._FALLBACK 停在 0.0.7 而 VERSION 已是 0.0.8。
#   不传参数触发构建会编出旧版本号 —— 版本号倒退比功能 bug 更难发现。
import gdrive as _gd
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_vf_path = os.path.join(_root, 'VERSION')
_vfile = open(_vf_path, encoding='utf-8').read().strip() if os.path.exists(_vf_path) else ''

def _vt(v):
    try:
        return tuple(int(x) for x in str(v).lstrip('v').split('.'))
    except Exception:
        return (0,)

ck('VERSION 文件是三段版本号',
   bool(__import__('re').match(r'^\d+\.\d+\.\d+$', _vfile)), _vfile)
ck('★ _FALLBACK 不落后于 VERSION 文件',
   _vt(_gd._FALLBACK) >= _vt(_vfile),
   '_FALLBACK=%s VERSION=%s' % (_gd._FALLBACK, _vfile))
ck('★ __version__ 不落后于 VERSION 文件',
   _vt(_gd.__version__) >= _vt(_vfile),
   '__version__=%s VERSION=%s' % (_gd.__version__, _vfile))

print('\n' + '='*46)
print('  %d 通过 / %d 失败' % (passed, failed))
print('='*46)
# ★ 必须保护：不加 if __name__ 的话，import 本模块就会终止进程，
#   后果是「后面定义的检查永远跑不到」且「合并套件时杀掉整个进程」。
if __name__ == '__main__':
    sys.exit(1 if failed else 0)
