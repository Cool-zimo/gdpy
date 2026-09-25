#!/usr/bin/env python3
"""gdpy 启动入口"""
import sys


def main():
    # ★ Windows 控制台默认是 GBK，任何 print 含非 GBK 字符都会崩。
    #   统一改成 UTF-8（errors=replace 保证不因个别字符中断）
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    # Tkinter 缺失要给出明确提示，不能让用户面对一个无意义的 ImportError
    try:
        import tkinter  # noqa: F401
    except ImportError:
        sys.stderr.write(
            '缺少 Tkinter，无法启动图形界面。\n\n'
            'Windows/macOS：重新安装 Python 时勾选 "tcl/tk and IDLE"\n'
            'Ubuntu/Debian：sudo apt-get install python3-tk\n'
            'Fedora：sudo dnf install python3-tkinter\n'
        )
        return 1

    from gdrive.ui.app import App
    App().mainloop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
