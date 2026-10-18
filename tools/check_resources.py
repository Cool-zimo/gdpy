"""收尾检查 · 打包资源完整性

★ 为什么单独一个脚本：
  PyInstaller 只自动收集 .py，其他全是 data 文件，必须显式 --add-data。
  漏了的表现是**静默的** —— exe 能起来、功能缺失、不报错，最难查。
  （v0.0.4 就是漏了 shim.js，启动即崩溃。）

★ 为什么必须有白名单：
  不是每个非 .py 文件都需要进包（构建脚本、requirements 都不需要）。
  不加白名单的话脚本每次都红，红久了就没人看 ——
  「狼来了」比「没检查」更糟。所以每条豁免都必须写清理由。
"""
import os
import re
import sys

# ★ 豁免：不需要进包的文件，每条必须写理由
EXEMPT = {
    'requirements.txt': '构建期依赖，运行时不需要',
    '本地构建_Windows.bat': '本地构建脚本，不进产物',
    'gdrive/webview/shim.js': (
        '★ 已内嵌成 shim_data.py（v0.0.5）。'
        'v0.0.4 就是漏了这个文件导致启动崩溃 —— 修法不是补 --add-data，'
        '而是内嵌，从根上不依赖外部文件。'
    ),
    'tools/quark.json': '站点生成用（tools/gen_site.py），运行时不读',
    'assets/icon.ico': (
        '★ 只给 Windows 的 PyInstaller --icon 用（构建期）。'
        '另外两款平台用不到它，打包进去纯属浪费。'
    ),
    'assets/icon.icns': (
        '★ 只给 macOS 的 PyInstaller --icon 用（构建期），同一理由。'
        '且 macOS 走 --onefile 没有 .app bundle，--icon 实际不生效 ——'
        '那边真正显示图标的是运行时那张 icon.png。'
    ),
}

# ★ 按前缀豁免 —— 曾经这里是逐文件写死两个 tests/js/*.js。
#   后来新增 test_plaza_xss.js / test_shim.cjs 没同步进来，脚本立刻变红：
#   「每加一个测试文件就要改一次豁免清单」本身就是设计缺陷。
#   测试代码整体不属于产物，按目录豁免一次到位。
EXEMPT_PREFIXES = {
    'tests/': '测试代码（pytest / node 跑），不属于产物',
}

SKIP_DIRS = {'.git', '__pycache__', 'build', 'dist', '.github',
             'docs', 'node_modules', 'web', '.idea', '.vscode'}
SKIP_FILES = {'.gitignore', 'VERSION', 'README.md', 'LICENSE',
              '.gitattributes', '.editorconfig'}


def declared_in_workflow(path='.github/workflows/build.yml'):
    """从 workflow 里解析 --add-data 声明"""
    if not os.path.exists(path):
        return set()
    src = open(path, encoding='utf-8').read()
    out = set(re.findall(r'--add-data\s+"?([^";\s]+)', src))
    out |= set(re.findall(r'--add-data=([^;\s]+)', src))
    return out


def scan(root='.'):
    """返回 (missing, exempt_hit)"""
    declared = declared_in_workflow(os.path.join(root, '.github/workflows/build.yml'))
    missing, exempt_hit = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            rel = os.path.relpath(os.path.join(dirpath, f), root).replace('\\', '/')
            if f.endswith(('.py', '.pyc', '.pyo')) or f in SKIP_FILES:
                continue
            if rel in EXEMPT:
                exempt_hit.append((rel, EXEMPT[rel]))
                continue
            pre = next((p for p in EXEMPT_PREFIXES if rel.startswith(p)), None)
            if pre:
                exempt_hit.append((rel, EXEMPT_PREFIXES[pre]))
                continue
            top = rel.split('/')[0]
            covered = any(rel in d or top in d for d in declared)
            if not covered:
                missing.append(rel)
    return missing, exempt_hit


# ★ web/ 整体在 SKIP_DIRS 里（它由 sync_web.py 从 github_drive 同步而来，
#   不是我们手写的），但其中有几个是**缺了就整个应用起不来**的关键文件，
#   必须单独点名检查。
#
#   ★★ 这段代码原本放在文件最末尾，也就是
#       `if __name__ == '__main__': sys.exit(main())` **之后** ——
#       sys.exit 一调用进程就结束了，后面的语句永远不会执行，
#       而且里面还用了根本没定义的 ROOT（真跑起来会 NameError）。
#
#       于是这个检查从写下那一刻起就没生效过，却一直给人
#       "已经有人盯着"的错觉 —— 跟 CI 里那三次「写了测试没人跑」
#       是完全同一个坑，这次是在检查脚本自己身上。
#       现在挪进 main()，真正执行。
WEB_CRITICAL = [
    ('web/index.html', '整个前端的入口'),
    ('web/js/maintain.js', '面包屑常量定义在这里；缺了 getBreadcrumbs 会 ReferenceError'),
    ('web/js/app.js', '主应用逻辑'),
    ('web/js/file-manager.js', '文件列表与上传下载'),
]


def check_web(root):
    """返回缺失的关键前端文件列表"""
    bad = []
    for rel, why in WEB_CRITICAL:
        if not os.path.isfile(os.path.join(root, rel)):
            bad.append((rel, why))
    return bad


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    missing, exempt = scan(root)
    web_bad = check_web(root)
    print('=' * 60)
    print('打包资源检查  (root=%s)' % root)
    print('=' * 60)
    print('\n豁免 %d 个（每条都有理由）：' % len(exempt))
    for p, why in sorted(exempt):
        print('  - %-32s %s' % (p, why))
    print('\n★ 未声明 %d 个：' % len(missing))
    for p in sorted(missing):
        print('  ✗ %s' % p)
    print('\n★ 关键前端文件 %d 项：' % len(WEB_CRITICAL))
    for rel, why in WEB_CRITICAL:
        ok = not any(rel == b[0] for b in web_bad)
        print('  %s %-28s %s' % ('✓' if ok else '✗', rel, '' if ok else why))
    print('\n' + '=' * 60)
    if web_bad:
        print('失败：关键前端文件缺失，先跑 tools/sync_web.py')
        return 1
    if missing:
        print('失败：有资源未声明 --add-data')
        print('（若确认不需要进包，请加进 EXEMPT 并写明理由）')
        return 1
    print('通过：所有运行时资源均已声明')
    return 0


if __name__ == '__main__':
    sys.exit(main())
