#!/usr/bin/env python3
"""
仓库维护命令行工具

    python tools/maintain_cli.py scan      # 体检：孤儿 / 幽灵 / 记账偏差
    python tools/maintain_cli.py recover   # 把孤儿恢复到 /drive_home/_recovered

★ 为什么是 CLI 而不是界面按钮：

    web/ 是从 github_drive 仓库同步来的（tools/sync_web.py），
    直接改 web/ 里的文件，下次同步就被覆盖。
    所以界面入口必须提交到 github_drive（web 端），不是这里。

    CLI 保证能力不丢失，且不受同步影响。

★ token 来源（依次尝试）：
    1. 命令行 --token
    2. 环境变量 GITHUB_TOKEN / GDRIVE_TOKEN
    3. 桌面版配置文件（gdrive/core/config.py 的 accounts）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.api import GitHubAPI                    # noqa: E402
from gdrive.core.config import Config, app_dir           # noqa: E402
from gdrive.core.config_sync import ConfigSync           # noqa: E402
from gdrive.core.maintain import Maintain                # noqa: E402
from gdrive.core.recover import build_plan, apply_plan, summary  # noqa: E402
from gdrive.core.textutil import human_size              # noqa: E402

CONFIG_REPO = 'github-drive-config'


def _token(cli_token=None):
    if cli_token:
        return cli_token
    for k in ('GITHUB_TOKEN', 'GDRIVE_TOKEN'):
        if os.environ.get(k):
            return os.environ[k]
    try:
        cfg = Config(os.path.join(app_dir(), 'config.json'))
        accs = cfg.accounts()
        if accs:
            return accs[0].get('token', '')
    except Exception:
        pass
    return ''


def _load_remote(api, owner):
    sync = ConfigSync(api)
    sync.owner = owner
    return sync.pull()


def cmd_scan(api, owner, args):
    cfg = _load_remote(api, owner)
    vfs = cfg.get('fileIndex') or cfg.get('vfs') or {}
    repos = cfg.get('repos') or []
    if not repos:
        print('未取到存储仓库列表，放弃。')
        return 1

    m = Maintain(api, owner)
    rep = m.scan(vfs, repos)

    print('=' * 56)
    print('仓库体检 · %s' % owner)
    print('=' * 56)
    print('记录文件     : %d' % rep.get('file_count', 0))
    print('记录占用     : %s' % human_size(rep.get('recorded_bytes', 0)))
    print('实际占用     : %s' % human_size(rep.get('actual_bytes', 0)))
    print()
    print('★ 孤儿（物理存在、VFS 无记录）: %d 个  %s'
          % (len(rep['orphans']), human_size(rep.get('orphan_bytes', 0))))
    print('★ 幽灵（VFS 有记录、物理不存在）: %d 个'
          % len(rep.get('ghosts', [])))
    if rep.get('ghosts'):
        print('   → 这些文件下载必失败，界面上却看得见')
    if rep.get('errors'):
        print('扫描出错     : %d 个仓库' % len(rep['errors']))
        for e in rep['errors'][:5]:
            print('   %s' % e)

    print()
    print('--- 记账 vs 实际 ---')
    for k, v in sorted((rep.get('usage_actual') or {}).items(),
                       key=lambda x: -x[1]):
        rec = (rep.get('usage_recorded') or {}).get(k, 0)
        flag = ''
        if rec and v > rec * 1.2:
            flag = '  ★ 低估（系统会误以为还有空间）'
        elif rec and rec > v * 1.2:
            flag = '  虚高'
        print('  %-40s 记账 %-10s 实际 %-10s%s'
              % (k, human_size(rec), human_size(v), flag))

    if rep['orphans']:
        print()
        print('下一步：python tools/maintain_cli.py recover')
        print('  （只增不删，落到 /drive_home/_recovered，不会覆盖现有文件）')
    return 0


def cmd_recover(api, owner, args):
    cfg = _load_remote(api, owner)
    vfs = cfg.get('fileIndex') or cfg.get('vfs') or {}
    repos = cfg.get('repos') or []

    m = Maintain(api, owner)
    rep = m.scan(vfs, repos)
    if not rep['orphans']:
        print('没有孤儿，无需恢复。')
        return 0

    plan = build_plan(rep['orphans'], target_dir=args.target)
    ap = apply_plan(vfs, plan)
    print('=' * 56)
    print(summary(plan, ap))
    print('=' * 56)

    if ap['added']:
        print()
        for p in ap['added'][:20]:
            e = plan['files'][p]
            print('  %-10s %s' % (human_size(e['size']), e['name']))
        if len(ap['added']) > 20:
            print('  ... 其余 %d 个' % (len(ap['added']) - 20))

    if args.dry_run:
        print()
        print('[dry-run] 未写入。去掉 --dry-run 执行。')
        return 0

    if not args.yes:
        try:
            ans = input('\n写入 config.json？(y/N) ').strip().lower()
        except EOFError:
            ans = 'n'
        if ans != 'y':
            print('已取消。')
            return 0

    sync = ConfigSync(api)
    sync.owner = owner
    ok = sync.push(vfs=ap['vfs'])
    print('写回:', '✓ 成功' if ok else '✗ 失败')
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description='gdpy 仓库维护工具')
    ap.add_argument('cmd', choices=['scan', 'recover'])
    ap.add_argument('--token', default=None)
    ap.add_argument('--owner', default=None, help='GitHub 用户名，默认取登录账号')
    ap.add_argument('--target', default='/drive_home/_recovered')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--yes', action='store_true', help='跳过确认（谨慎）')
    args = ap.parse_args()

    tok = _token(args.token)
    if not tok:
        sys.stderr.write('拿不到 token：用 --token 或设 GITHUB_TOKEN\n')
        return 1

    api = GitHubAPI(tok)
    owner = args.owner or api.get_username()
    if not owner:
        sys.stderr.write('拿不到用户名\n')
        return 1

    if args.cmd == 'scan':
        return cmd_scan(api, owner, args)
    return cmd_recover(api, owner, args)


if __name__ == '__main__':
    sys.exit(main())
