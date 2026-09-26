"""
GitHub REST 封装

★ 只用标准库（urllib），不用 requests。
  原因：PyInstaller 打包时能少拖一堆依赖，三平台构建更稳。

两层 API：
  · Contents API  —— 单文件读写（简单，但单文件 ~1MB 起步就吃力）
  · Git 底层 API  —— createBlob → createTree → createCommit → updateRef
                     N 个文件只产生 1 次 commit（省配额、避冲突）
"""
import base64
import json
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.github.com'
RAW = 'https://raw.githubusercontent.com'


class GitHubError(Exception):
    """GitHub API 错误，带 status 便于上层判断（401/403/404/409 各有各的处理）"""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body or ''


def _ascii_safe(url):
    """把 URL 里的非 ASCII 字符 percent-encode

    ★ 为什么需要：
      http.client 发送 request line 时用 **ascii** 编码，
      URL 里只要有中文（文件名/描述/路径），就会抛：
        UnicodeEncodeError: 'ascii' codec can't encode characters in position N-M

      这在 Windows 上尤其致命 —— 用户文件名几乎必然含中文，
      分享/下载直接崩，而且错误信息对用户毫无提示性。

    ★ 为什么只处理非 ASCII：
      url.isascii() 时原样返回，绝不改动已有 URL ——
      避免把合法的 %XX 二次编码成 %25XX（那会 404）。
      只在确实含非 ASCII 时才逐段 quote，把风险降到最低。
    """
    if isinstance(url, bytes):
        return url
    if url.isascii():
        return url

    # ★★ 只编码非 ASCII 字符，绝不 unquote 已有内容。
    #
    #   早期这里是 quote(unquote(path)) —— 想处理"部分已编码"的情况，
    #   但 unquote 会把 %2F 解成真正的 '/'，再 quote 时 safe='/' 又保留它，
    #   于是路径**结构被改变**了：
    #       '/x/报告%2Fb.txt'  →  '/x/%E6%8A%A5%E5%91%8A/b.txt'
    #   本来是一个文件名，变成了两级路径。
    #
    #   只在含非 ASCII 时才走这里（上面已 return），
    #   逐字符编码可以完全保持原有结构不变。
    out = []
    for ch in url:
        if ord(ch) < 128:
            out.append(ch)
        else:
            out.append(urllib.parse.quote(ch, safe=''))
    return ''.join(out)


