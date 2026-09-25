"""
分享 —— 与 web 版同一套机制，双向兼容

机制：
    创建公开仓库 gd-share-* → 上传文件 + index.html + share.json
    → 启用 GitHub Pages → 拿到链接的人无需 Token 即可下载

★ 兼容契约（与 js/share.js 一致）：
    仓库名    gd-share-{6位hex}   （旧名 share-* 也要认）
    忽略文件  index.html / README.md / status.js / share.json
    元信息    share.json = {files:[{name,size}], createdAt, ...}
    Pages     https://{owner}.github.io/{repo}/

★ 读取分享不需要 Token —— 分享仓库是公开的，走 raw.githubusercontent.com。
"""
import json
import random
import time
import urllib.request

from .api import GitHubAPI

SHARE_PREFIX = 'gd-share-'
LEGACY_PREFIX = 'share-'
SYSTEM_FILES = {'index.html', 'README.md', 'status.js', 'share.json'}


def _anon_api():
    """匿名 API（读公开分享用，不带 Token）"""
    return GitHubAPI(token='')


def pages_url(owner, repo):
    return 'https://%s.github.io/%s/' % (owner, repo)


def is_share_repo(name):
    n = (name or '').lower()
    return n.startswith(SHARE_PREFIX) or n.startswith(LEGACY_PREFIX)


class ShareManager:
    def __init__(self, api, config, owner=''):
        self.api = api
        self.cfg = config
        self.owner = owner

    # ---------------- 列出我的分享 ----------------
    def list_my_shares(self, max_pages=5):
        """
        ★ 真实来源是账号的仓库列表，不是本地记录。

        原因：本地记录换设备/清缓存就没了，但仓库还在 GitHub 上。
        本地只用来补充 description 等元信息。
        """
        found = []
        for page in range(1, max_pages + 1):
            repos = self.api.list_repos(100, page)
            if not repos:
                break
            for r in repos:
                if not is_share_repo(r['name']):
                    continue
                if self.owner and r['owner']['login'] != self.owner:
                    continue
                found.append({
                    'repoName': r['name'],
                    'fullName': r['full_name'],
                    'owner': r['owner']['login'],
                    'shareUrl': pages_url(r['owner']['login'], r['name']),
                    'description': r.get('description') or '',
                    'createdAt': r.get('created_at'),
                    'size': r.get('size', 0),
                    'fromRemote': True,
                })
            if len(repos) < 100:
                break
        found.sort(key=lambda x: (x.get('createdAt') or ''), reverse=True)
        self.cfg.set('shares', found)
        self.cfg.save()
        return found

    # ---------------- 创建分享 ----------------
    def create_share(self, files, description='', repo_name=None,
                     on_progress=None):
        """
        files: [(显示名, 字节数据), ...]

        ★ 用 batch_upload（Git API）—— 所有文件 + index.html + share.json
          一次性提交，只产生 1 个 commit。
        """
        if not files:
            raise ValueError('没有要分享的文件')

        name = repo_name or (SHARE_PREFIX + '%06x' % random.randint(0, 0xFFFFFF))
        repo = self.api.create_repo(
            name, private=False,
            description=description or 'gdpy 分享', auto_init=False)
        owner = repo['owner']['login']

        payload = []
        for fname, data in files:
            payload.append((fname, data))

        meta = {
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'createdBy': 'gdpy',
            'description': description,
            'files': [{'name': f[0], 'size': len(f[1])} for f in files],
        }
        payload.append(('share.json', json.dumps(
            meta, ensure_ascii=False, indent=2).encode('utf-8')))
        payload.append(('index.html', _download_page(owner, name, files,
                                                     description).encode('utf-8')))
        payload.append(('README.md',
                        ('# %s\n\n%s\n\n共 %d 个文件。\n'
                         % (description or '分享', pages_url(owner, name),
                            len(files))).encode('utf-8')))

        # 空仓库没有 main 分支，先建一个初始提交
        try:
            self.api.get_ref(owner, name, 'heads/main')
        except Exception:
            self.api.put_file(owner, name, '.gitkeep', b'',
                              '初始化分享仓库', branch='main')

        self.api.batch_upload(owner, name, payload, '创建分享',
                              branch='main', on_progress=on_progress)

        try:
            self.api.enable_pages(owner, name, branch='main')
        except Exception:
            pass   # Pages 可能延迟生效，不阻断

        info = {
            'repoName': name, 'owner': owner, 'fullName': '%s/%s' % (owner, name),
            'shareUrl': pages_url(owner, name),
            'description': description,
            'files': [{'name': f[0], 'size': len(f[1])} for f in files],
            'createdAt': meta['createdAt'],
        }
        self.cfg.add_share(info)
        return info

    def delete_share(self, repo_name):
        if self.owner:
            self.api.delete_repo(self.owner, repo_name)
        self.cfg.remove_share(repo_name)

    # ---------------- 读取别人的分享（无需 Token）----------------
    @staticmethod
    def read_share(owner, repo):
        """
        读公开分享的文件列表

        优先读 share.json（有大小等元信息）；
        没有就列 tree（排除系统文件）—— 兼容早期分享。
        """
        api = _anon_api()
        try:
            meta = json.loads(api.raw(owner, repo, 'share.json').decode('utf-8'))
            files = meta.get('files') or []
            if files:
                return {
                    'owner': owner, 'repo': repo,
                    'url': pages_url(owner, repo),
                    'description': meta.get('description', ''),
                    'files': [{'name': f.get('name'),
                               'size': f.get('size', 0)} for f in files],
                    'source': 'share.json',
                }
        except Exception:
            pass

        # 回退：列仓库文件
        data = api._req('GET', '/repos/%s/%s/contents/' % (owner, repo))
        files = []
        if isinstance(data, list):
            for it in data:
                if it.get('type') == 'file' and it.get('name') not in SYSTEM_FILES:
                    files.append({'name': it['name'], 'size': it.get('size', 0)})
        return {
            'owner': owner, 'repo': repo, 'url': pages_url(owner, repo),
            'description': '', 'files': files, 'source': 'tree',
        }

    @staticmethod
    def download_shared_file(owner, repo, filename):
        """下载分享里的单个文件 —— 公开仓库，无需 Token"""
        return _anon_api().raw(owner, repo, filename)

    @staticmethod
    def fetch_share_bytes(url):
        """直接按 URL 取字节（用户贴分享链接时用）"""
        req = urllib.request.Request(url, headers={'User-Agent': 'gdpy'})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()


