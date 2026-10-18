"""
gdpy 桌面版入口（网页内核版）

用法：
    python webview_main.py

需要：pip install pywebview
"""
import os
import time
import sys


def _resource(rel):
    """兼容 PyInstaller 打包后的路径"""
    base = getattr(sys, '_MEIPASS', None)
    if base:
        return os.path.join(base, rel)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), rel)


def _window_icon():
    """运行时窗口图标路径，取不到返回 None

    ★ 只带 assets/icon.png 一个文件进包（95 KB）。
      .ico / .icns 是给 PyInstaller --icon 用的构建期文件，
      每个平台只需要自己那一款，没必要三份都塞进产物。
    """
    for rel in ('assets/icon.png', 'assets/icon.ico', 'assets/icon.icns'):
        p = _resource(rel)
        if os.path.isfile(p):
            return p
    return None


def _exec_flag():
    """是否允许页面执行外部命令

    ★ 只能通过启动参数打开，页面（JS）无法自行开启：
        Desktop_Github-Drive-Windows-V0.0.11.exe --enable-exec

      默认关闭。插件的 exec 权限走另一条通道（GrantStore 授权），
      不受这个开关影响。
    """
    return '--enable-exec' in sys.argv[1:]


def _log_crash():
    """把启动期异常写到 %APPDATA%/gdpy/error.log

    ★ 为什么必须落盘：
      PyInstaller 打的 exe 是 GUI 模式（-w），没有控制台。
      启动失败时 traceback 无处可去，表现为"双击没反应"。

      最常见的真因：机器没有 WebView2 运行时（老 Win10 / LTSC / 精简版），
      pywebview 抛 WebViewException。这种情况用户自己下载运行时就能解决，
      前提是他能看到这个原因。
    """
    import traceback
    txt = traceback.format_exc()
    try:
        from gdrive.core.config import app_dir
        p = os.path.join(app_dir(), 'error.log')
        with open(p, 'a', encoding='utf-8') as f:
            f.write('\n==== %s ====\n%s' % (
                time.strftime('%Y-%m-%d %H:%M:%S'), txt))
        dest = p
    except Exception:
        dest = '(写日志失败)'
    try:
        print(txt)
        print('已写入 %s' % dest)
    except Exception:
        pass
    return dest


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

    # ★★ ALLOW_DOWNLOADS 默认是 False —— 这是桌面版"下载没反应"的根因
    #
    #   前端下载走的是 `a.download` + blob URL（file-manager.js 的
    #   downloadFile、app.js 的备份导出、ui.js 的后端服务下载都一样）。
    #   pywebview 的 edgechromium 平台在 on_download_starting 里：
    #       if not webview_settings['ALLOW_DOWNLOADS']:
    #           args.Cancel = True
    #   —— 下载被**静默取消**：没有保存对话框，没有报错，点了像没点。
    #
    #   对一个网盘来说下载就是主功能，这一条不打开，
    #   桌面版等于只能看不能取。
    #
    #   settings 是 ImmutableDict：不能新增键，只能改已有键。
    webview.settings['ALLOW_DOWNLOADS'] = True

    api = Bridge(exec_enabled=_exec_flag())
    if api.exec_enabled():
        print('⚠ exec 已开启（--enable-exec）：页面可执行外部命令')
    win = webview.create_window(
        'gdpy · GitHub Drive 桌面版',
        url,
        js_api=api,
        width=1180, height=760, min_size=(900, 560),
        # ★ 窗口图标（标题栏 / 任务栏 / Dock）
        #
        #   PyInstaller 的 --icon 只改**文件本身**在资源管理器里的图标
        #   （Windows 生效；macOS 在 --onefile 下没有 .app bundle，
        #   所以那边的 --icon 基本不起作用）。
        #   真正让用户看到的窗口图标要靠 create_window 的 icon 参数。
        #
        #   按平台挑格式找不到就读不到 —— 直接崩窗口，
        #   所以取不到就传 None（退回 pywebview 默认图标），
        #   图标缺了不该让程序起不来。
        icon=_window_icon(),
    )
    api.window = win

    # ★★ private_mode 默认是 True —— 这是桌面版"每次都要重新登录"的根因
    #
    #   pywebview 的 start() 签名是 private_mode: bool = True，
    #   文档写明"In private mode, cookies and local storage are not preserved"。
    #   edgechromium 平台在窗口关闭时还会走 clear_user_data()：
    #       shutil.rmtree(self.user_data_folder)
    #   —— 整个浏览器 profile 被删掉，localStorage 一起没了。
    #
    #   前端把令牌、语言、插件配置、后端配置、缓存全存 localStorage
    #   （js/bridge.js 的 lsGet/lsSet、i18n 的 gd_lang、app.js 的
    #    gd_backend_config / gd_plugins），于是：
    #       关闭程序 → 全部清空 → 下次启动又要登录
    #   这正是"桌面版几乎跑不动"最直观的那个症状。
    #
    #   storage_path 显式指定到 app_dir，避免落到临时目录被系统清理。
    from gdrive.core.config import app_dir
    storage = os.path.join(app_dir(), 'webview-profile')

    try:
        webview.start(debug=False, private_mode=False, storage_path=storage)
    except Exception:
        # ★ 打包成 exe 后没有控制台，traceback 直接丢进黑洞：
        #   双击 → 什么都没出现 → 退出，用户只会以为"这软件打不开"。
        #   最常见的真因是机器缺 WebView2 运行时（旧版 Win10 / LTSC）。
        #   必须落盘，否则这类问题永远只能靠猜。
        _log_crash()
        return 1
    finally:
        shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
