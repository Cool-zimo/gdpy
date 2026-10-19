/* ==================================================================
   custom.js —— 界面自定义
   ------------------------------------------------------------------
   用户原话："多加点自定义…右键侧边栏出管理菜单，可以勾选显示什么东西…
             右键上侧的栏也可以勾选显示什么…字体大小行距字距主题。"

   覆盖范围：
     · 侧边栏条目：显隐 / 排序 / 宽度
     · 顶栏按钮：显隐
     · 外观：主题 / 字号 / 行距 / 字距

   ★ 四个踩过的决定，写在这里免得以后又被改回去：

   1) 隐藏用 hidden 属性，绝不删节点。
      删节点后"上移/下移"的索引会错位 —— 第 3 项其实跑到了第 5 位，
      而且恢复显示时找不到该插回哪里。保留节点只隐藏，顺序永远对得上。

   2) 字号只作用于内容容器，不动 html 的 font-size。
      整站用的是 rem。改 html 字号会让侧边栏宽度、按钮内边距一起放大，
      20px 时布局直接变形。现在给 html 固定基准，用户设置只走 CSS 变量。

   3) 配置带版本号 KEY_V。
      以后结构变了能直接丢弃旧数据，而不是拿老配置去套新结构导致界面错乱。

   4) 右键菜单独立实现，不复用文件的右键菜单。
      文件菜单里是"打开/重命名/删除"，套在侧边栏上会点一个删一个。
   ================================================================== */
