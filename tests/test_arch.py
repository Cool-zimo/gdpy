"""
架构守护测试 —— 防的是**架构退化**，不是功能 bug

═══════════════════════════════════════════════════════════════
为什么需要这个文件
═══════════════════════════════════════════════════════════════

2026-09-26 做了一次架构收口：Python 侧删掉了 vfs.py / transfer.py /
storage.py / share.py（共 1417 行），业务逻辑归前端 js 独有。

原因：同一套逻辑两份实现，为此付过三次学费——
  1. `fileIndex` vs `vfs` 字段名对不上   → 跨端读不到文件
  2. `repoUsage` 一个 int 一个 {size}    → 相加直接崩
  3. `minChunkSize` 差 20 倍             → 文件形态分裂

**但删代码只是一次性的，退化是持续的压力。**
下一个写功能的人（包括未来的我）最自然的做法就是：
"这个计算 Python 做起来方便" —— 然后在 core/ 下加一个模块。
半年后又是两套实现。

这个文件就是那道闸：**不是禁止写 Python，而是让它无法悄悄发生。**

═══════════════════════════════════════════════════════════════
允许的 Python 职责（白名单）
═══════════════════════════════════════════════════════════════

  1. http_request  —— GitHub API 代理（浏览器有 CORS，桌面版没有）
  2. 本地文件读写 / 文件对话框
  3. exec          —— 插件能力
  4. 离线维护工具  —— maintain / recover（批量修复，不参与运行时）
  5. 纯格式约定    —— contract.py（路径前缀、base36）

❌ 不允许：上传、分片、配额计算、仓库选择、分享 —— 这些全在 web/js/
"""
import ast
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PASSED = FAILED = 0


def ck(label, cond, extra=''):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print('  ✓ ' + label)
    else:
        FAILED += 1
        print('  ✗ ' + label + '  ' + str(extra))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


# ─────────────────────────────────────────────────────────────
print('\n【1】★ 业务实现模块不得复活')
# ─────────────────────────────────────────────────────────────
# ★ 这些模块曾经存在过，且是双实现漂移的源头。
#   如果哪天有人重建了它们，这里会立刻红 —— 而不是等到跨端读不到文件时才发现。
DEAD_MODULES = ('vfs.py', 'transfer.py', 'storage.py', 'share.py')
core_dir = os.path.join(ROOT, 'gdrive', 'core')
present = [m for m in DEAD_MODULES if os.path.exists(os.path.join(core_dir, m))]
ck('★ core/ 下不存在业务实现模块', not present, present)

# ui/app.py 是 Tkinter 旧版，同样属于被收口掉的一层
ck('★ ui/app.py（Tkinter 旧版）已移除',
   not os.path.exists(os.path.join(ROOT, 'gdrive', 'ui', 'app.py')))


# ─────────────────────────────────────────────────────────────
print('\n【2】★ config.py 不得定义业务默认值')
# ─────────────────────────────────────────────────────────────
# ★ 这是 minChunkSize 差 20 倍那次事故的根因：
#   Python 定义了"分片策略应该是什么"，而线上是用户自己设的另一个值。
#   Python 只该读取"现在是什么"，不该持有"应该是什么"的意见。
src = read('gdrive/core/config.py')
tree = ast.parse(src)

bad = []
for node in ast.walk(tree):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id.startswith('DEFAULT_'):
                bad.append(t.id)
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        if node.target.id.startswith('DEFAULT_'):
            bad.append(node.target.id)

ck('★ 无 DEFAULT_ 常量（契约副本）', not bad, bad)

# 业务常量名也不该以字面量形式出现在 config.py
for name in ('minChunkSize', 'maxRepoSize', 'autoCreateRepo'):
    ck('  config.py 不含业务字段 %r' % name,
       ("'%s'" % name) not in src and ('"%s"' % name) not in src)


