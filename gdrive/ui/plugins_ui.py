"""插件管理窗口 —— 声明权限 + 授权 + 运行"""
import os
import tkinter as tk
from tkinter import messagebox, ttk

from ..core.plugins import (DISCLAIMER, RISK, PluginManager,
                            normalize_perms)


def open_plugin_window(root):
    win = tk.Toplevel(root)
    win.title('插件')
    win.geometry('680x460')
    win.transient(root)

    pm = PluginManager(root.cfg)
    plugins = pm.discover()

    frame = ttk.Frame(win, padding=10)
    frame.pack(fill='both', expand=True)

    cols = ('name', 'version', 'repo', 'perms')
    tree = ttk.Treeview(frame, columns=cols, show='headings')
    tree.heading('name', text='插件')
    tree.heading('version', text='版本')
    tree.heading('repo', text='来源')
    tree.heading('perms', text='权限')
    tree.column('name', width=150)
    tree.column('version', width=70)
    tree.column('repo', width=200)
    tree.column('perms', width=200)
    tree.pack(fill='both', expand=True)

    def refresh():
        for i in tree.get_children():
            tree.delete(i)
        for pid, p in plugins.items():
            granted = pm.grants.granted(pid)
            mark = '✓' if granted else ''
            tree.insert('', 'end', iid=pid,
                        values=(p.name + ('  [官方]' if p.is_official() else ''),
                                p.version, p.repo or '本地',
                                mark + ' '.join(p.permissions)))

    refresh()

    def on_run():
        sel = tree.selection()
        if not sel:
            return
        pid = sel[0]
        p = plugins[pid]
        known, unknown = normalize_perms(p.permissions)

        # 未授权 → 先走授权流程
        if not pm.grants.granted(pid) and known:
            if not p.is_official():
                if not messagebox.askokcancel(
                        '第三方插件风险提示', DISCLAIMER, icon='warning'):
                    return
            lines = []
            for perm in known:
                risk, desc = RISK.get(perm, ('unknown', perm))
                mark = '⛔' if risk == 'critical' else (
                    '⚠️' if risk in ('high', 'medium') else '·')
                lines.append('%s %s（%s）' % (mark, desc, perm))
            if unknown:
                lines.append('\n⚠️ %d 个未知权限，按最高风险处理' % len(unknown))
            lines.append('\n来源：%s' % (p.repo or '本地目录'))
            if not messagebox.askyesno('权限确认', '\n'.join(lines)):
                return
            pm.install(p, approve_perms=known)
        elif not pm.grants.granted(pid):
            pm.install(p, approve_perms=[])

        try:
            result = pm.run(pid)
            messagebox.showinfo('完成', '插件执行完毕。\n\n%s'
                                % (repr(result)[:600] if result is not None
                                   else '（无返回值）'))
        except PermissionError as e:
            messagebox.showerror('权限不足', str(e))
        except Exception as e:
            messagebox.showerror('插件出错', str(e))
        refresh()

    def on_revoke():
        sel = tree.selection()
        if not sel:
            return
        pm.grants.revoke(sel[0])
        refresh()

    bar = ttk.Frame(win, padding=(10, 6))
    bar.pack(fill='x')
    ttk.Button(bar, text='▶ 运行', command=on_run).pack(side='left')
    ttk.Button(bar, text='撤销授权', command=on_revoke).pack(side='left', padx=6)
    ttk.Button(bar, text='打开插件目录',
               command=lambda: _open_dir(root)).pack(side='right')

    ttk.Label(win, text='插件目录：%s' % _user_dir(),
              foreground='#888', padding=(10, 0)).pack(anchor='w')


def _user_dir():
    from ..core.plugins import user_plugin_dir
    return user_plugin_dir()


def _open_dir(root):
    d = _user_dir()
    try:
        if os.name == 'nt':
            os.startfile(d)          # noqa: S606
        elif os.uname().sysname == 'Darwin':
            import subprocess
            subprocess.run(['open', d])
        else:
            import subprocess
            subprocess.run(['xdg-open', d])
    except Exception as e:
        messagebox.showinfo('插件目录', '%s\n\n（无法自动打开：%s）' % (d, e))