def _download_page(owner, repo, files, description=''):
    """生成与 web 版同风格的下载页"""
    items = []
    for name, data in files:
        url = 'https://raw.githubusercontent.com/%s/%s/main/%s' % (
            owner, repo, urllib.parse.quote(name))
        items.append(
            '      <div class="file">\n'
            '        <span class="fname">%s</span>\n'
            '        <span class="fsize">%s</span>\n'
            '        <a class="dl" href="%s" target="_blank">下载</a>\n'
            '      </div>' % (_esc(name), _hsize(len(data)), _esc(url)))
    return (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        '<title>%s</title>\n<style>\n'
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,'
        '"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;'
        'max-width:720px;margin:40px auto;padding:0 16px;color:#1f2937}\n'
        'h1{font-size:20px}\n.file{display:flex;align-items:center;gap:12px;'
        'padding:12px 0;border-bottom:1px solid #e5e7eb}\n'
        '.fname{flex:1;font-size:14px;word-break:break-all}\n'
        '.fsize{color:#6b7280;font-size:13px}\n'
        '.dl{background:#4f46e5;color:#fff;text-decoration:none;'
        'padding:6px 14px;border-radius:6px;font-size:13px}\n'
        '.dl:hover{background:#4338ca}\n'
        '</style>\n</head>\n<body>\n'
        '  <h1>%s</h1>\n  <p style="color:#6b7280;font-size:13px">'
        '共 %d 个文件 · 由 gdpy 生成</p>\n%s\n'
        '</body>\n</html>\n'
        % (_esc(description or '文件分享'), _esc(description or '文件分享'),
           len(files), '\n'.join(items)))


def _esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def _hsize(n):
    n = float(n or 0)
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return '%d %s' % (n, u) if u == 'B' else '%.1f %s' % (n, u)
        n /= 1024.0
    return '%.1f GB' % n


import urllib.parse  # noqa: E402  (供 _download_page 使用)
