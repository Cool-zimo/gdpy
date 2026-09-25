# -*- coding: utf-8 -*-
"""
插件套件测试 —— 4 个内置插件 + 权限模型

★ 每个插件都造真实文件跑，不 mock 文件系统。
  插件的核心价值就是"真的能碰本地文件"，mock 掉等于没测。
"""
import base64
import importlib.util
import json
import os
import shutil
import struct
import sys
import tempfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.plugins import (ALL_PERMISSIONS, Plugin, PluginContext,
                                 PluginManager, is_blocked, is_official,
                                 normalize_perms)

PASS = FAIL = 0


def ck(name, ok, extra=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  ✓  ', name)
    else:
        FAIL += 1
        print('  ✗  ', name, ('  → %s' % extra) if extra else '')


def load(pid):
    """按 plugins.py 的方式加载插件入口"""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    d = os.path.join(here, 'plugins', pid)
    man = json.load(open(os.path.join(d, 'plugin.json'), encoding='utf-8'))
    spec = importlib.util.spec_from_file_location('t_%s' % pid,
                                                  os.path.join(d, man['entry']))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m, man


class FakeGrants:
    def __init__(self, allow):
        self.allow = set(allow)
        self.checked = []

    def check(self, pid, perm):
        self.checked.append((pid, perm))
        if perm not in self.allow:
            raise PermissionError('未授权: %s' % perm)


def ctx_for(pid, allow, params=None):
    return PluginContext(pid, FakeGrants(allow), params)


def make_png(w, h, rgb=True):
    """造一个真 PNG"""
    ct = 2 if rgb else 0
    bpp = 3 if rgb else 1
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            px = bytes([(x * 7 + y * 3) % 256] * bpp)
            raw += px
    def chunk(t, b):
        return (struct.pack('>I', len(b)) + t + b
                + struct.pack('>I', zlib.crc32(t + b) & 0xFFFFFFFF))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 1))   # 故意用低压缩率
            + chunk(b'IEND', b''))


print('=' * 50)
print('插件测试')
print('=' * 50)

TMP = tempfile.mkdtemp(prefix='gdpy-plugin-')

# ---------------------------------------------------------------- 清单
print('\n【1】plugin.json 清单')
PIDS = ['folder-sync', 'image-compress', 'markdown-preview', 'auto-backup']
MANIFESTS = {}
for pid in PIDS:
    m, man = load(pid)
    MANIFESTS[pid] = man
    ck('%s 有 id/name/version' % pid,
       man.get('id') == pid and man.get('name') and man.get('version'))
    ck('%s 权限都在白名单内' % pid,
       all(p in ALL_PERMISSIONS for p in man.get('permissions', [])),
       man.get('permissions'))
    ck('%s 是官方来源（自动授信）' % pid, is_official(man.get('repo', '')))
    ck('%s 声明了 params' % pid, isinstance(man.get('params'), dict))

# ---------------------------------------------------------------- folder-sync
print('\n【2】folder-sync 本地同步')
fs_mod = MANIFESTS and load('folder-sync')[0]
src = os.path.join(TMP, 'syncsrc')
os.makedirs(os.path.join(src, 'sub'))
for n, c in [('a.txt', 'hello'), ('b.txt', 'world'), ('sub/c.txt', 'ccc')]:
    open(os.path.join(src, n), 'w').write(c)

plan = fs_mod.build_plan(src, '/sync', 'both', False, None)
ck('远端为空 → 全部上传', plan['counts']['upload'] == 3, plan['counts'])
ck('upload 带 remote 路径',
   all(x['remote'].startswith('/sync/') for x in plan['upload']))
ck('子目录相对路径正确',
   any(x['rel'] == 'sub/c.txt' for x in plan['upload']))

# 远端已有同名同大小同 mtime → 不变
idx = [{'path': '/sync/' + x['rel'], 'size': x['size'], 'mtime': x['mtime']}
       for x in fs_mod._walk_local(src)]
plan2 = fs_mod.build_plan(src, '/sync', 'both', False, idx)
ck('完全一致 → 无上传', plan2['counts']['upload'] == 0, plan2['counts'])
ck('无变化计数 = 3', plan2['counts']['unchanged'] == 3)

