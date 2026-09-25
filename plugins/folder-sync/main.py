"""
本地同步文件夹 —— 增量同步计划生成器

★ 本插件只"算计划"，不直接传文件。

  原因：上传要走 GitHub API（需要 token、要记账容量、要分批 commit），
  这些能力在宿主里，插件拿不到也不该拿到。所以本插件做它擅长的事：
  扫描本地、比对远端索引、算出该传谁该删谁，然后把计划交回宿主执行。

  dry_run 默认为 True —— 第一次跑一定只出计划，不会动任何文件。

params:
    local_dir    本地文件夹（必填）
    remote_path  网盘目录，如 /sync
    direction    push=只上传 / pull=只下载 / both=双向
    delete       是否删除对方多出来的文件（镜像模式，危险）
    dry_run      True 时只返回计划
    remote_index 远端文件索引，格式 [{'path': '/sync/a.txt', 'size': 123, 'mtime': 1690000000}]
                 由宿主（前端 VFS）传入；没传则视为空目录
"""
import os

# 需要忽略的本地噪音
IGNORE_NAMES = {'.DS_Store', 'Thumbs.db', 'desktop.ini'}
IGNORE_DIRS = {'.git', 'node_modules', '__pycache__', '.svn', '.hg'}


def _walk_local(root):
    """扫描本地文件夹 → [{'rel','abs','size','mtime'}]"""
    out = []
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        return out
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d not in IGNORE_DIRS)
        for f in sorted(fn):
            if f in IGNORE_NAMES:
                continue
            ap = os.path.join(dp, f)
            try:
                st = os.stat(ap)
            except OSError:
                continue
            rel = os.path.relpath(ap, root).replace(os.sep, '/')
            out.append({'rel': rel, 'abs': ap,
                        'size': st.st_size, 'mtime': int(st.st_mtime)})
    return out


def _norm_remote(remote_path, rel):
    rp = (remote_path or '/').rstrip('/')
    return '%s/%s' % (rp, rel) if rp else '/' + rel


def _index_remote(items, remote_path):
    """远端索引 → {相对路径: 记录}"""
    out = {}
    rp = (remote_path or '/').rstrip('/')
    for it in (items or []):
        p = it.get('path') or it.get('name') or ''
        p = p.replace('\\', '/')
        if rp and p.startswith(rp + '/'):
            p = p[len(rp) + 1:]
        elif rp and p == rp:
            continue
        out[p] = {'size': int(it.get('size') or 0),
                  'mtime': int(it.get('mtime') or 0)}
    return out


def _conflict(local, remote):
    """
    判断是否需要传

    判据：大小不同 或 本地 mtime 比远端新（容差 1 秒，规避不同文件系统精度）
    """
    r = remote
    if r is None:
        return True
    if int(local['size']) != int(r.get('size', 0)):
        return True
    return int(local['mtime']) - int(r.get('mtime', 0)) > 1


def build_plan(local_dir, remote_path='/', direction='both', delete=False,
               remote_index=None):
    """核心：算出同步计划（纯函数，不碰网络，好测）"""
    locals_ = _walk_local(local_dir)
    remotes = _index_remote(remote_index, remote_path)

    upload, download, del_remote, del_local, unchanged = [], [], [], [], []

    lkeys = {x['rel'] for x in locals_}
    for x in locals_:
        r = remotes.get(x['rel'])
        if _conflict(x, r):
            if direction in ('push', 'both'):
                upload.append({'rel': x['rel'], 'abs': x['abs'],
                               'remote': _norm_remote(remote_path, x['rel']),
                               'size': x['size']})
            else:
                download.append({'rel': x['rel'], 'remote': _norm_remote(
                    remote_path, x['rel'])})
        else:
            unchanged.append(x['rel'])

    # 远端有、本地没有
    for rel in sorted(set(remotes) - lkeys):
        rp = _norm_remote(remote_path, rel)
        if direction in ('pull', 'both'):
            download.append({'rel': rel, 'remote': rp})
        elif delete:
            del_remote.append({'rel': rel, 'remote': rp})

    # 本地有、远端没有 且方向是 pull → 镜像模式下删本地
    if direction == 'pull' and delete:
        for rel in sorted(lkeys - set(remotes)):
            del_local.append({'rel': rel})

    return {'local_dir': os.path.abspath(local_dir),
            'remote_path': remote_path,
            'direction': direction,
            'upload': upload, 'download': download,
            'delete_remote': del_remote, 'delete_local': del_local,
            'unchanged': unchanged,
            'counts': {'upload': len(upload), 'download': len(download),
                       'delete_remote': len(del_remote),
                       'delete_local': len(del_local),
                       'unchanged': len(unchanged)}}


def _run(ctx):
    local_dir = ctx.param('local_dir')
    if not local_dir:
        ctx.log('✗ 缺少参数 local_dir')
        return {'ok': False, 'error': '缺少参数 local_dir'}
    if not os.path.isdir(local_dir):
        ctx.log('✗ 本地文件夹不存在：%s' % local_dir)
        return {'ok': False, 'error': '本地文件夹不存在：%s' % local_dir}

    # fs:list 用于扫目录，fs:read 用于后续读内容 —— 这里显式校验一次，
    # 未授权时会在最开始就 PermissionError，而不是扫到一半才炸
    ctx.list_dir(local_dir)

    direction = ctx.param('direction', 'both')
    if direction not in ('push', 'pull', 'both'):
        ctx.log('✗ direction 只能是 push/pull/both，收到 %r' % direction)
        return {'ok': False, 'error': 'direction 非法'}

    delete = bool(ctx.param('delete', False))
    dry = bool(ctx.param('dry_run', True))
    remote_path = ctx.param('remote_path', '/') or '/'
    remote_index = ctx.param('remote_index')

    plan = build_plan(local_dir, remote_path, direction, delete, remote_index)
    c = plan['counts']
    ctx.log('扫描 %s：本地 %d 项，远端 %d 项'
            % (local_dir, c['upload'] + c['unchanged'] + len(plan['delete_local']),
               len(remote_index or [])))
    ctx.log('计划 → 上传 %d / 下载 %d / 删远端 %d / 删本地 %d / 无变化 %d'
            % (c['upload'], c['download'], c['delete_remote'],
               c['delete_local'], c['unchanged']))

    if delete and (c['delete_remote'] or c['delete_local']):
        ctx.log('⚠️ 镜像模式：将删除 %d 个文件，且不可撤销'
                % (c['delete_remote'] + c['delete_local']))

    plan['dry_run'] = dry
    plan['total_bytes'] = sum(x['size'] for x in plan['upload'])
    ctx.progress(1.0, '计划已生成')

    if dry:
        ctx.log('dry_run=True，未执行任何传输')
        plan['executed'] = False
    else:
        # 实际传输由宿主完成（需要 token 和容量记账）
        plan['executed'] = False
        ctx.log('ℹ️ 传输需由宿主执行：本插件只产出计划')

    return plan


def run(ctx):
    """入口包装：把 PermissionError 转成普通失败

    ★ 插件作者不必关心权限异常 —— 未授权时直接返回 ok=False，
      而不是让异常一路抛到 UI（弹窗里看不到 traceback，等于没有提示）。
    """
    try:
        return _run(ctx)
    except PermissionError as e:
        ctx.log('✗ 权限不足：%s' % e)
        return {'ok': False, 'error': '权限不足：%s' % e, 'denied': True}
