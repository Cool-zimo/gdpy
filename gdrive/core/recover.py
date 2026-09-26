"""
孤儿恢复：把「物理存在但 VFS 无记录」的文件找回界面

★ 为什么有这个模块（2026-09-26 线上实测，推翻了之前的判断）：

    仓库里 45 个 blob、56.2 MB 没有 VFS 记录。
    上一份报告把它们定性为「孤儿 / 删除残留 / 占容量要清理」。

    ★ 那个判断是错的。看文件名：
        义务教育教科书 · 数学六年级上册.pdf        18.3 MB
        （备份）义务教育教科书·语文六年级下册.pdf    13.7 MB
        quark.exe / python.exe / 一批照片

      且每个 blob 都是所在目录里**唯一的文件、形态完整** ——
      真正的删除残留应该是「36 片里剩 1 片」这种残缺状态。

    ★ 结论：这不是垃圾，是**用户丢失的文件**。
      VFS 里能看到 15 个，仓库里躺着看不见的有 45 个 —— 丢的比留的多 3 倍。

★ 成因（已定位到 web 端 js/file-manager.js）：
    每次上传都新建一个随机目录 `mtrand/filename`，
    VFS 只指向最新那份，**旧目录的 blob 从不删除**。
    save.json 在仓库里有 4 份、math_history.json 有 3 份 —— 就是这么累积的。

★ 本模块的三条铁律：

    1. 只增不删 —— 绝不删除任何 blob，恢复失败也不会让情况变糟
    2. 落到独立目录 —— 默认 /drive_home/_recovered，不覆盖现有文件
    3. 先出计划 —— 生成 VFS 补丁供人确认，确认后才写回

★ 为什么落独立目录而不是原位：
    孤儿里有 12 个与现有文件重名（save.json x4 等），
    无法判断哪个版本是用户想要的。原位覆盖会丢数据，独立目录让用户自己比对。
"""
import os
import time

RECOVER_DIR = '/drive_home/_recovered'


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()).replace('Z', '.000Z')


def _dedupe(name, used):
    """重名加序号：a.txt → a(1).txt"""
    if name not in used:
        used.add(name)
        return name
    base, ext = os.path.splitext(name)
    i = 1
    while '%s(%d)%s' % (base, i, ext) in used:
        i += 1
    final = '%s(%d)%s' % (base, i, ext)
    used.add(final)
    return final


def build_plan(orphans, target_dir=RECOVER_DIR):
    """把孤儿列表转成 VFS 补丁。**不修改任何东西。**

    orphans : maintain.scan()['orphans']，每项需含
              owner / repo / path / size / sha / branch

    返回：
      {
        'folder': 目标目录路径,
        'files' : {虚拟路径: VFS 条目},
        'folder_entry': VFS 目录条目,
        'skipped': [跳过的项和原因],
      }
    """
    files, skipped = {}, []
    used = set()
    for o in orphans:
        path = o.get('path', '')
        name = path.rsplit('/', 1)[-1]
        if not name or name.startswith('.'):
            skipped.append({'path': path, 'why': '空名或隐藏文件'})
            continue
        size = int(o.get('size', 0) or 0)
        if size <= 0:
            # ★ 0 字节文件也恢复 —— 可能是 .gitkeep 之类，
            #   但更有可能是上传中断的残片。恢复出来让用户自己看，
            #   总比永远看不见强。
            pass
        final = _dedupe(name, used)
        vpath = '%s/%s' % (target_dir.rstrip('/'), final)
        ts = _now()
        files[vpath] = {
            'name': final,
            'type': 'file',
            'size': size,
            'chunks': [{
                'owner': o.get('owner', ''),
                'repo': o.get('repo', ''),
                'path': path,
                'size': size,
                'sha': o.get('sha', ''),
                'branch': o.get('branch') or 'main',
            }],
            'createdAt': ts,
            'updatedAt': ts,
            # ★ 标记来源，便于用户识别与后续清理
            'recovered': True,
        }
    folder_entry = None
    if files:
        folder_entry = {
            'name': target_dir.rsplit('/', 1)[-1],
            'type': 'folder',
            'createdAt': _now(),
            'recovered': True,
        }
    return {
        'folder': target_dir,
        'files': files,
        'folder_entry': folder_entry,
        'skipped': skipped,
    }


def apply_plan(vfs, plan):
    """把补丁合进 VFS（内存操作，不落盘）。

    ★ 只增不删：已有路径**跳过**而不是覆盖。
      覆盖会毁掉现有记录，而恢复本就是"找回来"，不该有破坏性。
    """
    vfs = dict(vfs or {})
    files = dict(vfs.get('files') or {})
    folders = dict(vfs.get('folders') or {})
    added, conflict = [], []
    for p, entry in (plan.get('files') or {}).items():
        if p in files:
            conflict.append(p)
            continue
        files[p] = entry
        added.append(p)
    fe = plan.get('folder_entry')
    if fe and plan.get('folder') not in folders:
        folders[plan['folder']] = fe
    vfs['files'] = files
    vfs['folders'] = folders
    return {'vfs': vfs, 'added': added, 'conflict': conflict}


def summary(plan, applied):
    """生成人可读的摘要"""
    files = plan.get('files') or {}
    total = sum(f.get('size', 0) for f in files.values())
    lines = [
        '恢复目标目录 : %s' % plan.get('folder'),
        '待恢复文件   : %d 个，共 %.1f MB' % (len(files), total / 1048576.0),
        '实际写入     : %d 个' % len(applied.get('added', [])),
        '冲突跳过     : %d 个' % len(applied.get('conflict', [])),
        '被忽略       : %d 个' % len(plan.get('skipped', [])),
    ]
    return '\n'.join(lines)
