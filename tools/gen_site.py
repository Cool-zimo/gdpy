"""
生成版本化下载站 → docs/

URL 形态：
    /gdpy/            → 最新正式版
    /gdpy/0.0.5/      → 指定版本
    /gdpy/versions/   → 全部版本

★ 为什么是静态生成而不是服务端跳转：
  GitHub Pages 只托管静态文件，没有 rewrite 规则可用。
  所以每个版本都生成一个真实目录，代价是文件多，
  好处是链接永久可用（旧版本 URL 不会因新版本发布而失效）。

★ 夸克链接：
  放 tools/quark.json，形如
    {"0.0.5": {"windows": "https://...", "macos": "...", "linux": "..."}}
  没填的平台按钮显示为「待补充」，不会出现点了没反应。

用法：
    python tools/gen_site.py              # 拉 GitHub releases 生成
    python tools/gen_site.py --offline    # 不联网，用已有数据重建
"""
import argparse
import json
import os
import re
import sys
import urllib.request

OWNER, REPO = 'Cool-zimo', 'gdpy'
SITE_BASE = '/gdpy'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')
QUARK_JSON = os.path.join(ROOT, 'tools', 'quark.json')

# ★ V0.0.4 起换成 webview 内核（网页版同款界面），之前是 Tkinter
#   旧版本页面必须说清楚，否则下载了会发现界面完全不一样
KERNEL_FROM = (0, 0, 4)

PLATFORMS = (
    ('windows', 'Windows', '🪟', '.exe', '10 及以上，自带 WebView2'),
    ('macos',   'macOS',   '🍎', '',     '11 及以上，Apple Silicon / Intel'),
    ('linux',   'Linux',   '🐧', '',     '需 libwebkit2gtk（GTK 桌面环境）'),
)

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
 "Microsoft YaHei",Roboto,sans-serif;background:#0b1120;color:#e5e7eb;
 line-height:1.65;padding:32px 20px 64px}
