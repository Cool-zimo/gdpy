"""
带 Keep-Alive 的 HTTP 连接池（桌面版网络层）

★ 为什么不用 urllib.request.urlopen
  urlopen 每次调用都新建 TCP + TLS。实测（同一批 8 个 api.github.com 请求）：

      每次新建连接   11.01 s
      复用一条连接    4.12 s     ← 2.7 倍差距

  列一次文件列表要发 15 个请求。在国内网络下 TLS 握手的 RTT 更贵，
  差距只会更大。桌面版"慢到像卡住"，这是主因之一。

★ 为什么不用 requests
  requests 会带进 certifi / urllib3 / idna / charset_normalizer，
  三平台 PyInstaller 打包体积和兼容性都变复杂。标准库够用。

★ 重定向
  urllib 会自动跟随 3xx。这里必须自己处理，而且要遵守一条安全规则：
    跨主机跳转时丢掉 Authorization —— 否则 token 会被送到跳转目标。
  （GitHub 的 release-assets 就会 302 到别的域。）
"""
import base64
import http.client
import ssl
import threading
from urllib.parse import urlsplit, urlunsplit, quote

# 跨主机跳转时不能带走的头
_SENSITIVE = ('authorization', 'cookie', 'proxy-authorization')

MAX_REDIRECTS = 5


class Response(object):
    __slots__ = ('status', 'reason', 'headers', 'body')

    def __init__(self, status, reason, headers, body):
        self.status = status
        self.reason = reason
        self.headers = headers
        self.body = body

    def as_bridge_dict(self):
        return {
            'status': self.status,
            'status_text': self.reason or '',
            'headers': dict(self.headers or {}),
            'body_b64': base64.b64encode(self.body or b'').decode('ascii'),
        }


class Error(Exception):
    """网络层错误。msg 会直接显示给用户，所以必须看得懂。"""

    def __init__(self, msg):
        Exception.__init__(self, msg)
        self.msg = msg

    def as_bridge_dict(self):
        return {'status': 0, 'status_text': self.msg,
                'headers': {}, 'body_b64': ''}


class _Pool(object):
    """(scheme, host, port) → 可复用的连接

    ★ 线程安全：pywebview 的 js_api 在独立线程执行，同一时刻可能有多个
      请求（比如分片并发上传）。连接必须**独占检出** —— 两个线程共用一条
      http.client 连接会把响应流读串。

      做法是 checkout / checkin：被借走的连接从池里移除，
      别的线程需要时自己新建一条（而不是等着）。
    """

    def __init__(self):
        self._conns = {}
        self._lock = threading.Lock()

    def _key(self, scheme, host, port):
        return (scheme, host.lower(), port)

    def _make(self, scheme, host, port, timeout):
        if scheme == 'https':
            ctx = ssl.create_default_context()
            return http.client.HTTPSConnection(host, port, context=ctx,
                                               timeout=timeout)
        return http.client.HTTPConnection(host, port, timeout=timeout)

    def checkout(self, scheme, host, port, timeout):
        """借出一条独占连接"""
        k = self._key(scheme, host, port)
        with self._lock:
            c = self._conns.pop(k, None)
        if c is None:
            c = self._make(scheme, host, port, timeout)
        return c

    def checkin(self, scheme, host, port, conn):
        """还回连接，供后续请求复用"""
        k = self._key(scheme, host, port)
        with self._lock:
            old = self._conns.pop(k, None)
            self._conns[k] = conn
        if old is not None and old is not conn:
            try:
                old.close()
            except Exception:
                pass

    def drop(self, scheme, host, port, conn=None):
        """丢弃（连接坏了）。传 conn 表示这条坏了；不传则清掉池里的。"""
        k = self._key(scheme, host, port)
        with self._lock:
            c = self._conns.pop(k, None) if conn is None else conn
        if c is not None:
            try:
                c.close()
            except Exception:
                pass

    def close_all(self):
        with self._lock:
            conns = list(self._conns.values())
            self._conns.clear()
        for c in conns:
            try:
                c.close()
            except Exception:
                pass


def _safe_path(url):
    """把 URL 里非 ASCII 的部分编码掉

    http.client 用 ascii 编码 request line，中文路径会抛
    UnicodeEncodeError（V0.0.3 修过的就是它）。
    """
    parts = urlsplit(url)
    path = quote(parts.path, safe='/%=+&;,:@')
    query = quote(parts.query, safe='/%=+&;,:?@')
    return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def request(method, url, headers=None, body=None, timeout=60, pool=None,
            max_redirects=MAX_REDIRECTS):
    """发一个请求，返回 Response 或抛 Error。自动跟随重定向。"""
    own = pool is None
    if own:
        pool = _Pool()
    try:
        return _request_with_redirects(
            method, url, headers, body, timeout, pool, max_redirects)
    finally:
        if own:
            pool.close_all()


def _request_with_redirects(method, url, headers, body, timeout, pool,
                            left):
    for _ in range(left + 1):
        resp = _once(method, url, headers, body, timeout, pool)
        if resp.status not in (301, 302, 303, 307, 308):
            return resp
        loc = _header(resp.headers, 'location')
        if not loc:
            return resp
        nxt = _resolve(url, loc)
        if not nxt:
            return resp
        old_host = (urlsplit(url).hostname or '').lower()
        new_host = (urlsplit(nxt).hostname or '').lower()
        if new_host != old_host:
            # ★ 跨主机跳转必须丢掉凭据
            headers = {k: v for k, v in (headers or {}).items()
                       if k.lower() not in _SENSITIVE}
        if resp.status in (301, 302, 303):
            method = 'GET'
            body = None
        url = nxt
    raise Error('重定向次数过多（>%d）' % left)


def _header(headers, name):
    if not headers:
        return None
    want = name.lower()
    for k, v in headers.items():
        if k.lower() == want:
            return v
    return None


def _resolve(base, loc):
    from urllib.parse import urljoin
    try:
        return urljoin(base, loc)
    except Exception:
        return None


def _once(method, url, headers, body, timeout, pool):
    url = _safe_path(url)
    p = urlsplit(url)
    scheme = p.scheme.lower()
    if scheme not in ('http', 'https'):
        raise Error('不支持的协议：%s' % scheme)
    host = p.hostname or ''
    port = p.port or (443 if scheme == 'https' else 80)
    path = p.path or '/'
    if p.query:
        path += '?' + p.query

    keep = {k: v for k, v in (headers or {}).items()
            if k.lower() not in ('content-length', 'host', 'connection',
                                 'accept-encoding', 'transfer-encoding')}
    if body is not None:
        keep['Content-Length'] = str(len(body))

    last = None
    for attempt in (0, 1):
        conn = pool.checkout(scheme, host, port, timeout)
        try:
            conn.request(method, path, body=body, headers=keep)
            r = conn.getresponse()
            raw = r.read()
            hdrs = {k.lower(): v for k, v in r.getheaders()}
            pool.checkin(scheme, host, port, conn)
            return Response(r.status, r.reason, hdrs, raw)
        except (http.client.HTTPException, OSError, ssl.SSLError) as e:
            last = e
            # 连接可能已被服务端关掉（keep-alive 超时）→ 丢弃重建，再试一次
            pool.drop(scheme, host, port, conn)
            if attempt == 0:
                continue
    raise Error('%s: %s' % (type(last).__name__, last))
