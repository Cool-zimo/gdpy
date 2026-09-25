"""
把 shim.js 内嵌成 Python 常量 → gdrive/webview/shim_data.py

★ 为什么必须内嵌：
  PyInstaller 只自动收集 .py/.pyd/.so。.js 属于 data 文件，
  必须显式 --add-data 才会进 exe。而 gdrive/webview/shim.js 藏在包目录里，
  很容易被漏掉 —— V0.0.4 就是这样崩的：源码环境一切正常，
  打包后 open('shim.js') 直接 WinError 2。

  内嵌后这个问题从根上消失：shim 跟 .py 一起走，不需要任何 --add-data。

★ 防漂移：
  shim.js 和 shim_data.py 两份内容必须一致，
  tests/test_webview.py 里有断言盯着，改了 shim.js 忘了重跑本脚本会红。

用法：
    python tools/gen_shim_data.py
"""
import base64
import os
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'gdrive', 'webview', 'shim.js')
DST = os.path.join(ROOT, 'gdrive', 'webview', 'shim_data.py')


def main():
    with open(SRC, 'rb') as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode('ascii')

    lines = []
    for i in range(0, len(b64), 76):
        lines.append('    "%s"' % b64[i:i + 76])

    out = '''"""
自动生成的 shim 内嵌数据 —— 请勿手工编辑

由 tools/gen_shim_data.py 从 shim.js 生成。
改了 shim.js 之后必须重跑该脚本，否则测试会红。

为什么要内嵌见 tools/gen_shim_data.py 顶部注释：
不内嵌的话打包后 open('shim.js') 会失败（WinError 2）。
"""
import base64

SHIM_B64 = (
%s
)


def shim_bytes():
    """返回 shim.js 的原始字节"""
    return base64.b64decode(SHIM_B64)
''' % '\n'.join(lines)

    with open(DST, 'w', encoding='utf-8') as f:
        f.write(out)
    print('✓ %s → %s' % (os.path.relpath(SRC, ROOT), os.path.relpath(DST, ROOT)))
    print('  shim.js %d 字节 → base64 %d 字符' % (len(raw), len(b64)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