# 远端多出一个文件
idx3 = idx + [{'path': '/sync/gone.txt', 'size': 5, 'mtime': 1}]
plan3 = fs_mod.build_plan(src, '/sync', 'both', False, idx3)
ck('远端多余 → both 下要下载', plan3['counts']['download'] == 1)
plan4 = fs_mod.build_plan(src, '/sync', 'push', True, idx3)
ck('★ push + delete → 删远端', plan4['counts']['delete_remote'] == 1)
ck('★ push 不删本地', plan4['counts']['delete_local'] == 0)
plan5 = fs_mod.build_plan(src, '/sync', 'both', True, idx3)
ck('★ both + delete 也不删远端（安全）',
   plan5['counts']['delete_remote'] == 0)

# 本地改了 → 要传
open(os.path.join(src, 'a.txt'), 'w').write('hello world')
plan6 = fs_mod.build_plan(src, '/sync', 'both', False, idx)
ck('本地变大 → 检测到冲突', plan6['counts']['upload'] >= 1)

# 忽略规则
open(os.path.join(src, '.DS_Store'), 'w').write('x')
os.makedirs(os.path.join(src, 'node_modules'), exist_ok=True)
open(os.path.join(src, 'node_modules', 'x.js'), 'w').write('x')
plan7 = fs_mod.build_plan(src, '/sync', 'push', False, None)
rels = [x['rel'] for x in plan7['upload']]
ck('忽略 .DS_Store', '.DS_Store' not in rels)
ck('忽略 node_modules', not any(r.startswith('node_modules') for r in rels))

# 权限
c = ctx_for('folder-sync', [], {'local_dir': src, 'dry_run': True})
r = fs_mod.run(c)
ck('★ 未授权 fs:list → 明确失败', r.get('ok') is False and 'error' in r)
c = ctx_for('folder-sync', ['fs:list'], {'local_dir': src, 'dry_run': True})
r = fs_mod.run(c)
ck('授权后成功', r.get('ok') is not False)
ck('★ dry_run 默认不动文件', r.get('executed') is False)
c = ctx_for('folder-sync', ['fs:list'], {'local_dir': '/no/such/dir'})
ck('目录不存在 → 报错不炸', fs_mod.run(c).get('ok') is False)

# ---------------------------------------------------------------- image-compress
print('\n【3】image-compress 图片压缩')
ic = load('image-compress')[0]
png = make_png(64, 64)
ck('造出的 PNG 可解析', png.startswith(b'\x89PNG'))
out = ic.recompress_png(png)
ck('★ PNG 重压后更小', len(out) < len(png), '%d → %d' % (len(png), len(out)))
ck('★ 重压后仍是合法 PNG', out.startswith(b'\x89PNG\r\n\x1a\n'))
ck('★ 重压后能被再解析（往返）', ic.recompress_png(out).startswith(b'\x89PNG'))

# 无损校验：解回原始像素必须一致
def pixels_of(data):
    cs = ic._chunks(data)
    ihdr = [b for t, b in cs if t == b'IHDR'][0]
    w, h, bd, ct = struct.unpack('>IIBB', ihdr[:10])
    idat = b''.join(b for t, b in cs if t == b'IDAT')
    return ic._unfilter(zlib.decompress(idat), w, h, 3 if ct == 2 else 1), w, h

p1, w1, h1 = pixels_of(png)
p2, w2, h2 = pixels_of(out)
ck('★★ 无损：像素完全一致', p1 == p2 and (w1, h1) == (w2, h2))
ck('尺寸不变', (w1, h1) == (64, 64))

gray = make_png(32, 32, rgb=False)
g2 = ic.recompress_png(gray)
ck('灰度 PNG 也能压', len(g2) < len(gray))

try:
    ic.recompress_png(b'not a png')
    ck('非 PNG 抛错', False)
except ValueError:
    ck('非 PNG 抛 ValueError', True)

# 跑完整流程
ind = os.path.join(TMP, 'imgs')
os.makedirs(ind)
open(os.path.join(ind, 'a.png'), 'wb').write(png)
open(os.path.join(ind, 'b.jpg'), 'wb').write(b'\xff\xd8\xff\xe0' + b'x' * 500)
outd = os.path.join(TMP, 'imgout')
c = ctx_for('image-compress', ['fs:read', 'fs:list', 'fs:write', 'exec'],
            {'input': ind, 'output': outd})