class GitHubAPI:
    def __init__(self, token='', timeout=60):
        self.token = token or ''
        self.timeout = timeout

    # ---------- 底层 ----------
    def _req(self, method, path, data=None, headers=None, raw_url=False,
             accept='application/vnd.github+json'):
        url = path if raw_url else (API + path)
        # ★ 必须编码非 ASCII —— http.client 用 ascii 编码 request line，
        #   中文文件名会直接 UnicodeEncodeError
        url = _ascii_safe(url)
        body = None
        hd = {'Accept': accept, 'User-Agent': 'gdpy'}
        if self.token:
            hd['Authorization'] = 'Bearer %s' % self.token
        if data is not None:
            if isinstance(data, (bytes, bytearray)):
                body = bytes(data)
            else:
                body = json.dumps(data, ensure_ascii=False).encode('utf-8')
                hd['Content-Type'] = 'application/json'
        if headers:
            hd.update(headers)

        req = urllib.request.Request(url, data=body, method=method)
        for k, v in hd.items():
            req.add_header(k, v)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                ctype = resp.headers.get('Content-Type', '')
                if 'json' in ctype:
                    try:
                        return json.loads(raw.decode('utf-8'))
                    except ValueError:
                        return raw
                return raw
        except urllib.error.HTTPError as e:
            raw = b''
            try:
                raw = e.read()
            except Exception:
                pass
            txt = raw.decode('utf-8', 'ignore')
            msg = 'HTTP %s' % e.code
            try:
                j = json.loads(txt)
                if isinstance(j, dict) and j.get('message'):
                    msg = '%s: %s' % (e.code, j['message'])
            except ValueError:
                if txt:
                    msg = '%s: %s' % (e.code, txt[:200])
            raise GitHubError(msg, status=e.code, body=txt)
        except urllib.error.URLError as e:
            raise GitHubError('网络错误：%s' % e.reason)

    # ---------- 身份 ----------
    def get_me(self):
        return self._req('GET', '/user')

    def get_username(self):
        return self.get_me().get('login', '')

    # ---------- 仓库 ----------
    def list_repos(self, per_page=100, page=1):
        return self._req('GET', '/user/repos?per_page=%d&page=%d&sort=updated'
                         % (per_page, page))

    def create_repo(self, name, private=True, description='', auto_init=False):
        return self._req('POST', '/user/repos', {
            'name': name, 'private': private,
            'description': description, 'auto_init': auto_init
        })

    def get_repo(self, owner, repo):
        return self._req('GET', '/repos/%s/%s' % (owner, repo))

    def delete_repo(self, owner, repo):
        self._req('DELETE', '/repos/%s/%s' % (owner, repo))

    # ---------- Contents API ----------
    def get_file(self, owner, repo, path, ref='main'):
        """返回 dict（含 content(base64) 与 sha）；二进制也能拿"""
        q = urllib.parse.urlencode({'ref': ref})
        return self._req('GET', '/repos/%s/%s/contents/%s?%s'
                         % (owner, repo, urllib.parse.quote(path), q))

    def put_file(self, owner, repo, path, content_bytes, message,
                 branch='main', sha=None):
        """写入文件（二进制走 base64）。返回 {content, commit}"""
        payload = {
            'message': message,
            'content': base64.b64encode(content_bytes).decode('ascii'),
            'branch': branch,
        }
        if sha:
            payload['sha'] = sha
        return self._req('PUT', '/repos/%s/%s/contents/%s'
                         % (owner, repo, urllib.parse.quote(path)), payload)

    def delete_file(self, owner, repo, path, message, branch='main', sha=None):
        if sha is None:
            sha = self.get_file(owner, repo, path, branch).get('sha')
        return self._req('DELETE', '/repos/%s/%s/contents/%s'
                         % (owner, repo, urllib.parse.quote(path)),
                         {'message': message, 'sha': sha, 'branch': branch})

    def raw(self, owner, repo, path, ref='main'):
        """下载原始字节。分享仓库是公开的，无需 token 也能用"""
        # ★ path 必须 quote —— 这里是唯一一处漏掉的（get_file/put_file
        #   都有 quote），中文文件名会崩
        url = '%s/%s/%s/%s/%s' % (RAW, owner, repo, ref,
                                  urllib.parse.quote(path))
        return self._req('GET', url, raw_url=True, accept='*/*')

    # ---------- Git 底层 API ----------
    def get_ref(self, owner, repo, ref='heads/main'):
        return self._req('GET', '/repos/%s/%s/git/ref/%s' % (owner, repo, ref))

    def get_commit(self, owner, repo, sha):
        return self._req('GET', '/repos/%s/%s/git/commits/%s' % (owner, repo, sha))

    def create_blob(self, owner, repo, content_bytes, encoding='base64'):
        if encoding == 'base64':
            data = base64.b64encode(content_bytes).decode('ascii')
        else:
            data = content_bytes.decode('utf-8')
        return self._req('POST', '/repos/%s/%s/git/blobs' % (owner, repo),
                         {'content': data, 'encoding': encoding})

    def create_tree(self, owner, repo, items, base_tree=None):
        payload = {'tree': items}
        if base_tree:
            payload['base_tree'] = base_tree
        return self._req('POST', '/repos/%s/%s/git/trees' % (owner, repo), payload)

    def create_commit(self, owner, repo, message, tree_sha, parents):
        return self._req('POST', '/repos/%s/%s/git/commits' % (owner, repo),
                         {'message': message, 'tree': tree_sha, 'parents': parents})

    def update_ref(self, owner, repo, ref, sha, force=False):
        return self._req('PATCH', '/repos/%s/%s/git/refs/%s' % (owner, repo, ref),
                         {'sha': sha, 'force': force})

    def batch_upload(self, owner, repo, files, message, branch='main',
                     on_progress=None):
        """
        批量上传 —— N 个文件只产生 1 次 commit

        files: [(path, bytes), ...]

        ★ 为什么不用 Contents API 逐个 put：
          那样是 N 次 commit，既费配额，中途失败还会留下半成品。
          走 Git API 是 1 次原子提交。

        ⚠️ 代价：必须先拿 base_tree，并发调用会互相覆盖。
           所以同一仓库的写入要串行 —— 这是 commit 层面的冲突，
           与文件路径是否相同无关。
        """
        ref = self.get_ref(owner, repo, 'heads/%s' % branch)
        latest_sha = ref['object']['sha']
        base_tree = self.get_commit(owner, repo, latest_sha)['tree']['sha']

        items = []
        for i, (path, data) in enumerate(files):
            blob = self.create_blob(owner, repo, data)
            items.append({'path': path, 'mode': '100644',
                          'type': 'blob', 'sha': blob['sha']})
            if on_progress:
                on_progress(i + 1, len(files))

        tree = self.create_tree(owner, repo, items, base_tree)
        commit = self.create_commit(owner, repo, message, tree['sha'], [latest_sha])
        self.update_ref(owner, repo, 'heads/%s' % branch, commit['sha'])
        return commit

    # ---------- Pages ----------
    def enable_pages(self, owner, repo, branch='main', path='/'):
        """启用 GitHub Pages（分享要用）。已启用会返回 409，属正常"""
        try:
            return self._req('POST', '/repos/%s/%s/pages' % (owner, repo),
                             {'source': {'branch': branch, 'path': path}})
        except GitHubError as e:
            if e.status == 409:
                return {'status': 'already_exists'}
            raise

    def get_pages(self, owner, repo):
        try:
            return self._req('GET', '/repos/%s/%s/pages' % (owner, repo))
        except GitHubError as e:
            if e.status == 404:
                return None
            raise
