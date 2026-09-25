#!/usr/bin/env python3
"""gdpy 启动入口"""
import sys


def main():
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