r = ic.run(c)
ck('整目录跑通', r.get('ok') is True)
ck('输出 2 个结果', len(r.get('items', [])) == 2)
ck('PNG 输出文件已生成', os.path.isfile(os.path.join(outd, 'a.png')))
jpg_item = [x for x in r['items'] if x['path'].endswith('.jpg')][0]
ck('★ JPEG 处理失败时不假装成功',
   jpg_item['ok'] is False and bool(jpg_item['note']), jpg_item.get('note'))
# 单独验证"本机没工具"这条分支（沙盒装了 ffmpeg，上面走不到）
_no_tool = ic.compress_one(os.path.join(ind, 'b.jpg'),
                           os.path.join(outd, 'z.jpg'), 80, [],
                           ctx_for('image-compress', ['fs:read', 'exec'], {}))
ck('★ 无工具时明确报"未安装"',
   _no_tool['ok'] is False and '未安装' in (_no_tool['note'] or ''),
   _no_tool.get('note'))
ck('有 saved 统计', isinstance(r.get('saved'), int))
ck('progress 已上报', 0 < c.progress_value <= 1)

# ★ compress_one 内部直接 open()，不走 ctx.read_file ——
#   必须显式 ctx.require('fs:read')，否则权限模型漏一个大洞
try:
    ic.compress_one(os.path.join(ind, 'a.png'), os.path.join(outd, 'z.png'),
                    80, [], ctx_for('image-compress', ['exec'], {}))
    ck('★ 缺 fs:read 被拦截（直接 open 的场景）', False)
except PermissionError:
    ck('★ 缺 fs:read 被拦截（直接 open 的场景）', True)
# 有 fs:read 时放行
_rr = ic.compress_one(os.path.join(ind, 'a.png'), os.path.join(outd, 'z2.png'),
                      80, [], ctx_for('image-compress', ['fs:read'], {}))
ck('有 fs:read 时 compress_one 放行', _rr['ok'] is True, _rr)

# ---------------------------------------------------------------- markdown-preview
print('\n【4】markdown-preview')
mp = load('markdown-preview')[0]
ck('# 标题', mp.render('# Hi').startswith('<h1>'))
ck('## 二级', mp.render('## Sub').startswith('<h2>'))
ck('无序列表', '<ul><li>a</li>' in mp.render('- a'))
ck('有序列表', '<ol><li>a</li>' in mp.render('1. a'))
ck('任务列表', 'type="checkbox"' in mp.render('- [x] done'))
ck('引用', mp.render('> q').startswith('<blockquote>'))
ck('分隔线', '<hr>' in mp.render('---'))
ck('粗体', '<strong>b</strong>' in mp.render('**b**'))
ck('行内码', '<code>x</code>' in mp.render('`x`'))
ck('★ 行内码里的 * 不当强调',
   '<em>' not in mp.render('`a*b*c`'), mp.render('`a*b*c`'))
ck('代码块', '<pre><code' in mp.render('```\nx=1\n```'))
ck('★ 代码里的 * 不当强调', '<em>' not in mp.render('```\na*b\n```'))
ck('表格', '<table>' in mp.render('|a|b|\n|-|-|\n|1|2|'))
ck('表格对齐', 'text-align:right' in mp.render('|a|b|\n|--:|--:|\n|1|2|'))
ck('链接', '<a href="https://a.com"' in mp.render('[x](https://a.com)'))
ck('★ javascript: 不渲染成链接',
   '<a href="javascript' not in mp.render('[x](javascript:alert(1))'))
ck('★ 表格里 <script> 不成标签',
   '<script>' not in mp.render('| <script>x</script> | b |\n|-|-|'))
ck('★ 标题里 <script> 不成标签',
   '<script>' not in mp.render('# <script>x</script>'))
ck('★ img onerror 不成标签',
   '<img src="x" onerror="alert(1)">' not in mp.render('![a](x)'))
ck('裸公式 ^2', '<sup>2</sup>' in mp.render('(5-2)^2 = 9'),
   mp.render('(5-2)^2 = 9'))
ck('★ 中文多时公式仍渲染',
   '<sup>2</sup>' in mp.render('假设 a=5、b=2，演示 (5-2)^2 展开'))
ck('$ 包裹公式', '<span class="math">' in mp.render('$x^2$'))
ck('分数', 'frac' in mp.render(r'$\frac{a}{b}$'))
ck('希腊字母', 'α' in mp.render(r'$\alpha$'))
ck('★ 普通中文不产生 math',
   '<span class="math">' not in mp.render('这是一个普通的中文句子'))
