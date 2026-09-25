"""
Markdown 预览 —— 纯标准库渲染成独立 HTML

★ 为什么不直接复用 tiny-md.js：
  那是 JS，跑在浏览器里；插件是 Python，跑在桌面端进程里。
  两边同一套渲染规则可以通过测试对齐，但代码无法共用。
  所以这里用标准库重写一份同功能子集。

★ 先 esc 再生成标签 —— 顺序反了就是 XSS。
  用户输入里的 <script> 必须早就变成 &lt;script&gt;，
  我们自己拼的 <b>/<pre> 才是真标签。

支持：# 标题、- 列表、1. 有序、- [ ] 任务、`行内码`、```代码块```、
      **粗** *斜* ~~删~~ ==高亮==、> 引用、--- 分隔、| 表格 |、
      [链接](url)、![图片](url)、$公式$ 与裸公式（a^2、x_i、\frac{a}{b}）
"""
import html
import os
import re

TEX_SYM = {
    r'\alpha': 'α', r'\beta': 'β', r'\gamma': 'γ', r'\delta': 'δ',
    r'\epsilon': 'ε', r'\theta': 'θ', r'\lambda': 'λ', r'\mu': 'μ',
    r'\pi': 'π', r'\rho': 'ρ', r'\sigma': 'σ', r'\tau': 'τ', r'\phi': 'φ',
    r'\omega': 'ω', r'\Gamma': 'Γ', r'\Delta': 'Δ', r'\Theta': 'Θ',
    r'\Lambda': 'Λ', r'\Pi': 'Π', r'\Sigma': 'Σ', r'\Omega': 'Ω',
    r'\times': '×', r'\div': '÷', r'\pm': '±', r'\cdot': '·',
    r'\leq': '≤', r'\geq': '≥', r'\neq': '≠', r'\approx': '≈',
    r'\infty': '∞', r'\sum': '∑', r'\int': '∫', r'\sqrt': '√',
    r'\to': '→', r'\rightarrow': '→', r'\leftarrow': '←',
    r'\Rightarrow': '⇒', r'\Leftarrow': '⇐', r'\in': '∈',
    r'\forall': '∀', r'\exists': '∃', r'\cup': '∪', r'\cap': '∩',
    r'\partial': '∂', r'\nabla': '∇', r'\propto': '∝',
}


def esc(s):
    return html.escape(str(s), quote=False).replace("'", '&#39;').replace('"', '&quot;')


def text_tex(t):
    """LaTeX 子集 → HTML"""
    for k, v in TEX_SYM.items():
        t = t.replace(k, v)

    def frac(m):
        return '<span class="frac"><span class="num">%s</span>' \
               '<span class="den">%s</span></span>' % (m.group(1), m.group(2))

    for _ in range(4):
        t = re.sub(r'\\frac\{([^{}]*)\}\{([^{}]*)\}', frac, t)
    t = re.sub(r'\\sqrt\{([^{}]*)\}', r'√(\1)', t)
    t = re.sub(r'\\text\{([^{}]*)\}', r'\1', t)
    t = re.sub(r'\^\{([^{}]*)\}', r'<sup>\1</sup>', t)
    t = re.sub(r'_\{([^{}]*)\}', r'<sub>\1</sub>', t)
    t = re.sub(r'\^(\w)', r'<sup>\1</sup>', t)
    t = re.sub(r'_(\w)', r'<sub>\1</sub>', t)
    t = re.sub(r'\\[a-zA-Z]+', '', t)
    return t


def _has_math(s):
    return bool(re.search(r'[\\^_]|\\[a-zA-Z]', s))


