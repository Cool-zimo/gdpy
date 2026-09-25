"""
自动备份本地文件夹 —— 增量快照

★ 用轮询而不是 inotify：
  标准库没有文件系统监听，watchdog 是第三方依赖（PyInstaller 打包风险）。
  轮询几秒一次对备份场景完全够用，而且跨平台行为一致。

★ 只"挑出变动"，不直接上传：
  跟 folder-sync 一样，上传需要 token 和容量记账，交给宿主。

★ 状态文件：
  记录每个文件的 (size, mtime)，下次比对。
  存在插件自己的数据目录，重启后不丢 —— 否则每次全量上传，灾难。

★ 时间戳目录：
  默认 remote_path/<YYYYMMDD-HHMMSS>/，每次快照一个目录，
  旧快照不会被覆盖 —— 备份的意义就在于能找回旧版本。
"""
import hashlib
import json
import os
import time

DEFAULT_EXCLUDE = ('.git', 'node_modules', '__pycache__', '.svn', '.hg')


def state_path_for(watch_dir, data_dir):
    """一个 watch_dir 一份状态文件（用路径哈希命名，避免非法文件名）"""
    h = hashlib.sha1(os.path.abspath(watch_dir).encode('utf-8')).hexdigest()[:12]
    return os.path.join(data_dir, 'auto-backup-%s.json' % h)


def load_state(sp):
    if os.path.isfile(sp):
        try:
            with open(sp, 'r', encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
        except (IOError, ValueError):
            pass
    return {}


def save_state(sp, st):
    d = os.path.dirname(sp)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = sp + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, sp)          # 原子替换，写一半崩了也不会损坏旧状态
    return True


def scan(watch_dir, exclude):
    """扫描 → {相对路径: [size, mtime]}"""
    ex = set(x.strip() for x in (exclude or '').split(',') if x.strip())
    ex |= set(DEFAULT_EXCLUDE)
    out = {}
    root = os.path.abspath(watch_dir)
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d not in ex)
        for f in fn:
            if f.endswith(('.tmp', '.swp')):
                continue
            ap = os.path.join(dp, f)
            try:
                st = os.stat(ap)
            except OSError:
                continue
            rel = os.path.relpath(ap, root).replace(os.sep, '/')
            out[rel] = [st.st_size, int(st.st_mtime)]
    return out


def diff(cur, prev):
    """比对 → {'changed': [...], 'deleted': [...]}"""
    changed, deleted = [], []
    for rel, sig in cur.items():
        old = prev.get(rel)
        if old != sig:
            changed.append(rel)
    for rel in prev:
        if rel not in cur:
            deleted.append(rel)
    return {'changed': sorted(changed), 'deleted': sorted(deleted)}


def _run(ctx):
    wd = ctx.param('watch_dir')
    if not wd or not os.path.isdir(wd):
        ctx.log('✗ 文件夹不存在：%r' % wd)
        return {'ok': False, 'error': '文件夹不存在'}
    ctx.list_dir(wd)

    remote_base = (ctx.param('remote_path') or '/backup').rstrip('/')
    interval = max(5, int(ctx.param('interval', 300) or 300))
    rounds = max(0, int(ctx.param('rounds', 1) or 1))
    exclude = ctx.param('exclude', '')

    # 状态目录：优先用宿主给的数据目录，退回到插件自身目录
    data_dir = ctx.param('data_dir') or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '.data')
    os.makedirs(data_dir, exist_ok=True)
    sp = state_path_for(wd, data_dir)

    prev = load_state(sp)
    ctx.log('状态文件：%s（已记录 %d 个文件）' % (sp, len(prev)))

    snaps = []
    n = 0
    while True:
        n += 1
        cur = scan(wd, exclude)
        d = diff(cur, prev)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        remote_dir = '%s/%s' % (remote_base, stamp) if remote_base else '/' + stamp

        snap = {'round': n, 'stamp': stamp, 'remote_dir': remote_dir,
                'changed': d['changed'], 'deleted': d['deleted'],
                'total': len(cur),
                'bytes': sum(cur[r][0] for r in d['changed'])}
        snaps.append(snap)
        ctx.log('第 %d 轮：%d 个文件，变动 %d，删除 %d'
                % (n, len(cur), len(d['changed']), len(d['deleted'])))

        # ★ 只有真的有变动才推进状态 —— 否则"没检出变动"会丢掉删除记录
        if d['changed'] or d['deleted']:
            save_state(sp, cur)
            prev = cur

        ctx.progress(n / float(rounds or 1), '第 %d/%d 轮' % (n, rounds or 1))
        if rounds and n >= rounds:
            break
        if rounds == 0:
            break
        time.sleep(interval)

    total_changed = sum(len(s['changed']) for s in snaps)
    total_bytes = sum(s['bytes'] for s in snaps)
    ctx.log('完成 %d 轮：累计变动 %d 个文件，%d 字节'
            % (len(snaps), total_changed, total_bytes))
    return {'ok': True, 'watch_dir': os.path.abspath(wd),
            'remote_base': remote_base, 'snapshots': snaps,
            'total_changed': total_changed, 'total_bytes': total_bytes,
            'state_file': sp}


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
