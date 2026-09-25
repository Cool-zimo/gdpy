"""
Tkinter 主界面

★ 线程规则（Tkinter 最重要的一条）：
    所有 UI 操作必须在主线程。网络请求放后台线程，
    结果通过 root.after() 回抛到主线程更新界面。
    在子线程里直接改控件 = 随机崩溃，且不报错。
"""
import os
import queue
import sys
import threading
import tkinter as tk

# ★ Windows 默认 GBK，print/异常信息含非 GBK 字符会崩
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
from tkinter import filedialog, messagebox, simpledialog, ttk

from ..core.api import GitHubAPI, GitHubError
from ..core.config import Config
from ..core.config_sync import ConfigSync
from ..core.share import ShareManager
from ..core.transfer import Transfer
from ..core.vfs import (DRIVE_HOME, VFS, breadcrumb_segments,
                       human_size, join, parent, shorten)

POLL_MS = 100


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('gdpy · GitHub Drive 桌面版')
        self.geometry('900x600')
        self.minsize(760, 480)

        self.cfg = Config()
        self.api = GitHubAPI(self.cfg.token)
        self.vfs = VFS(self.cfg.vfs())
        self.transfer = Transfer(self.api, self.cfg, self.vfs)
        self.share = ShareManager(self.api, self.cfg, self.cfg.owner)
        self.sync = ConfigSync(self.api)
        self.sync.owner = self.cfg.owner

        self.q = queue.Queue()
        self.current = DRIVE_HOME
        self.busy = False

        self._build()
        self.after(POLL_MS, self._pump)

        if self.cfg.token:
            self._bg(self._bootstrap)
        else:
            self._show_login()

    # ==================== 界面 ====================
    def _build(self):
        # 顶部工具栏
        bar = ttk.Frame(self, padding=(8, 6))
        bar.pack(fill='x')
        self.btn_up = ttk.Button(bar, text='⬆ 上级', command=self.go_up)
        self.btn_up.pack(side='left')
        ttk.Button(bar, text='📤 上传文件', command=self.on_upload).pack(side='left', padx=4)
        ttk.Button(bar, text='📥 下载', command=self.on_download).pack(side='left')
        ttk.Button(bar, text='📁 新建文件夹', command=self.on_mkdir).pack(side='left', padx=4)
        ttk.Button(bar, text='🗑 删除', command=self.on_delete).pack(side='left')
        ttk.Button(bar, text='🔗 分享', command=self.on_share).pack(side='left', padx=4)
        ttk.Button(bar, text='🔄 刷新', command=self.on_refresh).pack(side='left')
        ttk.Button(bar, text='🧩 插件', command=self.on_plugins).pack(side='left', padx=4)

        # 面包屑：每一级可点击跳转
        crumb_wrap = ttk.Frame(self)
        crumb_wrap.pack(fill='x', padx=8, pady=(4, 2))
        self.crumb_bar = ttk.Frame(crumb_wrap)
        self.crumb_bar.pack(side='left', fill='x', expand=True)
        ttk.Button(crumb_wrap, text='\u23ce 复制路径',
                   command=self.on_copy_path).pack(side='right')

        # 文件列表
        wrap = ttk.Frame(self)
        wrap.pack(fill='both', expand=True, padx=8, pady=(0, 4))
        cols = ('name', 'size', 'updated')
        self.tree = ttk.Treeview(wrap, columns=cols, show='headings',
                                 selectmode='browse')
        self.tree.heading('name', text='名称')
        self.tree.heading('size', text='大小')
        self.tree.heading('updated', text='修改时间')
        self.tree.column('name', width=460, anchor='w')
        self.tree.column('size', width=110, anchor='e')
        self.tree.column('updated', width=190, anchor='center')
        vs = ttk.Scrollbar(wrap, orient='vertical', command=self.tree.yview)
        self.tree.configure(yscrollcommand=vs.set)
        self.tree.pack(side='left', fill='both', expand=True)
        vs.pack(side='right', fill='y')
        self.tree.bind('<Double-1>', self.on_open)

        # 状态栏
        self.status = ttk.Label(self, text='就绪', padding=(10, 4), anchor='w')
        self.status.pack(fill='x')
        self.prog = ttk.Progressbar(self, mode='determinate')
        self.prog.pack(fill='x', padx=8, pady=(0, 6))

    # ==================== 后台任务 ====================
    def _bg(self, fn, *args):
        """在后台线程跑 fn，异常也回到主线程提示"""
        if self.busy:
            messagebox.showinfo('请稍候', '有任务正在执行')
            return
        self.busy = True
        self.status.config(text='执行中…')
        self.prog['value'] = 0

        def run():
            try:
                fn(*args)
            except Exception as e:
                self.q.put(('error', str(e)))
            finally:
                self.q.put(('done', None))

        threading.Thread(target=run, daemon=True).start()

    def _pump(self):
        """主线程消费队列 —— 唯一的 UI 更新入口"""
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == 'error':
                    self.status.config(text='错误：%s' % payload)
                    messagebox.showerror('出错了', payload)
                elif kind == 'status':
                    self.status.config(text=payload)
                elif kind == 'progress':
                    self.prog['value'] = payload
                elif kind == 'tree':
                    self._render(payload)
                elif kind == 'reload':
                    self._render_tree()
                elif kind == 'done':
                    self.busy = False
                    self.prog['value'] = 0
        except queue.Empty:
            pass
        self.after(POLL_MS, self._pump)

    # ==================== 登录 ====================
    def _show_login(self):
        win = tk.Toplevel(self)
        win.title('登录 GitHub')
        win.geometry('520x260')
        win.transient(self)
        win.grab_set()

        ttk.Label(win, text='GitHub Personal Access Token',
                  font=('', 11, 'bold')).pack(pady=(18, 4))
        ttk.Label(win, text='需要 repo 权限。令牌只保存在本机配置文件里。',
                  foreground='#666').pack()
        ttk.Label(win, text='没有令牌？ GitHub Settings → Developer settings '
                            '→ Personal access tokens → Tokens (classic)',
                  foreground='#888', font=('', 8)).pack(pady=(0, 8))

        var = tk.StringVar(value=self.cfg.token)
        e = ttk.Entry(win, textvariable=var, width=58, show='•')
        e.pack(pady=4)
        e.focus()

        def do_login():
            tok = var.get().strip()
            if not tok:
                messagebox.showwarning('', '请输入令牌')
                return
            self.cfg.token = tok
            self.api = GitHubAPI(tok)
            self.transfer = Transfer(self.api, self.cfg, self.vfs)
            self.share = ShareManager(self.api, self.cfg, self.cfg.owner)
            self.sync = ConfigSync(self.api)
            win.destroy()
            self._bg(self._bootstrap)

        ttk.Button(win, text='登录', command=do_login).pack(pady=10)
        e.bind('<Return>', lambda _: do_login())

    def _bootstrap(self):
        """登录后的初始化：取用户名 → 扫存储仓 → 拉 VFS"""
        me = self.api.get_me()
        owner = me.get('login', '')
        self.cfg.owner = owner
        self.share.owner = owner
        self.sync.owner = owner
        self.q.put(('status', '已登录：%s' % owner))
        self.transfer.scan_storage_repos(owner)
        self._pull_vfs()
        self.q.put(('reload', None))

    def _pull_vfs(self):
        """从配置仓库拉 VFS（与网页版共用 github-drive-config）

        ★ 网页版的字段名是 fileIndex，不是 vfs —— 认错就读不到。
        """
        owner = self.cfg.owner
        if not owner:
            return
        try:
            got = self.sync.pull()
            if got['vfs']:
                self.vfs = VFS(got['vfs'])
                self.cfg.set_vfs(self.vfs.to_dict())
            if got['usage']:
                # 远端为准（网页版也在记账），但要归一化后再存
                from ..core.config_sync import denormalize_usage
                self.cfg.set('repoUsage',
                             denormalize_usage(got['usage']))
        except Exception as e:
            # ★ 不能静默 pass：用户会以为"文件没了"
            self.q.put(('status', '配置同步读取失败：%s' % e))

    def _push_vfs(self):
        """推 VFS 到配置仓库

        ★ 必须走 ConfigSync.push()（读-改-写），
          不能整体覆盖 —— 否则网页版的 repos/shares/repoUsage
          等字段会全部丢失。
        """
        owner = self.cfg.owner
        if not owner:
            return
        try:
            from ..core.config_sync import normalize_usage
            self.sync.ensure_repo()
            self.sync.push(
                vfs=self.vfs.to_dict(),
                usage=normalize_usage(self.cfg.get('repoUsage', {})),
            )
        except Exception as e:
            self.q.put(('status', '配置同步写入失败：%s' % e))

    # ==================== 浏览 ====================
    def _render_crumbs(self):
        """渲染面包屑

        ★ 必须整个重建：路径长度会变，复用旧 widget 会留下残影。
        """
        for w in self.crumb_bar.winfo_children():
            w.destroy()

        segs = breadcrumb_segments(self.current)
        for i, (name, path) in enumerate(segs):
            if i > 0:
                ttk.Label(self.crumb_bar, text='\u203a',
                          foreground='#9aa3b2').pack(side='left', padx=3)

            last = (i == len(segs) - 1)
            text = shorten(name)

            if path is None or last:
                # 折叠项(…) 和 当前目录 都不接受跳转
                lbl = ttk.Label(self.crumb_bar, text=text)
                if last:
                    lbl.configure(foreground='#e6e8ee')
                else:
                    lbl.configure(foreground='#6b7280')
            else:
                lbl = ttk.Label(self.crumb_bar, text=text,
                                foreground='#6ea8fe', cursor='hand2')
                # ★ 闭包捕获 —— 必须用默认参数固定住 path，
                #   否则循环结束后所有项都指向最后一个路径
                lbl.bind('<Button-1>',
                         lambda e, pp=path: self._render(pp))
            lbl.pack(side='left')

    def on_copy_path(self):
        """复制当前 VFS 路径到剪贴板"""
        self.clipboard_clear()
        self.clipboard_append(self.current)
        self.status.config(text='已复制路径：%s' % self.current)

    def _render_tree(self):
        self._render(self.current)

    def _render(self, path=None):
        if path:
            self.current = path
        self._render_crumbs()
        for i in self.tree.get_children():
            self.tree.delete(i)
        for name, p, is_dir, info in self.vfs.children(self.current):
            size = '' if is_dir else human_size(info.get('size', 0))
            self.tree.insert('', 'end', iid=p,
                             values=(('📁 ' if is_dir else '📄 ') + name,
                                     size, info.get('updatedAt', '')))
        nf, nd = self.vfs.count()
        self.status.config(text='共 %d 个文件 / %d 个文件夹 · %s'
                               % (nf, nd, human_size(self.vfs.total_size())))

    def go_up(self):
        p = parent(self.current)
        if p:
            self._render(p)

    def on_open(self, _=None):
        sel = self.tree.selection()
        if not sel:
            return
        p = sel[0]
        if self.vfs.is_folder(p):
            self._render(p)

    def on_refresh(self):
        self._bg(self._do_refresh)

    def _do_refresh(self):
        owner = self.cfg.owner
        if owner:
            self.transfer.scan_storage_repos(owner)
            self._pull_vfs()
        self.q.put(('reload', None))

    # ==================== 上传 / 下载 ====================
    def on_upload(self):
        paths = filedialog.askopenfilenames(title='选择要上传的文件')
        if not paths:
            return
        self._bg(self._do_upload, list(paths))

    def _do_upload(self, paths):
        for i, p in enumerate(paths):
            self.q.put(('status', '上传 %s' % os.path.basename(p)))

            def prog(done, total, name):
                self.q.put(('progress', (done / float(total)) * 100))

            vpath, chunks = self.transfer.upload(p, self.current, prog)
            self.vfs.put_file(vpath, size=sum(c['size'] for c in chunks),
                              chunks=chunks)
        self.cfg.set_vfs(self.vfs.to_dict())
        self._push_vfs()
        self.q.put(('status', '上传完成'))
        self.q.put(('reload', None))

    def on_download(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo('', '请先选中一个文件')
            return
        p = sel[0]
        if self.vfs.is_folder(p):
            messagebox.showinfo('', '请选中文件（文件夹暂不支持整体下载）')
            return
        dest = filedialog.asksaveasfilename(
            title='保存到', initialfile=self.vfs.get_file(p).get('name', 'file'))
        if not dest:
            return
        self._bg(self._do_download, p, dest)

    def _do_download(self, vpath, dest):
        info = self.vfs.get_file(vpath)
        self.q.put(('status', '下载 %s' % info.get('name')))

        def prog(done, total):
            self.q.put(('progress', (done / float(total)) * 100))

        self.transfer.download(info.get('chunks', []), dest, prog)
        self.q.put(('status', '已保存到 %s' % dest))

    # ==================== 文件夹 / 删除 ====================
    def on_mkdir(self):
        name = simpledialog.askstring('新建文件夹', '名称：')
        if not name:
            return
        self._bg(self._do_mkdir, name.strip())

    def _do_mkdir(self, name):
        self.vfs.put_folder(join(self.current, name))
        self.cfg.set_vfs(self.vfs.to_dict())
        self._push_vfs()
        self.q.put(('reload', None))

    def on_delete(self):
        sel = self.tree.selection()
        if not sel:
            return
        p = sel[0]
        is_dir = self.vfs.is_folder(p)
        title = '删除文件夹及其全部内容？' if is_dir else '删除文件？'
        if not messagebox.askyesno('确认', '%s\n\n%s' % (title, p)):
            return
        self._bg(self._do_delete, p)

    def _do_delete(self, path):
        removed = self.vfs.remove_tree(path)
        ok = fail = 0
        for info in removed:
            o, f = self.transfer.delete_chunks(info.get('chunks', []))
            ok += o
            fail += f
        self.cfg.set_vfs(self.vfs.to_dict())
        self._push_vfs()
        self.q.put(('status', '已删除（远端分片 %d 成功 / %d 失败）' % (ok, fail)))
        self.q.put(('reload', None))

    # ==================== 分享 ====================
    def on_share(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo('', '请先选中一个文件')
            return
        p = sel[0]
        if self.vfs.is_folder(p):
            messagebox.showinfo('', '请选中文件')
            return
        desc = simpledialog.askstring('创建分享', '描述（可留空）：',
                                      initialvalue='')
        if desc is None:
            return
        self._bg(self._do_share, p, desc or '')

    def _do_share(self, vpath, desc):
        info = self.vfs.get_file(vpath)
        self.q.put(('status', '准备分享 %s …' % info.get('name')))
        data = self.transfer.download_to_bytes(info.get('chunks', []))
        res = self.share.create_share([(info.get('name'), data)],
                                      description=desc)

        def show():
            win = tk.Toplevel(self)
            win.title('分享已创建')
            win.geometry('560x160')
            ttk.Label(win, text='分享链接：', font=('', 10, 'bold')).pack(
                anchor='w', padx=14, pady=(14, 2))
            e = ttk.Entry(win, width=68)
            e.insert(0, res['shareUrl'])
            e.config(state='readonly')
            e.pack(padx=14, fill='x')
            ttk.Button(win, text='复制并关闭',
                       command=lambda: (self.clipboard_clear(),
                                        self.clipboard_append(res['shareUrl']),
                                        win.destroy())).pack(pady=12)

        self.after(0, show)
        self.q.put(('status', '分享已创建'))

    def on_plugins(self):
        from .plugins_ui import open_plugin_window
        open_plugin_window(self)


def main():
    App().mainloop()


if __name__ == '__main__':
    main()
