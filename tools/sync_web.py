"""
把网页版 github_drive 的前端资源同步到 web/ 目录

★ 为什么要"复制"而不是"引用"：
  PyInstaller 打包后没有网络，也不该依赖网络。前端必须打进 exe。
  代价是两份代码会漂移 —— 所以本脚本必须能一键重跑，
  并把源仓库的 commit SHA 写进 web/SOURCE.txt 便于追溯。

用法：
    python tools/sync_web.py                # 从 GitHub 拉取
    python tools/sync_web.py --dry-run      # 只看会同步什么
"""
import argparse
import base64
import json
import os
import sys
import urllib.request

SRC_OWNER = 'Cool-zimo'
SRC_REPO = 'github_drive'
SRC_BRANCH = 'main'

# 只同步前端运行时需要的东西
INCLUDE_TOP = ('js', 'css', 'assets', 'index.html')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'web')


def api(path, token=''):
    r = urllib.request.Request('https://api.github.com' + path)
    for k, v in [('User-Agent', 'gdpy-sync'),
                 ('Accept', 'application/vnd.github+json')]:
        r.add_header(k, v)
    if token:
        r.add_header('Authorization', 'Bearer %s' % token)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8', 'ignore'))


def walk(path, token):
    out = []
    for f in api('/repos/%s/%s/contents/%s?ref=%s'
                 % (SRC_OWNER, SRC_REPO, path, SRC_BRANCH), token):
        if f['type'] == 'dir':
            out += walk(f['path'], token)
        else:
            out.append((f['path'], f['size']))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    files = walk('', args.token)
    keep = [(p, s) for p, s in files
            if p.split('/')[0] in INCLUDE_TOP or p == 'index.html']

    sha = ''
    try:
        sha = api('/repos/%s/%s/commits/%s'
                  % (SRC_OWNER, SRC_REPO, SRC_BRANCH), args.token)['sha']
    except Exception as e:
        print('  (取不到源 commit: %s)' % e)

    print('源: %s/%s@%s' % (SRC_OWNER, SRC_REPO, (sha or '?')[:8]))
    print('文件 %d 个, 共 %.0f KB' % (len(keep), sum(s for _, s in keep) / 1024))

    if args.dry_run:
        for p, s in sorted(keep):
            print('  %-34s %7d' % (p, s))
        return 0

    n = 0
    for path, size in keep:
        try:
            data = api('/repos/%s/%s/contents/%s?ref=%s'
                       % (SRC_OWNER, SRC_REPO, path, SRC_BRANCH), args.token)
            raw = base64.b64decode(data['content'])
        except Exception as e:
            print('  ✗ %s: %s' % (path, e))
            continue
        dst = os.path.join(DEST, path)
        d = os.path.dirname(dst)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(raw)
        n += 1

    with open(os.path.join(DEST, 'SOURCE.txt'), 'w', encoding='utf-8') as f:
        f.write('%s/%s@%s\n' % (SRC_OWNER, SRC_REPO, sha))

    print('✓ 已同步 %d 个文件到 web/' % n)
    return 0


if __name__ == '__main__':
    sys.exit(main())
