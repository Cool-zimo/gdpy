/* ==================================================================
   anim.js —— 第二轮动画打磨的行为层
   ------------------------------------------------------------------
   这里只做 CSS 做不到的三件事：
     1) 涟漪 —— 需要知道点击坐标，纯 CSS 拿不到
     2) 数字滚动 —— 需要逐帧改文本
     3) 滚动阴影 / 视图切换 —— 需要监听事件加 class

   ★ 三条硬规矩（都是踩过的）：
     a) 数字必须先写死真值再动画。曾经想过只写 data-count 让 JS 填充，
        一旦本文件加载失败仪表盘就是一片空白 —— 静态值兜底，动画只是锦上添花。
     b) 涟漪的 span 必须能自己消失。animationend 在节点被父容器
        整体替换（切视图）时不会触发，只靠它会漏一堆 span。
     c) 一切都要尊重 prefers-reduced-motion，不能只看 CSS 里关了动画
        就以为万事大吉 —— JS 这边不判断的话，数字还是会滚。
   ================================================================== */
(function (root) {
    'use strict';

    var REDUCED = !!(root.matchMedia &&
        root.matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* ---------- 1. 涟漪 ---------- */
    var RIPPLE_SEL = [
        '.btn-primary', '.btn-secondary', '.btn-text', '.btn-icon',
        '.nav-item', '.modal-close', '.menu-toggle'
    ].join(',');

    function spawnRipple(ev) {
        if (REDUCED) return;
        var t = ev.target;
        if (!t || !t.closest) return;
        var host = t.closest(RIPPLE_SEL);
        if (!host) return;

        // class 只加一次；重复加不会重置动画，因为动画在 span 上不在 host 上
        host.classList.add('gd-ripple-host');

        var r = host.getBoundingClientRect();
        var d = Math.max(r.width, r.height) * 2;
        var span = document.createElement('span');
        span.className = 'gd-ripple';
        span.style.width = d + 'px';
        span.style.height = d + 'px';
        span.style.left = ((ev.clientX - r.left) - d / 2) + 'px';
        span.style.top = ((ev.clientY - r.top) - d / 2) + 'px';

        var kill = function () { if (span.parentNode) span.parentNode.removeChild(span); };
        span.addEventListener('animationend', kill);
        // 兜底：父容器被整体替换时 animationend 不会来
        setTimeout(kill, 700);
        host.appendChild(span);
    }

    /* ---------- 2. 数字滚动 ---------- */
    function countUp(el) {
        var raw = el.getAttribute('data-count');
        var target = parseFloat(raw);
        if (!isFinite(target)) return;
        var suffix = el.getAttribute('data-suffix') || '';
        var dec = (String(raw).split('.')[1] || '').length;
        // ★ data-form="gb"：容量类数字以 MB 存储、按 >=1GB 才转 GB 显示。
        //   不处理的话动画会滚出 "1770.0 MB"，而静态渲染是 "1.7 GB" ——
        //   动画结束那一刻数字会突然变形，比不做动画还糟。
        var form = el.getAttribute('data-form');
        function fmt(v) {
            if (form === 'gb') {
                return v >= 1024 ? (v / 1024).toFixed(1) + ' GB'
                                 : Math.round(v) + ' MB';
            }
            return v.toFixed(dec) + suffix;
        }

        if (REDUCED) { el.textContent = fmt(target); return; }

        var dur = 620, t0 = 0;
        function step(ts) {
            if (!t0) t0 = ts;
            var p = Math.min((ts - t0) / dur, 1);
            var e = 1 - Math.pow(1 - p, 3);           // ease-out cubic
            el.textContent = fmt(target * e);
            if (p < 1) requestAnimationFrame(step);
        }
        // 从 0 起步之前先置 0，避免残留上一帧的真值造成"跳一下"
        el.textContent = fmt(0);
        requestAnimationFrame(step);
    }

    function scanDash(scope) {
        var nodes = (scope || document).querySelectorAll('.dash-num[data-count]');
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (n.getAttribute('data-counted')) continue;
            n.setAttribute('data-counted', '1');
            countUp(n);
        }
    }

    /* ---------- 3. 视图切换淡入 ---------- */
    function replayViewIn() {
        var area = document.querySelector('.file-area');
        if (!area || REDUCED) return;
        area.classList.remove('is-switching');
        void area.offsetWidth;          // 强制回流，否则同名动画不会重播
        area.classList.add('is-switching');
    }

    /* ---------- 4. 滚动时工具栏浮起 ---------- */
    function bindScrollShadow() {
        var area = document.querySelector('.file-area');
        var bar = document.querySelector('.toolbar');
        if (!area || !bar) return;
        var ticking = false;
        function upd() {
            bar.classList.toggle('is-scrolled', area.scrollTop > 4);
            ticking = false;
        }
        area.addEventListener('scroll', function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(upd);
        }, { passive: true });
    }

    /* ---------- 5. 骨架屏（给调用方用） ---------- */
    function skeleton(container, rows) {
        if (!container) return function () {};
        var html = '';
        for (var i = 0; i < (rows || 4); i++) {
            html += '<div class="gd-skel" style="height:14px;margin:10px 0;width:' +
                (100 - i * 9) + '%;"></div>';
        }
        container.innerHTML = html;
        return function clear() { container.innerHTML = ''; };
    }

    /* ---------- 挂载 ---------- */
    function init() {
        document.addEventListener('pointerdown', spawnRipple, true);
        bindScrollShadow();

        var fl = document.getElementById('file-list');
        if (fl && root.MutationObserver) {
            /* ★ 为什么必须 subtree:true
               仪表盘里"还能写入多少"那块是异步填进 #dash-repo-box 的，
               而 #dash-repo-box 是 #file-list 的孙节点。只观察 childList
               的话这次变更根本收不到 —— 那个数字就永远不会被滚动。
               但 subtree 会带来副作用：每插入一个文件格子都会回调一次。
               所以只有「变动直接发生在 #file-list 上」才重播视图淡入，
               否则加载上百个文件时整块区域会一直闪。 */
            new root.MutationObserver(function (muts) {
                var direct = false;
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].target === fl) { direct = true; break; }
                }
                scanDash(fl);
                if (direct && !fl.classList.contains('dashboard-view')) {
                    replayViewIn();
                }
            }).observe(fl, { childList: true, subtree: true });
        }
        // 首屏可能已经是仪表盘（刷新恢复视图）
        scanDash(document);
    }

    root.GdAnim = { skeleton: skeleton, scanDash: scanDash, replayViewIn: replayViewIn };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : this);