def inline(t):
    """行内渲染 —— 输入必须是已转义的"""
    # 行内码先抽走，里面的 * _ 不能当强调
    codes = []

    def _c(m):
        codes.append(m.group(1))
        return '\x00C%d\x00' % (len(codes) - 1)

    t = re.sub(r'`([^`]+)`', _c, t)

    t = re.sub(r'!\[([^\]]*)\]\((https?://[^\s)]+)\)',
               r'<img src="\2" alt="\1">', t)
    t = re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)',
               r'<a href="\2" target="_blank" rel="noopener">\1</a>', t)

    t = re.sub(r'==([^=]+)==', r'<mark>\1</mark>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'~~([^~]+)~~', r'<del>\1</del>', t)

    # 公式：$...$ 明确包裹，或含 ^ _ \ 的裸片段
    def _m(m):
        return '<span class="math">%s</span>' % text_tex(m.group(1))

    t = re.sub(r'\$([^$]+)\$', _m, t)

    def _bare(m):
        s = m.group(0)
        return ('<span class="math">%s</span>' % text_tex(s)) if _has_math(s) else s

    # 上标：宽松（^ 在正常文本里几乎不出现）
    t = re.sub(r'[A-Za-z0-9)\]]\^[A-Za-z0-9{(][^\s，。；]{0,20}', _bare, t)
    # ★ 下标：收紧 —— 只认单字符或 {group}。
    #   放宽会让 my_file.js 这类 snake_case 文件名变成 my<sub>f</sub>ile，
    #   误伤远比"x_ij 不渲染"严重（后者可以写成 x_{ij}）。
    t = re.sub(r'[A-Za-z0-9)\]]_(?:[A-Za-z0-9](?![A-Za-z0-9])|\{[^{}]+\})',
               _bare, t)

    for i, c in enumerate(codes):
        t = t.replace('\x00C%d\x00' % i, '<code>%s</code>' % c)
    return t


def render(md_text):
    """Markdown → HTML 片段"""
    lines = md_text.replace('\r\n', '\n').split('\n')
    out = []
    i = 0
    para = []

    def flush():
        if para:
            out.append('<p>%s</p>' % inline(esc(' '.join(para))))
            del para[:]

    while i < len(lines):
        ln = lines[i]
        raw = ln.rstrip()
        s = raw.strip()

        # 代码块
        if s.startswith('```'):
            flush()
            lang = s[3:].strip()
            buf = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                buf.append(lines[i])
                i += 1
            i += 1
            cls = ' class="lang-%s"' % esc(lang) if lang else ''
            out.append('<pre><code%s>%s</code></pre>'
                       % (cls, esc('\n'.join(buf))))
            continue

        if not s:
            flush()
            i += 1
            continue

        m = re.match(r'^(#{1,6})\s+(.*)$', s)
        if m:
            flush()
            lv = len(m.group(1))
            out.append('<h%d>%s</h%d>' % (lv, inline(esc(m.group(2))), lv))
            i += 1
            continue

        if re.match(r'^(-{3,}|\*{3,}|_{3,})$', s):
            flush()
            out.append('<hr>')
            i += 1
            continue

        m = re.match(r'^>\s?(.*)$', s)
        if m:
            flush()
            buf = []
            while i < len(lines):
                mm = re.match(r'^>\s?(.*)$', lines[i].strip())
                if not mm:
                    break
                buf.append(mm.group(1))
                i += 1
            out.append('<blockquote>%s</blockquote>'
                       % inline(esc(' '.join(buf))))
            continue

        m = re.match(r'^[-*+]\s+\[([ xX])\]\s+(.*)$', s)
        if m:
            flush()
            items = []
            while i < len(lines):
                mm = re.match(r'^[-*+]\s+\[([ xX])\]\s+(.*)$', lines[i].strip())
                if not mm:
                    break
                ck = ' checked' if mm.group(1).lower() == 'x' else ''
                items.append('<li><input type="checkbox" disabled%s> %s</li>'
                             % (ck, inline(esc(mm.group(2)))))
                i += 1
            out.append('<ul class="task">%s</ul>' % ''.join(items))
            continue

        m = re.match(r'^[-*+]\s+(.*)$', s)
        if m:
            flush()
            items = []
            while i < len(lines):
                mm = re.match(r'^[-*+]\s+(.*)$', lines[i].strip())
                if not mm:
                    break
                items.append('<li>%s</li>' % inline(esc(mm.group(1))))
                i += 1
            out.append('<ul>%s</ul>' % ''.join(items))
            continue

        m = re.match(r'^\d+[.)]\s+(.*)$', s)
        if m:
            flush()
            items = []
            while i < len(lines):
                mm = re.match(r'^\d+[.)]\s+(.*)$', lines[i].strip())
                if not mm:
                    break
                items.append('<li>%s</li>' % inline(esc(mm.group(1))))
                i += 1
            out.append('<ol>%s</ol>' % ''.join(items))
            continue

        if '|' in s and i + 1 < len(lines) and re.match(
                r'^\|?[\s:|-]+\|[\s:|-]*$', lines[i + 1].strip()):
            flush()
            aligns = []
            for c in lines[i + 1].strip().strip('|').split('|'):
                c = c.strip()
                aligns.append('right' if c.endswith(':') and c.startswith(':')
                              else ('right' if c.endswith(':')
                                    else ('left' if c.startswith(':') else '')))
            cells = [c.strip() for c in s.strip('|').split('|')]
            head = ''.join('<th%s>%s</th>'
                           % (' style="text-align:%s"' % a if a else '',
                              inline(esc(c)))
                           for c, a in zip(cells, aligns))
            i += 2
            rows = []
            while i < len(lines) and '|' in lines[i]:
                cs = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append('<tr>%s</tr>'
                            % ''.join('<td%s>%s</td>'
                                      % (' style="text-align:%s"' % a if a else '',
                                         inline(esc(c)))
                                      for c, a in zip(cs, aligns)))
                i += 1
            out.append('<table><thead><tr>%s</tr></thead><tbody>%s</tbody>'
                       '</table>' % (head, ''.join(rows)))
            continue

        para.append(s)
        i += 1

    flush()
    return '\n'.join(out)


CSS = """
:root{--fg:#24292f;--bg:#fff;--soft:#57606a;--line:#d0d7de;--code:#f6f8fa}
*{box-sizing:border-box}
body{max-width:820px;margin:0 auto;padding:38px 22px 80px;font:15px/1.75
 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
 color:var(--fg);background:var(--bg)}
h1,h2,h3,h4,h5,h6{margin:22px 0 12px;line-height:1.3;font-weight:650}
h1{font-size:27px;border-bottom:1px solid var(--line);padding-bottom:8px}
h2{font-size:21px;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{font-size:17px}
p{margin:11px 0}
ul,ol{margin:11px 0;padding-left:26px}
li{margin:4px 0}
ul.task{list-style:none;padding-left:4px}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--code);padding:2px 6px;border-radius:5px;font-size:13px;
 font-family:ui-monospace,Menlo,Consolas,monospace}
pre{background:var(--code);padding:14px 16px;border-radius:9px;overflow:auto;
 border:1px solid var(--line)}
pre code{background:none;padding:0;font-size:13px;line-height:1.6}
blockquote{margin:14px 0;padding:6px 16px;border-left:3px solid var(--line);
 color:var(--soft)}
table{border-collapse:collapse;margin:14px 0;font-size:14px}
th,td{border:1px solid var(--line);padding:7px 12px}
th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
mark{background:#fff3a3;padding:1px 3px;border-radius:3px}
img{max-width:100%;border-radius:7px}
.math{font-family:"Cambria Math",Cambria,Georgia,serif}
.frac{display:inline-flex;flex-direction:column;vertical-align:middle;
 text-align:center;margin:0 3px;font-size:.9em}
.frac .num{border-bottom:1px solid currentColor;padding:0 4px}
.frac .den{padding:0 4px}
sup,sub{font-size:.75em}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;
 --soft:#8b949e;--line:#30363d;--code:#161b22}a{color:#58a6ff}}
"""


def page(body, title):
    return ('<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>%s</title><style>%s</style></head><body>%s</body></html>\n'
            % (esc(title), CSS, body))


def _run(ctx):
    path = ctx.param('input')
    if not path or not os.path.isfile(path):
        ctx.log('✗ 文件不存在：%r' % path)
        return {'ok': False, 'error': '文件不存在'}
    ctx.read_file(path)
    raw = ctx.read_file(path).decode('utf-8', 'replace')

    body = render(raw)
    title = ctx.param('title') or os.path.splitext(os.path.basename(path))[0]
    doc = page(body, title)
    ctx.log('渲染 %s → %d 字节 HTML' % (os.path.basename(path), len(doc)))

    out = ctx.param('output')
    res = {'ok': True, 'title': title, 'html': doc, 'bytes': len(doc)}
    if out:
        d = os.path.dirname(out)
        if d:
            os.makedirs(d, exist_ok=True)
        ctx.write_file(out, doc)
        res['saved'] = out
        ctx.log('已保存：%s' % out)
    ctx.progress(1.0, '完成')
    return res


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
