/* ==================================================================
   theme.js —— 暗色模式增强
   ------------------------------------------------------------------
   解决三件事：

   1) 一处白一处黑
      CSS 里散落 23 处硬编码 background:#fff，逐条补不完。
      这里在运行时再扫一遍：凡是计算出"接近白"的底色，直接压成暗色。
      CSS 那条兜底管选择器，这条管内联 —— 两层互补。

   2) 对比度不足（"仪表盘"/"设置"字样看不清）
      根因是标题写了内联 color:#111827。
      内联样式优先级高于 CSS 类，body.dark-mode 的规则改不动它。
      这里给它们打上 data-gd-force，交给 CSS 的 !important 规则处理。

   3) 反复渲染的视图要能持续生效
      仪表盘/设置是每次进入重新渲染 innerHTML 的，
      只在切换主题时处理一次不够 —— 用 MutationObserver 持续兜底。

   ★ 一条重要原则：只改"看起来像界面元素"的，绝不碰用户内容。
     代码块、日志、图片、文件名一律跳过 —— 改了就是破坏信息。
   ================================================================== */
(function (root) {
    'use strict';

    var DARK_CLASS = 'dark-mode';

    function isDark() {
        return document.body.classList.contains(DARK_CLASS);
    }

    /* 判断一个颜色是否"接近白" */
    function isLight(c) {
        if (!c) return false;
        var m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) {
            // 十六进制
            var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
            if (!h) return false;
            var s = h[1];
            if (s.length === 3) s = s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
            var r = parseInt(s.slice(0,2),16), g = parseInt(s.slice(2,4),16), b = parseInt(s.slice(4,6),16);
            return (r + g + b) / 3 > 235;
        }
        var p = m[1].split(',').map(Number);
        if (p.length > 3 && p[3] === 0) return false;   // 全透明不算白
        return (p[0] + p[1] + p[2]) / 3 > 235;
    }

    /* 这些标签/类里的内容是用户数据，绝不能改色 */
    function isProtected(el) {
        if (!el || el.nodeType !== 1) return false;
        var t = el.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'CODE' || t === 'PRE' ||
            t === 'IMG' || t === 'SVG' || t === 'CANVAS' || t === 'VIDEO') return true;
        if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return false; // 输入框要处理
        var c = el.className;
        if (typeof c === 'string' &&
            /gd-code|terminal|log-box|bm-logs|file-preview|markdown-body|hljs/.test(c)) return true;
        return false;
    }

    /* ---- WCAG 对比度兜底 ----
       用户反馈过两轮"暗色下文字看不清"。前两轮都是靠"列举已知的硬编码颜色"
       去补规则 —— 补一批漏一批，因为硬编码散落在上百处 CSS 类里，
       而且以后新增组件还会继续漏。
       这里改成按**实际渲染出来的对比度**判定，不管颜色是内联写的、
       CSS 类写的还是 JS 生成的，只要不够亮就提亮。 */

    function parseRGB(c) {
        if (!c) return null;
        var m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        var p = m[1].split(',').map(Number);
        if (p.length < 3) return null;
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }

    function lum(c) {
        function f(v) {
            v = v / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }

    function contrast(fg, bg) {
        var l1 = lum(fg), l2 = lum(bg);
        var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
    }

    /* 向上找第一个不透明背景 —— 文字实际压在什么颜色上 */
    function effectiveBg(el) {
        var p = el, guard = 0;
        while (p && p.nodeType === 1 && guard++ < 12) {
            var cs;
            try { cs = root.getComputedStyle(p); } catch (e) { break; }
            if (cs) {
                var c = parseRGB(cs.backgroundColor);
                if (c && c.a >= 0.5) return c;
            }
            p = p.parentElement;
        }
        return { r: 13, g: 17, b: 23, a: 1 };   // 兜底按暗色底算
    }

    /* 只处理"自己带着文字"的元素。
       遍历全部元素会给每个节点都触发一次样式计算，上千节点时明显卡顿，
       而容器节点本身没有文字，改它的 color 也没意义。 */
    function hasDirectText(el) {
        var ns = el.childNodes;
        for (var i = 0; i < ns.length; i++) {
            if (ns[i].nodeType === 3 && ns[i].nodeValue.trim()) return true;
        }
        return false;
    }

    function fixContrast(el, cs) {
        if (el.disabled) return;                       // 禁用态本来就该弱化
        if (el.hasAttribute('data-gd-force')) return;  // 已有更强规则在管
        var op = parseFloat(cs.opacity);
        if (!isNaN(op) && op < 0.5) return;            // 刻意淡出的不动
        var fg = parseRGB(cs.color);
        if (!fg || fg.a < 0.05) return;
        var bg = effectiveBg(el);
        // ★ 彩色背景（按钮、标签、徽章）一律不碰。
        //   它们的配色是设计决定的，而对比度算法只会说"把字改暗"——
        //   那会把蓝底白字的按钮改成蓝底灰字，更难看。
        //   这类元素该改的是底色，已由 CSS 里的规则专门处理。
        var mx = Math.max(bg.r, bg.g, bg.b), mn = Math.min(bg.r, bg.g, bg.b);
        if (mx - mn > 40) return;
        if (contrast(fg, bg) >= 4.5) return;           // WCAG AA 正文标准
        // 原本越暗说明它越想当"主文字"，就提得越亮，保留层次
        el.style.setProperty('color',
            lum(fg) < 0.2 ? 'var(--text-primary)' : 'var(--text-secondary)',
            'important');
        el.setAttribute('data-gd-fixed', '1');
    }

    function fixElement(el) {
        if (!el || el.nodeType !== 1) return;
        if (isProtected(el)) return;
        var cs;
        try { cs = root.getComputedStyle(el); } catch (e) { return; }
        if (!cs) return;

        // 白底 → 暗底
        if (isLight(cs.backgroundColor)) {
            el.style.setProperty('background-color', 'var(--bg-secondary)', 'important');
        }
        // 深色文字 → 提亮（只看内联的，CSS 类里写的由样式表统一管）
        var inline = el.style.color;
        if (inline && /#111827|#1f2328|#111|#374151|rgb\(17, 24, 39\)/i.test(inline)) {
            el.setAttribute('data-gd-force', 'title');
        }
        // 对比度兜底：不看颜色是怎么来的，只看实际渲染够不够亮
        if (hasDirectText(el)) fixContrast(el, cs);
    }

    /* 给已知的内联硬编码标题打标记（这些是用户明确点名看不清的） */
    function markTitles() {
        var hs = document.querySelectorAll('h1,h2,h3,h4,.settings-view h2,#file-list h2');
        for (var i = 0; i < hs.length; i++) {
            var el = hs[i];
            var inline = el.style.color || '';
            // 只给"内联写了深色"的打标记 —— CSS 类控制的本来就正常
            if (inline && /#111827|#1f2328|#111|#374151/i.test(inline)) {
                el.setAttribute('data-gd-force', 'title');
            }
        }
        // 次要说明文字
        var subs = document.querySelectorAll('[style*="color:#6b7280"],[style*="color: #6b7280"],[style*="color:#9ca3af"],[style*="color: #9ca3af"]');
        for (var j = 0; j < subs.length; j++) {
            if (!subs[j].hasAttribute('data-gd-force')) {
                subs[j].setAttribute('data-gd-force',
                    /9ca3af/i.test(subs[j].getAttribute('style') || '') ? 'muted' : 'sub');
            }
        }
    }

    function sweep(root0) {
        if (!isDark()) return;
        var scope = root0 || document.body;
        if (!scope) return;
        markTitles();
        var all = scope.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) fixElement(all[i]);
    }

    var mo = null;
    function observe() {
        if (mo) return;
        if (!root.MutationObserver) return;
        mo = new root.MutationObserver(function (muts) {
            if (!isDark()) return;
            // 只在真的新增了节点时才扫，避免无谓开销
            var dirty = false;
            for (var i = 0; i < muts.length; i++) {
                if (muts[i].addedNodes && muts[i].addedNodes.length) { dirty = true; break; }
            }
            if (!dirty) return;
            clearTimeout(theme._t);
            theme._t = setTimeout(function () { sweep(); }, 60);
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    var theme = {
        apply: function () {
            sweep();
            observe();
        },
        sweep: sweep,
        isDark: isDark
    };

    root.GdTheme = theme;

    /* 跟随 ui.toggleDarkMode：它在切 class，我们跟着扫一遍 */
    var _orig = null;
    function hook() {
        if (root.ui && root.ui.toggleDarkMode && !root.ui.__gdThemeHooked) {
            _orig = root.ui.toggleDarkMode.bind(root.ui);
            root.ui.toggleDarkMode = function () {
                var r = _orig();
                setTimeout(function () { sweep(); }, 0);
                return r;
            };
            root.ui.__gdThemeHooked = true;
        }
    }

    function init() {
        hook();
        sweep();
        observe();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init();
            // ui.js 可能还没加载完，稍后再挂一次钩子
            setTimeout(function () { hook(); sweep(); }, 300);
        });
    } else {
        init();
        setTimeout(function () { hook(); sweep(); }, 300);
    }
})(typeof window !== 'undefined' ? window : this);
