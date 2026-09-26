"""
纯文本/数字工具 —— 与业务层解耦

★ 为什么单独一个模块（2026-09-26 架构手术）：

    v0.0.10 删掉了 gdrive/core/vfs.py（Python 业务层，
    业务逻辑已全部由前端 js 承担）。

    但里面有三个**纯函数**不该跟着埋掉：
        human_size          格式化字节数 —— maintain/recover 的报告要用
        breadcrumb_segments 路径切面包屑
        shorten             长名截断

    它们不依赖 VFS 数据结构，只是字符串/数字处理，
    且与前端 js 存在**契约关系**（显示形态必须一致）。

    所以单独拎出来，不随业务层一起删。

★ 关于面包屑（用户 2026-09 提过"为什么没有面包屑设计"）：
    前端 js 目前没有实现面包屑，Python 这份是**参考实现**。
    将来在 js 里实现时，折叠规则（保留根 + 末尾若干级，
    中间用 … 且不可点击）应与这里保持一致。
    真正的修复要在 github_drive（web 端）做，不是这里。
"""
import os

DRIVE_HOME = '/drive_home'

ROOT_LABEL = '网盘'

MAX_CRUMBS = 5

ELLIPSIS = '\u2026'   # …


def normalize(path):
    """补 /drive_home 前缀、去结尾斜杠

    ★ 与前端 js 的 Storage.normalizePath 同形。
      这里只做路径规范化，不涉及 VFS 存储。
    """
    p = (path or '').strip()
    if not p:
        return DRIVE_HOME
    if not p.startswith('/'):
        p = '/' + p
    if not p.startswith(DRIVE_HOME):
        p = DRIVE_HOME + p
    if len(p) > 1 and p.endswith('/'):
        p = p[:-1]
    return p


def human_size(n):
    n = float(n or 0)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or unit == 'TB':
            if unit == 'B':
                return '%d B' % int(n)
            return '%.1f %s' % (n, unit)
        n /= 1024.0
    return '%.1f TB' % n


def breadcrumb_segments(path, max_items=MAX_CRUMBS):
    """把 VFS 路径切成面包屑片段

    返回 [(显示名, 完整路径), ...]
    ★ 折叠项的完整路径是 None —— 表示不可点击。
      调用方必须判空，否则会跳转到 None。
    """
    p = normalize(path)
    parts = [x for x in p.split('/') if x]

    segs = [(ROOT_LABEL, DRIVE_HOME)]
    cur = DRIVE_HOME
    for name in parts[1:]:
        cur = cur + '/' + name
        segs.append((name, cur))

    if max_items and len(segs) > max_items:
        # 保留根 + 末尾若干级，中间折叠
        tail = max(1, max_items - 2)
        segs = segs[:1] + [(ELLIPSIS, None)] + segs[-tail:]

    return segs


def shorten(name, limit=24):
    """单段名字过长时截断，保留后缀（文件名后缀往往更重要）"""
    if not name or len(name) <= limit:
        return name
    keep = max(1, limit - len(ELLIPSIS))
    head = keep * 2 // 3
    tail = keep - head
    return name[:head] + ELLIPSIS + (name[-tail:] if tail else '')


def basename(path):
    """路径最后一段。用 os.path 但先归一化，避免 drive_home 干扰"""
    return normalize(path).rsplit('/', 1)[-1]
