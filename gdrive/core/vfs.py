"""
虚拟文件系统

★ 与 web 版 js/storage.js 完全同构，字段名一个都不能改：
    files:   { "/drive_home/a/b.txt": {name,type,size,chunks,createdAt,updatedAt} }
    folders: { "/drive_home/a":       {name,type,createdAt} }

  这样网页版传的文件，桌面版直接就能列出、下载。

★ 文件夹是纯虚拟的 —— GitHub 没有目录概念。
    所以"删文件夹"只删 VFS 里的一行，不会碰任何 GitHub 文件。
"""

DRIVE_HOME = '/drive_home'


def normalize(path):
    """强制以 /drive_home 开头，去掉结尾斜杠"""
    p = (path or '').strip()
    if not p.startswith(DRIVE_HOME):
        p = DRIVE_HOME + '/' + p.lstrip('/')
    p = p.rstrip('/')
    return p or DRIVE_HOME


def parent(path):
    p = normalize(path)
    if p == DRIVE_HOME:
        return None
    idx = p.rfind('/')
    parent_path = p[:idx] if idx > len(DRIVE_HOME) else DRIVE_HOME
    return parent_path or DRIVE_HOME


def basename(path):
    p = normalize(path)
    if p == DRIVE_HOME:
        return 'Drive Home'
    return p[p.rfind('/') + 1:]


def join(dirpath, name):
    if dirpath == DRIVE_HOME:
        return DRIVE_HOME + '/' + name
    return normalize(dirpath) + '/' + name


def normalize_vfs(vfs):
    """
    防御式规范化

    ★ 不能省：VFS 会从别的设备/网页版同步过来，可能是空对象或缺字段。
      直接 vfs['files'].items() 会 KeyError 崩掉。
      这三行是跨端同步的必备保险。
    """
    if not isinstance(vfs, dict):
        vfs = {}
    if not isinstance(vfs.get('files'), dict):
        vfs['files'] = {}
    if not isinstance(vfs.get('folders'), dict):
        vfs['folders'] = {}
    return vfs


class VFS:
    def __init__(self, data=None):
        self.data = normalize_vfs(data if data is not None else {})

    # ---------- 导出 ----------
    def to_dict(self):
        return self.data

    # ---------- 查询 ----------
    def get_file(self, path):
        return self.data['files'].get(normalize(path))

    def get_folder(self, path):
        return self.data['folders'].get(normalize(path))

    def exists(self, path):
        p = normalize(path)
        return p in self.data['files'] or p in self.data['folders']

    def is_file(self, path):
        return normalize(path) in self.data['files']

    def is_folder(self, path):
        p = normalize(path)
        return p == DRIVE_HOME or p in self.data['folders']

    def children(self, path):
        """列出直接子项 → [(name, path, is_dir, info)]"""
        base = normalize(path)
        out = []
        seen = set()
        # ★ prefix 必须是 base + '/'，不能对 DRIVE_HOME 特殊处理成 '/'：
        #   那样 rest 会变成 'drive_home/a'（含/）→ 所有子项都被跳过
        prefix = base.rstrip('/') + '/'
        for p, info in self.data['folders'].items():
            if p == base or not p.startswith(prefix):
                continue
            rest = p[len(prefix):]
            if '/' in rest:          # 只取直接子目录
                continue
            if rest in seen:
                continue
            seen.add(rest)
            out.append((rest, p, True, info))
        for p, info in self.data['files'].items():
            if not p.startswith(prefix):
                continue
            rest = p[len(prefix):]
            if '/' in rest:
                continue
            # ★ 同名冲突时目录优先 —— 目录名通常更长/更靠前，
            #   被目录占用就跳过（避免同一层出现两个同名条目）
            if rest in seen:
                continue
            seen.add(rest)
            out.append((rest, p, False, info))
        # ★ 排序键不能只按 name —— 目录必须整体排在文件前面，
        #   否则会出现「文件夹在目录中间」
        out.sort(key=lambda x: (0 if x[2] else 1, x[0].lower()))
        return out

    # ---------- 写入 ----------
    def _ensure_parents(self, path):
        """自动补齐父目录链"""
        p = parent(path)
        guard = 0
        while p and p != DRIVE_HOME and p not in self.data['folders']:
            self.data['folders'][p] = {
                'name': basename(p), 'type': 'folder',
                'createdAt': _now(),
            }
            p = parent(p)
            guard += 1
            if guard > 64:   # 防死循环（异常深的路径）
                break

    def put_file(self, path, name=None, size=0, chunks=None):
        p = normalize(path)
        now = _now()
        old = self.data['files'].get(p)
        self.data['files'][p] = {
            'name': name or basename(p),
            'type': 'file',
            'size': int(size or 0),
            'chunks': chunks or [],
            'createdAt': (old or {}).get('createdAt', now),
            'updatedAt': now,
        }
        self._ensure_parents(p)
        return self.data['files'][p]

    def put_folder(self, path):
        p = normalize(path)
        if p == DRIVE_HOME:
            return None
        self.data['folders'][p] = {
            'name': basename(p), 'type': 'folder', 'createdAt': _now(),
        }
        self._ensure_parents(p)
        return self.data['folders'][p]

    def remove(self, path):
        """删单个节点（不递归）。返回被删的 info"""
        p = normalize(path)
        if p in self.data['files']:
            return self.data['files'].pop(p)
        if p in self.data['folders']:
            return self.data['folders'].pop(p)
        return None

    def remove_tree(self, path):
        """
        递归删除子树，返回被删掉的 file 列表（调用方据此删 GitHub 分片）

        ★ 注意：只删 VFS 记录。真正的分片删除由调用方决定 ——
          回收站就是靠这个实现"秒删"（只改配置，不动远端）。
        """
        base = normalize(path)
        removed = []
        if base in self.data['files']:
            removed.append(self.data['files'].pop(base))
            return removed
        prefix = base.rstrip('/') + '/'
        for p in list(self.data['files'].keys()):
            if p.startswith(prefix):
                removed.append(self.data['files'].pop(p))
        for p in list(self.data['folders'].keys()):
            if p == base or p.startswith(prefix):
                self.data['folders'].pop(p, None)
        return removed

    def rename(self, old, new):
        """重命名/移动。返回受影响的路径数"""
        o, n = normalize(old), normalize(new)
        if o == n or not self.exists(o):
            return 0
        count = 0
        if o in self.data['files']:
            info = self.data['files'].pop(o)
            info['name'] = basename(n)
            self.data['files'][n] = info
            count += 1
        else:
            prefix = o.rstrip('/') + '/'
            for p in list(self.data['files'].keys()):
                if p == o or p.startswith(prefix):
                    info = self.data['files'].pop(p)
                    np = n + p[len(o):]
                    info['name'] = basename(np)
                    self.data['files'][np] = info
                    count += 1
            for p in list(self.data['folders'].keys()):
                if p == o or p.startswith(prefix):
                    info = self.data['folders'].pop(p)
                    np = n + p[len(o):]
                    info['name'] = basename(np)
                    self.data['folders'][np] = info
                    count += 1
        # 新位置的父目录要补上
        self._ensure_parents(n)
        return count

    # ---------- 统计 ----------
    def total_size(self):
        return sum(f.get('size', 0) for f in self.data['files'].values())

    def count(self):
        return len(self.data['files']), len(self.data['folders'])


import datetime


def _now():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def human_size(n):
    n = float(n or 0)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or unit == 'TB':
            if unit == 'B':
                return '%d B' % int(n)
            return '%.1f %s' % (n, unit)
        n /= 1024.0
    return '%.1f TB' % n