.wrap{max-width:860px;margin:0 auto}
header{text-align:center;margin-bottom:28px}
h1{font-size:29px;font-weight:650;letter-spacing:-.4px;margin-bottom:8px}
h1 .v{color:#34d399}
.sub{color:#94a3b8;font-size:14px}
nav{margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
nav a{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 13px;
 border:1px solid #1e293b;border-radius:99px;background:#0f172a}
nav a:hover{color:#e5e7eb;border-color:#334155}
.banner{margin:0 0 22px;padding:13px 16px;border-radius:11px;font-size:14px;
 background:#1e293b;border:1px solid #334155;color:#cbd5e1}
.banner a{color:#7dd3fc}
.banner.old{background:#2a1f16;border-color:#7c4a1e;color:#fcd9a8}
.grid{display:grid;gap:14px}
@media(min-width:680px){.grid{grid-template-columns:repeat(3,1fr)}}
.card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:19px;
 display:flex;flex-direction:column}
.card .ico{font-size:25px;margin-bottom:7px}
.card h2{font-size:16px;font-weight:600;margin-bottom:3px}
.card .req{font-size:11.5px;color:#64748b;margin-bottom:11px;line-height:1.5}
.card .size{font-size:11.5px;color:#475569;margin-bottom:12px}
.btn{display:block;text-align:center;text-decoration:none;border-radius:9px;
 padding:9px 11px;font-size:13.5px;font-weight:500;margin-bottom:7px;
 transition:background .15s}
.btn.primary{background:#059669;color:#fff}
.btn.primary:hover{background:#047857}
.btn.mirror{background:transparent;color:#7dd3fc;border:1px solid #0e7490}
.btn.mirror:hover{background:#0c4a6e}
.btn.quark{background:#0ea5e9;color:#fff}
.btn.quark:hover{background:#0284c7}
.btn.pending{background:#111827;color:#475569;border:1px dashed #374151;cursor:default}
.note{margin-top:26px;padding:15px 17px;background:#0f172a;border:1px solid #1e293b;
 border-radius:11px;font-size:13px;color:#94a3b8}
.note b{color:#e5e7eb}
.note+.note{margin-top:11px}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1e293b}
th{color:#64748b;font-weight:500;font-size:12px}
td a{color:#7dd3fc;text-decoration:none}
td.now{color:#34d399;font-weight:600}
footer{margin-top:34px;text-align:center;color:#475569;font-size:12px;line-height:1.8}
footer a{color:#64748b}
code{background:#111827;padding:1px 6px;border-radius:4px;font-size:12px;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#a5b4fc}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
"""


def api(path, token=''):
    r = urllib.request.Request('https://api.github.com' + path)
    for k, v in [('User-Agent', 'gdpy-site'),
                 ('Accept', 'application/vnd.github+json')]:
        r.add_header(k, v)
    if token:
        r.add_header('Authorization', 'Bearer %s' % token)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8', 'ignore'))


def parse_version(tag):
    m = re.search(r'(\d+)\.(\d+)\.(\d+)', tag or '')
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def pick_assets(assets):
    """资产 → {platform: (url, size)}"""
    out = {}
    for a in assets:
        n, url, sz = a['name'], a['browser_download_url'], a['size']
        low = n.lower()
        if 'windows' in low:
            out['windows'] = (url, sz)
        elif 'macos' in low:
            out['macos'] = (url, sz)
        elif 'linux' in low:
            out['linux'] = (url, sz)
    return out


def mb(n):
    return '%.1f MB' % (n / 1048576.0)


def page(version, assets, quark, latest, all_versions, pub_date):
    is_latest = (version == latest)
    a = pick_assets(assets)

    is_new_kernel = parse_version(version) >= KERNEL_FROM
    sub = ('把 GitHub 当网盘用的桌面客户端 · 网页版同款界面 · 三平台原生运行'
           if is_new_kernel else
           '把 GitHub 当网盘用的桌面客户端 · ⚠️ 本版为 Tkinter 界面（旧版）')

    banner = ''
    if not is_new_kernel and all_versions:
        banner = ('<div class="banner old">⚠️ 本版使用 Tkinter 界面。'
                  '从 <b>v0.0.4</b> 起已换成网页版同款界面 —— '
                  '<a href="%s/">前往最新版</a></div>' % SITE_BASE)
    if not is_latest:
        banner = ('<div class="banner old">⚠️ 这是旧版本。'
                  '最新版 <b>v%s</b> 已发布 —— <a href="%s/">前往下载</a>'
                  '　·　<a href="%s/versions/">查看全部版本</a></div>'
                  % (latest, SITE_BASE, SITE_BASE))
    elif all_versions:
        banner = ('<div class="banner">🎯 当前最新正式版　·　'
                  '<a href="%s/versions/">历史版本</a></div>' % SITE_BASE)

    cards = []
    for key, label, icon, ext, req in PLATFORMS:
        gh_url, size = a.get(key, ('', 0))
        q = (quark or {}).get(key, '')
        btns = []
        if gh_url:
            btns.append('<a class="btn primary" href="%s">GitHub 下载</a>' % gh_url)
            btns.append('<a class="btn mirror" href="https://ghproxy.net/%s">'
                        '国内镜像 · ghproxy</a>' % gh_url)
        if q:
            btns.append('<a class="btn quark" href="%s">夸克网盘</a>' % q)
        elif gh_url:
            btns.append('<span class="btn pending">夸克网盘 · 待补充</span>')
        if not btns:
            btns.append('<span class="btn pending">暂无构建</span>')
        cards.append(
            '<div class="card"><div class="ico">%s</div>'
            '<h2>%s</h2><div class="req">%s</div>'
            '<div class="size">%s</div>'
            '%s</div>' % (icon, label, req, mb(size) if size else '',
                          ''.join(btns)))

    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gdpy v%s · GitHub Drive 桌面版</title>
<style>%s</style></head><body><div class="wrap">
<header>
  <h1>gdpy · GitHub Drive <span class="v">v%s</span></h1>
  <div class="sub">%s</div>
  <nav>
    <a href="%s/">最新版</a>
    <a href="%s/versions/">全部版本</a>
    <a href="https://github.com/%s/%s">源码</a>
    <a href="https://github.com/%s/%s/releases">Releases</a>
  </nav>
</header>
%s
<div class="grid">%s</div>
<div class="note">
  <b>首次启动的拦截提示是正常的</b><br>
  Windows 会弹「Windows 已保护你的电脑」→ 点<b>仍要运行</b>；<br>
  macOS 会提示「身份不明的开发者」→ 右键打开，或到「隐私与安全性」允许。<br>
  原因：程序没有购买代码签名证书（年费较贵），并非病毒。
</div>
<div class="note">
  <b>下载不动怎么办</b><br>
  优先用「夸克网盘」（国内 CDN）。没有的话试 ghproxy 镜像，
  下载后核对大小：Windows 版应为 <b>15.1 MB</b>。<br>
  两个都不行可以本地构建：源码里有 <code>本地构建_Windows.bat</code>（需 Python）。
</div>
<footer>
  v%s%s · 源码 MIT 开源 · 可执行文件不入库，由 GitHub Actions 编译<br>
  本页由 <code>tools/gen_site.py</code> 自动生成，请勿手工编辑
</footer>
</div></body></html>
""" % (version, CSS, version, sub, SITE_BASE, SITE_BASE, OWNER, REPO, OWNER, REPO,
       banner, ''.join(cards), version,
       (' · 发布于 %s' % pub_date) if pub_date else '')


def versions_page(rels, latest):
    rows = []
    for tag, date, assets in rels:
        a = pick_assets(assets)
        sizes = ' / '.join(mb(a[k][1]) for k in ('windows', 'macos', 'linux')
                           if k in a)
        mark = '<span class="now">最新</span>' if tag.lstrip('v') == latest else ''
        rows.append('<tr><td><a href="%s/%s/">%s</a> %s</td><td>%s</td>'
                    '<td class="mono">%s</td></tr>'
                    % (SITE_BASE, tag.lstrip('v'), tag, mark, date or '—', sizes))
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>全部版本 · gdpy</title>
<style>%s</style></head><body><div class="wrap">
<header>
  <h1>全部版本</h1>
  <div class="sub">旧版本链接永久有效，不会因新版本发布而失效</div>
  <nav>
    <a href="%s/">← 回最新版</a>
    <a href="https://github.com/%s/%s">源码</a>
  </nav>
</header>
<table><tr><th>版本</th><th>发布日期</th><th>Windows / macOS / Linux</th></tr>
%s</table>
<footer>本页由 <code>tools/gen_site.py</code> 自动生成</footer>
</div></body></html>
""" % (CSS, SITE_BASE, OWNER, REPO, ''.join(rows))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    ap.add_argument('--offline', action='store_true')
    args = ap.parse_args()

    quark_all = {}
    if os.path.isfile(QUARK_JSON):
        try:
            quark_all = json.load(open(QUARK_JSON, encoding='utf-8'))
        except Exception as e:
            print('  (quark.json 读取失败: %s)' % e)

    if args.offline and os.path.isfile(os.path.join(DOCS, 'releases.json')):
        data = json.load(open(os.path.join(DOCS, 'releases.json'), encoding='utf-8'))
        rels = [(d['tag'], d['date'], d['assets']) for d in data]
    else:
        raw = api('/repos/%s/%s/releases?per_page=50' % (OWNER, REPO), args.token)
        rels = [(r['tag_name'], (r.get('published_at') or '')[:10], r['assets'])
                for r in raw if not r.get('draft')]

    if not rels:
        print('没有已发布的版本')
        return 1

    rels.sort(key=lambda x: parse_version(x[0]), reverse=True)
    latest = rels[0][0].lstrip('v')

    os.makedirs(DOCS, exist_ok=True)
    for tag, date, assets in rels:
        ver = tag.lstrip('v')
        d = os.path.join(DOCS, ver)
        os.makedirs(d, exist_ok=True)
        html = page(ver, assets, quark_all.get(ver, {}), latest, rels, date)
        with open(os.path.join(d, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(html)
        print('  %-10s %6d 字节' % (ver, len(html)))

    # 根 index.html = 最新版
    with open(os.path.join(DOCS, ver, 'index.html'), 'r', encoding='utf-8') as f:
        pass
    latest_html = page(latest, rels[0][2], quark_all.get(latest, {}),
                       latest, rels, rels[0][1])
    with open(os.path.join(DOCS, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(latest_html)
    print('  /          → v%s (%d 字节)' % (latest, len(latest_html)))

    vd = os.path.join(DOCS, 'versions')
    os.makedirs(vd, exist_ok=True)
    with open(os.path.join(vd, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(versions_page(rels, latest))
    print('  /versions/ 版本列表')

    # 留一份数据，便于 --offline 重建
    with open(os.path.join(DOCS, 'releases.json'), 'w', encoding='utf-8') as f:
        json.dump([{'tag': t, 'date': d, 'assets': a} for t, d, a in rels],
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