ck('★ 文件名 my_file.js 不误判',
   '<sub>' not in mp.render('请修改 my_file.js 这个文件'))

mdp = os.path.join(TMP, 't.md')
open(mdp, 'w', encoding='utf-8').write('# 标题\n\n正文 **粗**\n\n- a\n')
outh = os.path.join(TMP, 't.html')
c = ctx_for('markdown-preview', ['fs:read', 'fs:list', 'fs:write'],
            {'input': mdp, 'output': outh})
r = mp.run(c)
ck('整文件渲染成功', r.get('ok') is True)
ck('HTML 已落盘', os.path.isfile(outh))
ck('HTML 含 doctype', open(outh, encoding='utf-8').read().startswith('<!DOCTYPE'))
ck('★ 缺 fs:read 被拦截',
   mp.run(ctx_for('markdown-preview', [], {'input': mdp})).get('ok') is False)
ck('文件不存在 → 报错', mp.run(ctx_for('markdown-preview', ['fs:read'],
   {'input': '/no/such.md'})).get('ok') is False)

# ---------------------------------------------------------------- auto-backup
print('\n【5】auto-backup 自动备份')
ab = load('auto-backup')[0]
wd = os.path.join(TMP, 'watch')
os.makedirs(os.path.join(wd, '.git'))
open(os.path.join(wd, 'x.txt'), 'w').write('one')
open(os.path.join(wd, '.git', 'cfg'), 'w').write('x')

scan1 = ab.scan(wd, '')
ck('扫描到文件', 'x.txt' in scan1)
ck('★ 默认排除 .git', not any(k.startswith('.git') for k in scan1))
ck('记录 size+mtime', isinstance(scan1['x.txt'], list) and len(scan1['x.txt']) == 2)

d = ab.diff(scan1, {})
ck('首次全量', len(d['changed']) == len(scan1))
ck('无删除', d['deleted'] == [])
d2 = ab.diff(scan1, scan1)
ck('★ 无变动 → 空', d2['changed'] == [] and d2['deleted'] == [])
d3 = ab.diff({}, scan1)
ck('★ 文件消失 → deleted', d3['deleted'] == ['x.txt'])

dd = os.path.join(TMP, 'abdata')
dd_run = os.path.join(TMP, 'abdata_run')   # 运行时用干净目录，避免被上面的手工 save 污染
sp = ab.state_path_for(wd, dd)
ck('状态文件名含哈希', 'auto-backup-' in sp and sp.endswith('.json'))
ck('空状态读到 {}', ab.load_state(sp) == {})
ab.save_state(sp, scan1)
ck('★ 状态往返一致', ab.load_state(sp) == scan1)
ck('状态文件存在', os.path.isfile(sp))
ck('★ 不同目录 → 不同状态文件',
   ab.state_path_for(os.path.join(TMP, 'other'), dd) != sp)

c = ctx_for('auto-backup', ['fs:read', 'fs:list', 'fs:write'],
            {'watch_dir': wd, 'remote_path': '/backup', 'rounds': 1,
             'data_dir': dd_run})
r = ab.run(c)
ck('跑通一轮', r.get('ok') is True)
ck('产生 1 个快照', len(r['snapshots']) == 1)
ck('快照带时间戳目录',
   r['snapshots'][0]['remote_dir'].startswith('/backup/'))
ck('首轮全量变动', r['total_changed'] >= 1)
ck('状态已写入', os.path.isfile(r['state_file']))

r2 = ab.run(ctx_for('auto-backup', ['fs:read', 'fs:list', 'fs:write'],
                    {'watch_dir': wd, 'rounds': 1, 'data_dir': dd_run}))
ck('★★ 第二轮无重复上传（增量生效）', r2['total_changed'] == 0,
   r2['total_changed'])
open(os.path.join(wd, 'y.txt'), 'w').write('new')
r3 = ab.run(ctx_for('auto-backup', ['fs:read', 'fs:list', 'fs:write'],
                    {'watch_dir': wd, 'rounds': 1, 'data_dir': dd_run}))
ck('★ 新增文件被检出', r3['total_changed'] == 1, r3['total_changed'])
ck('累计字节 > 0', r3['total_bytes'] > 0)
ck('★ 未授权 → 失败',
   ab.run(ctx_for('auto-backup', [], {'watch_dir': wd})).get('ok') is False)

