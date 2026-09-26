"""
gdpy 桌面版入口（网页内核版）

用法：
    python webview_main.py

需要：pip install pywebview
"""
import os
import sys


def _resource(rel):
    """兼容 PyInstaller 打包后的路径"""
    base = getattr(sys, '_MEIPASS', None)
    if base:
        return os.path.join(base, rel)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), rel)


def _exec_flag():
    """是否允许页面执行外部命令

    ★ 只能通过启动参数打开，页面（JS）无法自行开启：
        Desktop_Github-Drive-Windows-V0.0.11.exe --enable-exec

      默认关闭。插件的 exec 权限走另一条通道（GrantStore 授权），
      不受这个开关影响。
    """
    return '--enable-exec' in sys.argv[1:]


def main():
    try:
        import webview
    except ImportError:
        print('缺少 pywebview，请先执行：pip install pywebview')
        return 1

    from gdrive.webview.bridge import Bridge
    from gdrive.webview.server import start

    web_dir = _resource('web')
    if not os.path.isfile(os.path.join(web_dir, 'index.html')):
        print('找不到前端资源：%s' % web_dir)
        print('先运行： python tools/sync_web.py')
        return 1

    url, shutdown = start(web_dir)
    print('本地服务 %s' % url)

    api = Bridge(exec_enabled=_exec_flag())
    if api.exec_enabled():
        print('⚠ exec 已开启（--enable-exec）：页面可执行外部命令')
    win = webview.create_window(
        'gdpy · GitHub Drive 桌面版',
        url,
        js_api=api,
        width=1180, height=760, min_size=(900, 560),
    )
    api.window = win

    try:
        webview.start(debug=False)
    finally:
        shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