# ─────────────────────────────────────────────────────────────
print('\n【3】★ 契约只住在 contract.py')
# ─────────────────────────────────────────────────────────────
ck('contract.py 存在', os.path.exists(os.path.join(core_dir, 'contract.py')))

contract_src = read('gdrive/core/contract.py')
ck('  contract.py 定义 DRIVE_HOME', 'DRIVE_HOME' in contract_src)
ck('  contract.py 定义 _b36（与 JS 同形的编码）', 'def _b36' in contract_src)

# ★ contract.py 必须是纯的：不能发请求、不能读写文件
for forbidden in ('urllib', 'requests', 'open(', 'import os'):
    ck('  ★ contract.py 不碰 IO（%s）' % forbidden,
       forbidden not in contract_src)
# 注：open( 的词形会命中 open_in_explorer 之类，这里只扫本文件，已足够


# ─────────────────────────────────────────────────────────────
print('\n【4】★ 运行时入口不加载业务模块')
# ─────────────────────────────────────────────────────────────
entry = read('webview_main.py')
for m in ('vfs', 'transfer', 'storage', 'share', 'ui.app'):
    ck('  入口不 import %s' % m, ('import %s' % m) not in entry)

bridge_src = read('gdrive/webview/bridge.py')
# ★ bridge 只提供桥接能力；出现业务方法名说明职责越界
BIZ_METHODS = ('upload', 'upload_chunk', 'pick_repo', 'split_file',
               'create_share', 'download_chunk')
found = [m for m in BIZ_METHODS if ('def %s' % m) in bridge_src]
ck('★ bridge 不含业务方法', not found, found)

# bridge 必须有的桥接能力
for m in ('http_request', 'read_file_b64', 'write_file_b64', 'exec_command'):
    ck('  bridge 提供 %s' % m, ('def %s' % m) in bridge_src)


# ─────────────────────────────────────────────────────────────
print('\n【5】★ 前端 js 是业务实现的唯一来源')
# ─────────────────────────────────────────────────────────────
web_js = os.path.join(ROOT, 'web', 'js')
if os.path.isdir(web_js):
    js_files = [f for f in os.listdir(web_js) if f.endswith('.js')]
    ck('  web/js 已同步（%d 个文件）' % len(js_files), len(js_files) > 0)
    for need in ('storage.js', 'file-manager.js', 'github-api.js'):
        ck('  业务实现 %s 存在' % need, need in js_files)
else:
    # web/ 由 tools/sync_web.py 生成，CI 上可能尚未跑过
    print('  ⚠ web/ 不存在（执行 tools/sync_web.py 生成），跳过 js 检查')


# ─────────────────────────────────────────────────────────────
print('\n【6】★ 插件不得依赖业务实现')
# ─────────────────────────────────────────────────────────────
# ★ 插件拿到的 ctx 只应有本地能力。
#   一旦插件能调 GitHub 业务接口，权限模型就形同虚设
#   （fs:read 的插件能通过它读走网盘内容）。
plugins_dir = os.path.join(ROOT, 'plugins')
if os.path.isdir(plugins_dir):
    import re
    used = set()
    for root, _dirs, files in os.walk(plugins_dir):
        for fn in files:
            if fn.endswith('.py'):
                with open(os.path.join(root, fn), encoding='utf-8') as f:
                    used |= set(re.findall(r'ctx\.([a-z_]+)', f.read()))
    allowed = {'log', 'progress', 'param', 'require', 'read_file',
               'write_file', 'list_dir', 'exec'}
    leaked = sorted(used - allowed)
    ck('★ 插件只用本地能力', not leaked, leaked)
    ck('  插件确实在跑（ctx 接口数 > 0）', len(used) > 0, used)
else:
    print('  ⚠ plugins/ 不存在，跳过')


print('\n' + '=' * 52)
print('  %d 通过 / %d 失败' % (PASSED, FAILED))
print('=' * 52)
sys.exit(1 if FAILED else 0)