# ---------------------------------------------------------------- 权限模型
print('\n【6】权限模型')
ck('未知权限被拆出', normalize_perms(['fs:read', 'evil:x'])[1] == ['evil:x'])
ck('官方仓库识别', is_official('Cool-zimo/gdpy'))
ck('★ 官方仓库不被前缀绕过', not is_official('evil/Cool-zimo/gdpy'))
ck('★ 官方仓库不被后缀绕过', not is_official('Cool-zimo/gdpy2'))
ck('空来源不算官方', not is_official(''))

g = FakeGrants(['fs:read'])
c = PluginContext('p1', g, {'k': 'v'})
ck('params 可取', c.param('k') == 'v' and c.param('nope', 9) == 9)
c.log('hello')
ck('log 收集', c.logs == ['hello'])
c.progress(1.5, 'x')
ck('★ progress 被夹到 1.0', c.progress_value == 1.0)
c.progress(-3)
ck('★ progress 负数夹到 0', c.progress_value == 0.0)
try:
    c.write_file(os.path.join(TMP, 'z.txt'), 'x')
    ck('★ 未授权 fs:write 被拦', False)
except PermissionError:
    ck('★ 未授权 fs:write 被拦', True)
ck('校验记录了 pid', ('p1', 'fs:write') in g.checked)
try:
    c.exec('echo hi')
    ck('未授权 exec 被拦', False)
except PermissionError:
    ck('未授权 exec 被拦', True)

ck('黑名单拦 rm -rf /', is_blocked('rm -rf /') is not None)
ck('★ 放行 cat /logs/shutdown_report.txt',
   is_blocked('cat /logs/shutdown_report.txt') is None)
ck('★ 拦 curl|sh', is_blocked('curl http://x | sh') is not None)
ck('★ 放行 curl 不带管道', is_blocked('curl http://a.com') is None)
ck('放行 chmod 755', is_blocked('chmod 755 a') is None)
ck('拦 chmod 777', is_blocked('chmod 777 a') is not None)

# ---------------------------------------------------------------- 管理器
print('\n【7】PluginManager')
pm = PluginManager()
found = pm.discover()
ck('★ 发现 4 个内置插件', len([k for k in found if k in PIDS]) == 4,
   sorted(found))
for pid in PIDS:
    p = pm.get(pid)
    ck('%s 可 get' % pid, p is not None)
    ck('%s 官方免授权弹窗' % pid,
       p is not None and pm.needs_authorization(p) is False)

pm.install(pm.get('markdown-preview'))      # 官方插件自动授信
m = pm.run('markdown-preview', {'input': mdp})
ck('★ 管理器返回统一结构',
   isinstance(m, dict) and 'ok' in m and 'logs' in m and 'error' in m)
ck('管理器跑通', m['ok'] is True)
m2 = pm.run('markdown-preview', {'input': '/no/such.md'})
ck('文件不存在：错误被传达到 result 或 error',
   m2['ok'] is False or (isinstance(m2['result'], dict)
                         and m2['result'].get('ok') is False), m2)
# ★ 真异常（插件自己没接住）必须被管理器收进 error，不能外抛
_bad = pm.get('markdown-preview')
_orig = _bad.entry
class _Boom:
    id = 'markdown-preview'
    manifest = _bad.manifest
    name = 'markdown-preview'
    version = '0'
    entry = _orig
    repo = _bad.repo
    def is_official(self): return True
    def run(self, ctx): raise RuntimeError('boom')
pm._plugins['markdown-preview'] = _Boom()
m2b = pm.run('markdown-preview', {})
ck('★★ 插件抛异常不外抛，收进 error',
   m2b['ok'] is False and 'boom' in (m2b['error'] or ''), m2b)
ck('★★ traceback 进了 logs', any('Traceback' in x for x in m2b['logs']))
pm._plugins['markdown-preview'] = _bad
# 未授权路径：先跑一个没 install 的
m3 = pm.run('auto-backup', {'watch_dir': TMP})
ck('★ 未授权的插件被拒且带 denied 标记',
   m3['ok'] is False and m3.get('denied') is True, m3)
try:
    pm.run('no-such-plugin')
    ck('插件不存在 → 抛错', False)
except RuntimeError:
    ck('插件不存在 → 抛 RuntimeError', True)

shutil.rmtree(TMP, ignore_errors=True)

print('\n' + '=' * 50)
print('  %d 通过 / %d 失败' % (PASS, FAIL))
print('=' * 50)
sys.exit(1 if FAIL else 0)
