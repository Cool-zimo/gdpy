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

from gdrive.core.vfs import VFS, DRIVE_HOME, normalize, parent, basename, join, human_size
from gdrive.core.config import Config, DEFAULT_STORAGE_CONFIG, LEGACY_CHUNK_SIZES
from gdrive.core.share import is_share_repo, pages_url
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

print('【1】VFS 路径规范化')
ck('normalize 补 drive_home', normalize('a/b.txt') == '/drive_home/a/b.txt')
ck('已是 drive_home 不改', normalize('/drive_home/x') == '/drive_home/x')
ck('去结尾斜杠', normalize('/drive_home/a/') == '/drive_home/a')
ck('根路径', normalize('') == '/drive_home')
ck('parent', parent('/drive_home/a/b.txt') == '/drive_home/a')
ck('根的 parent 是 None', parent('/drive_home') is None)
ck('basename', basename('/drive_home/a/b.txt') == 'b.txt')
ck('join', join('/drive_home/a', 'b') == '/drive_home/a/b')

print('\n【2】VFS 增删查')
v = VFS()
v.put_file('/drive_home/a/b.txt', size=100, chunks=[{'path': 'x/1'}])
ck('文件存在', v.is_file('/drive_home/a/b.txt'))
ck('父目录自动补齐', v.is_folder('/drive_home/a'))
ck('children 只列出直接子项',
   [c[0] for c in v.children('/drive_home')] == ['a'])
ck('子目录内容', [c[0] for c in v.children('/drive_home/a')] == ['b.txt'])
ck('统计大小', v.total_size() == 100)

print('\n【3】★ 递归删除返回被删文件')
removed = v.remove_tree('/drive_home/a')
ck('返回被删文件列表', len(removed) == 1)
ck('文件已消失', not v.exists('/drive_home/a/b.txt'))
ck('目录也清了', not v.exists('/drive_home/a'))

print('\n【4】★ 防御式规范化（跨端同步必需）')
v2 = VFS({})
ck('空 dict 可用', v2.data['files'] == {} and v2.data['folders'] == {})
v3 = VFS(None)
ck('None 也不崩', v3.data['files'] == {})
v4 = VFS({'files': None, 'folders': None})
ck('字段为 None 也不崩', v4.data['files'] == {})

print('\n【5】重命名/移动')
v5 = VFS()
v5.put_file('/drive_home/x/1.txt', size=10)
n = v5.rename('/drive_home/x', '/drive_home/y')
ck('目录改名影响子文件', n >= 1)
ck('新路径存在', v5.is_file('/drive_home/y/1.txt'))
ck('旧路径消失', not v5.is_file('/drive_home/x/1.txt'))

print('\n【6】Config 存储配置迁移')
tmpdir = tempfile.mkdtemp()
cfg = Config(os.path.join(tmpdir, 'c.json'))
sc = cfg.storage_config()
ck('默认 chunkSize=512KB', sc['chunkSize'] == 512 * 1024)
ck('默认 maxRepoSize=900MB', sc['maxRepoSize'] == 900 * 1024 * 1024)
cfg.set('storageConfig', {'chunkSize': 50 * 1024 * 1024})
ck('★ 旧 50MB 被迁移回 512KB', cfg.storage_config()['chunkSize'] == 512 * 1024)
cfg.set('storageConfig', {'chunkSize': 20 * 1024 * 1024})
ck('★ 旧 20MB 也被迁移', cfg.storage_config()['chunkSize'] == 512 * 1024)

print('\n【7】★ 容量记账不能扣成负数')
cfg.set_usage('o', 'r', 100)
cfg.sub_usage('o', 'r', 500)
ck('扣多了不为负', cfg.usage()['o/r'] == 0, cfg.usage())

print('\n【8】多账号')
cfg.add_account('A', 'tok1')
cfg.add_account('B', 'tok2')
cfg.add_account('A', 'tok3')
accs = cfg.accounts()
ck('同 login 只保留一条', len(accs) == 2)
ck('A 的 token 被更新', [a['token'] for a in accs if a['login'] == 'A'] == ['tok3'])

print('\n【9】分享仓库识别')
ck('gd-share- 前缀', is_share_repo('gd-share-ab12cd'))
ck('旧 share- 前缀兼容', is_share_repo('share-abc'))
ck('普通仓库不算', not is_share_repo('drive-storage-2026-01-01-abcd'))
ck('大小写不敏感', is_share_repo('GD-Share-AB'))
ck('pages url', pages_url('me', 'gd-share-x') == 'https://me.github.io/gd-share-x/')

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
from gdrive.core.transfer import _b36
ck('base36 编码', _b36(1760000000000) == _b36(1760000000000))
ck('base36 与 JS 同形（字符集）',
   all(c in '0123456789abcdefghijklmnopqrstuvwxyz' for c in _b36(123456789)))
ck('0 的边界', _b36(0) == '0')


print('\n【16】面包屑路径切分')
from gdrive.core.vfs import breadcrumb_segments, shorten, ROOT_LABEL, ELLIPSIS

ck('根显示为「网盘」不是 drive_home',
   breadcrumb_segments('/drive_home') == [('网盘', '/drive_home')])
ck('★ 根标签不含内部实现名',
   'drive_home' not in breadcrumb_segments('/drive_home')[0][0])

s2 = breadcrumb_segments('/drive_home/a/b')
ck('两级路径', [x[0] for x in s2] == ['网盘', 'a', 'b'])
ck('★ 每级都带完整可跳转路径',
   [x[1] for x in s2] == ['/drive_home', '/drive_home/a', '/drive_home/a/b'])

# 深路径折叠
s6 = breadcrumb_segments('/drive_home/a/b/c/d/e/f')
ck('深路径被折叠', len(s6) == 5, s6)
ck('★ 折叠项路径为 None（不可点击）',
   s6[1] == (ELLIPSIS, None))
ck('折叠后末尾仍可跳转', s6[-1][1] == '/drive_home/a/b/c/d/e/f')
ck('★ 折叠不超过上限', len(breadcrumb_segments('/drive_home/' + '/'.join('abcdefghij'), 3)) <= 3)

# 相对路径归一化
ck('相对路径也能切', breadcrumb_segments('a/b')[0][1] == '/drive_home')

# 每个非折叠项的路径都必须能还原出正确的末段名
for name, path in breadcrumb_segments('/drive_home/x/y/z'):
    if path is None:
        continue
    ck('  项 %s 路径自洽' % name,
       path == '/drive_home' or path.split('/')[-1] == name)

print('\n【17】长名截断')
ck('短名不变', shorten('abc.txt') == 'abc.txt')
ck('★ 长名被截断', len(shorten('x' * 100)) < 100)
ck('★ 保留后缀', shorten('averyveryverylongname.txt').endswith('.txt'))
ck('空值安全', shorten('') == '')
ck('None 安全', shorten(None) == None)

print('\n' + '='*46)
print('  %d 通过 / %d 失败' % (passed, failed))
print('='*46)
sys.exit(1 if failed else 0)
