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
    'tests/js/test_maintain.js': '前端 js 单元测试（node 跑），不进产物',
    'tests/js/test_breadcrumb.js': '前端 js 单元测试（node 跑），不进产物',
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
            top = rel.split('/')[0]
            covered = any(rel in d or top in d for d in declared)
            if not covered:
                missing.append(rel)
    return missing, exempt_hit


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    missing, exempt = scan(root)
    print('=' * 60)
    print('打包资源检查  (root=%s)' % root)
    print('=' * 60)
    print('\n豁免 %d 个（每条都有理由）：' % len(exempt))
    for p, why in sorted(exempt):
        print('  - %-32s %s' % (p, why))
    print('\n★ 未声明 %d 个：' % len(missing))
    for p in sorted(missing):
        print('  ✗ %s' % p)
    print('\n' + '=' * 60)
    if missing:
        print('失败：有资源未声明 --add-data')
        print('（若确认不需要进包，请加进 EXEMPT 并写明理由）')
        return 1
    print('通过：所有运行时资源均已声明')
    return 0


if __name__ == '__main__':
    sys.exit(main())

# ★ js/maintain.js 必须存在于 web/ —— 面包屑常量定义在里面
#   缺失时 file-manager.js 的 getBreadcrumbs 会 ReferenceError，
#   表现为整个文件列表打不开（V0.0.4 shim.js 同类问题）
_mf = os.path.join(ROOT, 'web', 'js', 'maintain.js')
if not os.path.isfile(_mf):
    print('✗ web/js/maintain.js 不存在（面包屑依赖它定义的常量）')
    print('  先跑： GITHUB_TOKEN=xxx python tools/sync_web.py')
    bad.append('web/js/maintain.js')
else:
    print('✓ web/js/maintain.js 已同步')