(function (root) {
    'use strict';

    var KEY = 'gd_ui_custom';
    var KEY_V = 1;

    /* 侧边栏条目：data-view → 显示名。顺序即默认顺序。 */
    var NAV_DEF = [
        ['dashboard', '仪表盘'],
        ['all-files', '全部文件'],
        ['recent', '最近使用'],
        ['starred', '收藏'],
        ['trash', '回收站'],
        ['shared', '我的分享'],
        ['explore', '发现分享'],
        ['tasks', '后台进程'],
        ['plugins', '插件广场']
    ];

    /* 顶栏按钮：DOM 里的定位选择器 → 显示名 */
    var BAR_DEF = [
        ['.search-box', '搜索框'],
        ['#adv-search-btn', '高级筛选'],
        ['#folder-tree-btn', '文件夹导航'],
        ['#new-folder-btn', '新建文件夹'],
        ['#upload-btn', '上传'],
        ['#view-toggle-btn', '视图切换']
    ];

    function def() {
        // 插件广场默认隐藏：用户明确说过移动端用不上，桌面端也少用
        var hidden = { plugins: true };
        return {
            v: KEY_V,
            navHidden: hidden,
            navOrder: NAV_DEF.map(function (n) { return n[0]; }),
            barHidden: {},
            width: 260,
            theme: 'light',       // light / dark / auto
            fontSize: 14,
            lineHeight: 1.5,
            letterSpacing: 0
        };
    }

    var cfg = def();

    function load() {
        try {
            var raw = localStorage.getItem(KEY);
            if (!raw) return;
            var o = JSON.parse(raw);
            // 版本不同就整个丢弃，避免老结构套新代码
            if (!o || o.v !== KEY_V) return;
            cfg = Object.assign(def(), o);
        } catch (e) { /* 读不到就用默认，不能让界面开不了 */ }
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
    }

    /* ---------- 应用：侧边栏 ---------- */
    function applyNav() {
        var all = document.querySelectorAll('.sidebar .nav-item[data-view]');
        if (!all.length) return;

        // 按 navOrder 排；配置里没有的（新增项）追加到末尾
        var order = cfg.navOrder.slice();
        NAV_DEF.forEach(function (n) {
            if (order.indexOf(n[0]) < 0) order.push(n[0]);
        });
        function rank(v) {
            var i = order.indexOf(v);
            return i < 0 ? 999 : i;
        }

        /* ★ 只在各自分组容器内重排，绝不跨容器搬。
           侧边栏分了多组（"任务"就是独立的 nav-section），
           如果统一 append 到第一个容器，后台进程和插件广场会被搬进第一组，
           分组标题就对不上内容了。 */
        var groups = document.querySelectorAll('.sidebar .nav-section, .sidebar nav');
        var seen = [];
        for (var g = 0; g < groups.length; g++) {
            var items = groups[g].querySelectorAll(':scope > .nav-item[data-view]');
            if (!items.length) continue;
            var arr = [];
            for (var i = 0; i < items.length; i++) {
                arr.push(items[i]);
                seen.push(items[i]);
            }
            arr.sort(function (a, b) {
                return rank(a.getAttribute('data-view')) - rank(b.getAttribute('data-view'));
            });
            for (var j = 0; j < arr.length; j++) {
                groups[g].appendChild(arr[j]);   // 同容器内移动 = 就地重排
            }
        }
        // 不在任何分组里的（兜底）
        if (!seen.length) {
            for (var k = 0; k < all.length; k++) seen.push(all[k]);
        }

        for (var m = 0; m < all.length; m++) {
            var v = all[m].getAttribute('data-view');
            all[m].hidden = !!cfg.navHidden[v];
        }

        var sb = document.querySelector('.sidebar');
        if (sb) sb.style.width = cfg.width + 'px';
    }

    /* ---------- 应用：顶栏 ---------- */
    function applyBar() {
        BAR_DEF.forEach(function (b) {
            var el = document.querySelector('.toolbar ' + b[0]);
            if (!el) return;
            el.hidden = !!cfg.barHidden[b[0]];
        });
        // ★ 改完用户勾选后必须让 ui 重新按视图校正一次。
        //   否则在非文件视图下把「视图切换」勾上，它会立刻冒出来 ——
        //   用户勾的是"我要它显示"，不是"无视当前视图强行显示"。
        try {
            var ui = root.ui;
            if (ui && ui._syncToolbarForView && ui.app && ui.app._currentView) {
                ui._syncToolbarForView(ui.app._currentView);
            }
        } catch (e) { /* ui 还没起来就算了 */ }
    }

    /* ---------- 应用：外观 ---------- */
    function applyLook() {
        var d = document.documentElement;
        d.setAttribute('data-theme', cfg.theme);

        // ★ 只写变量，不改 html 的 font-size（见文件头第 2 条）
        var s = d.style;
        s.setProperty('--gd-fs', cfg.fontSize + 'px');
        s.setProperty('--gd-lh', String(cfg.lineHeight));
        s.setProperty('--gd-ls', cfg.letterSpacing + 'px');
    }

    function applyAll() { applyNav(); applyBar(); applyLook(); }

    /* ---------- 菜单：通用轻量右键菜单 ---------- */
    function menu(x, y, items) {
        closeMenu();
        var m = document.createElement('div');
        m.className = 'gd-ctx-menu';
        m.innerHTML = items.map(function (it, i) {
            if (it.hr) return '<div class="gd-ctx-hr"></div>';
            return '<div class="gd-ctx-row" data-i="' + i + '">' +
                   '<span class="gd-ctx-chk">' + (it.check === undefined ? '' : (it.check ? '✓' : '')) + '</span>' +
                   '<span class="gd-ctx-label">' + it.label + '</span></div>';
        }).join('');
        document.body.appendChild(m);

        // 先量尺寸再定位，避免贴边溢出
        var w = m.offsetWidth, h = m.offsetHeight;
        m.style.left = Math.min(x, innerWidth - w - 8) + 'px';
        m.style.top = Math.min(y, innerHeight - h - 8) + 'px';

        m.addEventListener('click', function (e) {
            var row = e.target.closest('.gd-ctx-row');
            if (!row) return;
            var it = items[+row.getAttribute('data-i')];
            if (it && it.run) it.run();
            if (!it || !it.keep) closeMenu();
        });
        // 菜单内的滑块要能拖，不能一拖就当点击
        m.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        setTimeout(function () {
            document.addEventListener('pointerdown', onOut, true);
        }, 0);
        function onOut(e) {
            if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', onOut, true); }
        }
        return m;
    }

    function closeMenu() {
        var old = document.querySelectorAll('.gd-ctx-menu');
        for (var i = 0; i < old.length; i++) old[i].remove();
    }

    /* ---------- 侧边栏右键 ---------- */
    function sidebarMenu(x, y) {
        var items = [];
        NAV_DEF.forEach(function (n) {
            var v = n[0];
            items.push({
                label: n[1],
                check: !cfg.navHidden[v],
                keep: true,
                run: function () {
                    cfg.navHidden[v] = !cfg.navHidden[v];
                    save(); applyNav(); closeMenu();
                }
            });
        });
        items.push({ hr: true });

        // 排序：只对"当前可见项"有意义，隐藏的项排了也看不见
        var vis = NAV_DEF.map(function (n) { return n[0]; })
            .filter(function (v) { return !cfg.navHidden[v]; });
        items.push({
            label: '↑↓ 调整顺序（点条目后选）',
            keep: true,
            run: function () { orderMenu(x, y, vis); }
        });

        items.push({
            label: '↔ 宽度 ' + cfg.width + 'px（可直接拖右边缘）',
            keep: true,
            run: function () { widthMenu(x, y); }
        });
        items.push({ hr: true });
        items.push({
            label: '⚙ 综合设置', run: function () {
                if (root.ui && root.ui.showSettings) root.ui.showSettings();
            }
        });
        items.push({
            label: '↺ 恢复默认', run: function () {
                cfg = def(); save(); applyAll();
            }
        });
        menu(x, y, items);
    }

    function orderMenu(x, y, vis) {
        var items = [];
        vis.forEach(function (v, i) {
            var name = (NAV_DEF.filter(function (n) { return n[0] === v; })[0] || [v, v])[1];
            items.push({
                label: name,
                keep: true,
                run: function () { pickOrder(x, y, v, name); }
            });
        });
        menu(x, y, items);
    }

    function pickOrder(x, y, v, name) {
        var cur = cfg.navOrder.indexOf(v);
        menu(x, y, [
            { label: '↑ 上移「' + name + '」', run: function () {
                if (cur <= 0) return;
                cfg.navOrder[cur] = cfg.navOrder[cur - 1];
                cfg.navOrder[cur - 1] = v;
                save(); applyNav();
            } },
            { label: '↓ 下移「' + name + '」', run: function () {
                if (cur < 0 || cur >= cfg.navOrder.length - 1) return;
                cfg.navOrder[cur] = cfg.navOrder[cur + 1];
                cfg.navOrder[cur + 1] = v;
                save(); applyNav();
            } }
        ]);
    }

    function widthMenu(x, y) {
        var m = menu(x, y, [{ label: '拖动调整宽度', keep: true, run: function () {} }]);
        var wrap = document.createElement('div');
        wrap.className = 'gd-ctx-slider';
        var r = document.createElement('input');
        r.type = 'range'; r.min = '200'; r.max = '420'; r.step = '4';
        r.value = String(cfg.width);
        var lab = document.createElement('span');
        lab.textContent = cfg.width + 'px';
        r.addEventListener('input', function () {
            cfg.width = +r.value;
            lab.textContent = cfg.width + 'px';
            var sb = document.querySelector('.sidebar');
            if (sb) sb.style.width = cfg.width + 'px';   // 实时预览
        });
        r.addEventListener('change', function () { save(); });
        wrap.appendChild(r); wrap.appendChild(lab);
        m.appendChild(wrap);
    }

    /* ---------------------------------------------------------------
       直接拖侧边栏右边缘改宽度
       ---------------------------------------------------------------
       用户原话："调宽度难道不是直接拖动吗，为啥要输数字。"
       之前只能右键 → 点「宽度」→ 弹滑块，三步才能改一个数。
       现在右边缘常驻一条 8px 热区，按住就拖，双击复位。

       ★ 为什么用「起点 + 总位移」而不是「当前值 + 增量」：
         pointermove 的触发频率不固定，累加增量会随事件密度漂移，
         拖久了实际宽度和手的位置对不上。记起点则永远精确。
       --------------------------------------------------------------- */
    var MIN_W = 200, MAX_W = 420, DEF_W = 260;

    function installResizer() {
        var sb = document.querySelector('.sidebar');
        if (!sb) return;
        if (sb.querySelector('.gd-sb-resizer')) return;

        var bar = document.createElement('div');
        bar.className = 'gd-sb-resizer';
        bar.title = '拖动调整宽度（双击复位）';

        var startX = 0, startW = 0, dragging = false;

        function clamp(v) {
            return Math.max(MIN_W, Math.min(MAX_W, Math.round(v / 4) * 4));
        }
        function setW(w) {
            cfg.width = w;
            sb.style.width = w + 'px';
            try { document.documentElement.style.setProperty('--sidebar-width', w + 'px'); } catch (e) {}
        }

        bar.addEventListener('pointerdown', function (e) {
            if (e.button != null && e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startW = sb.getBoundingClientRect().width;
            bar.classList.add('is-dragging');
            try { bar.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
            e.stopPropagation();
        });
        bar.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            setW(clamp(startW + (e.clientX - startX)));
        });
        function endDrag() {
            if (!dragging) return;
            dragging = false;
            bar.classList.remove('is-dragging');
            save();
        }
        bar.addEventListener('pointerup', endDrag);
        bar.addEventListener('pointercancel', endDrag);
        bar.addEventListener('lostpointercapture', endDrag);
        bar.addEventListener('dblclick', function () { setW(DEF_W); save(); });

        sb.appendChild(bar);
    }

    /* ---------- 顶栏右键 ---------- */
    function barMenu(x, y) {
        var items = BAR_DEF.map(function (b) {
            return {
                label: b[1],
                check: !cfg.barHidden[b[0]],
                keep: true,
                run: function () {
                    cfg.barHidden[b[0]] = !cfg.barHidden[b[0]];
                    save(); applyBar(); closeMenu();
                }
            };
        });
        menu(x, y, items);
    }

    /* ---------- 设置面板里的外观控件 ---------- */
    function lookSectionHtml() {
        return '' +
            '<div class="gd-look">' +
            '<label>主题 <select id="gd-look-theme">' +
            '<option value="light">浅色</option>' +
            '<option value="dark">深色</option>' +
            '<option value="auto">跟随系统</option>' +
            '</select></label>' +
            '<label>字号 <input type="range" id="gd-look-fs" min="12" max="20" step="1"><span id="gd-look-fs-v"></span></label>' +
            '<label>行距 <input type="range" id="gd-look-lh" min="1.2" max="2.2" step="0.1"><span id="gd-look-lh-v"></span></label>' +
            '<label>字距 <input type="range" id="gd-look-ls" min="-0.5" max="2" step="0.1"><span id="gd-look-ls-v"></span></label>' +
            '</div>';
    }

    function bindLook(scope) {
        var th = scope.querySelector('#gd-look-theme');
        var fs = scope.querySelector('#gd-look-fs');
        var lh = scope.querySelector('#gd-look-lh');
        var ls = scope.querySelector('#gd-look-ls');
        if (!th) return;
        th.value = cfg.theme; fs.value = cfg.fontSize;
        lh.value = cfg.lineHeight; ls.value = cfg.letterSpacing;
        var fsv = scope.querySelector('#gd-look-fs-v');
        var lhv = scope.querySelector('#gd-look-lh-v');
        var lsv = scope.querySelector('#gd-look-ls-v');
        if (fsv) fsv.textContent = cfg.fontSize + 'px';
        if (lhv) lhv.textContent = cfg.lineHeight;
        if (lsv) lsv.textContent = cfg.letterSpacing + 'px';

        th.onchange = function () { cfg.theme = th.value; save(); applyLook(); };
        fs.oninput = function () { cfg.fontSize = +fs.value; if (fsv) fsv.textContent = cfg.fontSize + 'px'; applyLook(); };
        fs.onchange = save;
        lh.oninput = function () { cfg.lineHeight = +lh.value; if (lhv) lhv.textContent = cfg.lineHeight; applyLook(); };
        lh.onchange = save;
        ls.oninput = function () { cfg.letterSpacing = +ls.value; if (lsv) lsv.textContent = cfg.letterSpacing + 'px'; applyLook(); };
        ls.onchange = save;
    }

    /* ---------- 挂载 ---------- */
    function init() {
        var had = !!localStorage.getItem(KEY);
        load();
        applyAll();
        if (!had) save();   // 首次进入把默认配置落地，后续改动才有基线

        var sb = document.querySelector('.sidebar');
        if (sb) {
            installResizer();
            sb.addEventListener('contextmenu', function (e) {
                e.preventDefault(); sidebarMenu(e.clientX, e.clientY);
            });
        }
        var bar = document.querySelector('.toolbar');
        if (bar) {
            bar.addEventListener('contextmenu', function (e) {
                // 工具栏上的输入框里右键应该是系统的粘贴菜单
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
                e.preventDefault(); barMenu(e.clientX, e.clientY);
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeMenu();
        });
    }

    root.GdCustom = {
        init: init, applyAll: applyAll,
        lookSectionHtml: lookSectionHtml, bindLook: bindLook,
        get: function () { return cfg; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : this);
