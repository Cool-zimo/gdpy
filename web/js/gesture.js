/* ==================================================================
   gesture.js —— 移动端「边缘右滑唤起抽屉」
   ------------------------------------------------------------------
   用户原话："我建议手机端直接右滑唤起侧边栏，而不是点按钮。"

   ★ 三条必须遵守的约束（每一条都是用户体验的分水岭）：

   1) 必须从屏幕左边缘起步。
      整个内容区都允许右滑的话，横向滚动的表格、文件列表的左右滑动
      会跟手势打架。只有 startX <= EDGE 才算候选。

   2) 纵向优先。
      手指下滑时往往同时带一点横向位移，如果只看 dx 就会把滚动
      误判成打开抽屉 —— 页面会滑不动。所以一旦 |dy| > |dx| 就永久放弃本次。

   3) 一旦判定为横向，才拦截默认行为。
      touchstart 阶段绝不能 preventDefault，否则整页滚不动。
      只有在 move 阶段确认是横向手势后才拦截（且必须 passive:false）。

   ⚠️ iOS Safari 的限制（必须如实告知）：
      从屏幕最左边缘右滑是系统的「返回上一页」手势，
      这个手势由浏览器接管，网页无法用 preventDefault 取消。
      所以 EDGE 取 28px：既避开了系统手势最敏感的那几像素，
      又保证手指能自然落在可触发区。若用户在 iOS 上仍偶发返回，
      说明该页面有历史记录 —— 这是浏览器行为，不是代码问题。
   ================================================================== */
(function (root) {
    'use strict';

    var EDGE = 28;        // 左边缘触发区宽度(px)
    var LOCK = 10;        // 判定方向所需的最小位移(px)
    var OPEN_DIST = 55;   // 判定"打开"的最小位移(px)
    var OPEN_VEL = 0.32;  // 或达到这个速度(px/ms)也算打开（快速轻扫）
    var MIN_DIST = 24;    // ★ 速度达标的兜底门槛：再快也要真的划过这么远

    /* 为什么必须要有 MIN_DIST：
       只看速度的话，手指在边缘抖 10px（用时 8ms，速度 1.25px/ms）
       就会被判成"快速轻扫"而弹出抽屉 —— 用户只是想滚页面。
       所以速度只用于放宽距离要求，不能取代距离要求。 */

    function isMobile() {
        return root.matchMedia && root.matchMedia('(max-width: 768px)').matches;
    }

    function init() {
        var sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;

        var startX = 0, startY = 0, startT = 0;
        var tracking = false;   // 已进入"可能是横向手势"的观察状态
        var dragging = false;   // 已确认是横向手势，正在跟手
        var dead = false;       // 已判定为纵向/无效，本次不再处理
        var baseOpen = false;   // 手势开始时抽屉是否已开

        function width() {
            var r = sidebar.getBoundingClientRect();
            return r.width || 270;
        }

        /* 抽屉跟手：动画期间必须关掉 transition，否则会跟手指打延迟 */
        function setDrag(on) {
            sidebar.classList.toggle('gd-dragging', on);
            // 遮罩也要同步，否则拖动期间它仍有 260ms 过渡，会慢半拍
            var ov = document.getElementById('sidebar-overlay');
            if (ov) ov.classList.toggle('gd-dragging', on);
        }

        function offset(px) {
            // px: 0 = 完全收起(translateX(-100%))，w = 完全展开
            var w = width();
            var p = Math.max(0, Math.min(1, px / w));
            sidebar.style.transform = 'translateX(' + ((p - 1) * 100) + '%)';
            return p;
        }

        function clearOffset() {
            sidebar.style.transform = '';
        }

        function onStart(e) {
            if (!isMobile()) return;
            if (e.touches.length !== 1) { dead = true; return; }
            var t = e.touches[0];
            baseOpen = sidebar.classList.contains('open');

            // 已开：手势起点必须在抽屉上（左滑关闭）
            // 未开：手势起点必须在屏幕左边缘（右滑打开）
            if (baseOpen) {
                if (t.clientX > width() + 20) { dead = true; return; }
            } else {
                if (t.clientX > EDGE) { dead = true; return; }
            }

            startX = t.clientX; startY = t.clientY;
            startT = Date.now();
            tracking = true; dragging = false; dead = false;
            // ★ 这里绝对不能 preventDefault，否则页面滚不动
        }

        function onMove(e) {
            if (dead || !tracking) return;
            var t = e.touches[0];
            var dx = t.clientX - startX;
            var dy = t.clientY - startY;

            if (!dragging) {
                // 方向未定：位移太小就再等等
                if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
                // 纵向占优 → 永久放弃本次（让页面正常滚动）
                if (Math.abs(dy) > Math.abs(dx)) { dead = true; tracking = false; return; }
                dragging = true;
                setDrag(true);
                // 已确认横向，从这一帧起才拦截
                if (e.cancelable) e.preventDefault();
            }

            if (e.cancelable) e.preventDefault();

            // 未开：向右拖 → 从 -100% 逐渐露出来；向左拖无意义，夹到 0
            // 已开：向左拖 → 逐渐收回去
            var cur = baseOpen ? width() + dx : dx;
            var p = offset(cur);

            // 遮罩透明度跟手，视觉上更连贯
            var ov = document.getElementById('sidebar-overlay');
            if (ov) {
                ov.style.opacity = String(p);
                ov.style.visibility = p > 0.01 ? 'visible' : 'hidden';
            }
        }

        function onEnd(e) {
            if (dead || !tracking) { reset(); return; }
            var t = e.changedTouches && e.changedTouches[0];
            var dx = t ? t.clientX - startX : 0;
            var dt = Math.max(1, Date.now() - startT);
            var vel = Math.abs(dx) / dt;
            var far = Math.abs(dx) >= OPEN_DIST;

            var quick = (far || vel > OPEN_VEL) && Math.abs(dx) >= MIN_DIST;
            var shouldOpen;
            if (baseOpen) shouldOpen = !(dx < 0 && quick);
            else shouldOpen = (dx > 0 && quick);

            setDrag(false);
            clearOffset();
            var ov = document.getElementById('sidebar-overlay');
            if (ov) { ov.style.opacity = ''; ov.style.visibility = ''; }

            // 走 ui 的开关，保证遮罩绑定、class 状态、后续逻辑一致
            if (root.ui && root.ui.toggleMobileMenu) {
                if (shouldOpen !== baseOpen) root.ui.toggleMobileMenu(shouldOpen);
                else root.ui.toggleMobileMenu(baseOpen);
            } else {
                sidebar.classList.toggle('open', shouldOpen);
                if (ov) ov.classList.toggle('active', shouldOpen);
            }
            reset();
        }

        function reset() {
            tracking = false; dragging = false; dead = false;
            setDrag(false);
        }

        // passive:false 是必须的 —— 否则 preventDefault 无效
        document.addEventListener('touchstart', onStart, { passive: true });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd, { passive: true });
        document.addEventListener('touchcancel', function () {
            if (dragging) {
                setDrag(false); clearOffset();
                var ov = document.getElementById('sidebar-overlay');
                if (ov) { ov.style.opacity = ''; ov.style.visibility = ''; }
            }
            reset();
        }, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : this);
