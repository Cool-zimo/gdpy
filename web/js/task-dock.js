/**
 * 任务坞 —— 上传 / 下载 / 分享 的后台任务窗口
 *
 * 需求来源：传 98 个文件时，那个居中大弹窗把整个界面挡死了，
 * 想看看文件列表都不行。所以任务要能"挪开"——拖到边上变成小窗口贴着，
 * 主界面照常用。
 *
 * 规则：
 *   1. 大窗口标题栏可拖，拖到左右边缘松手 → 收成小窗口贴在那条边上
 *   2. 小窗口也能拖，拖到边上停靠，拖到中间就自由浮动
 *   3. 点小窗口 → 展开成大窗口（原地展开，不跳回屏幕中央）
 *   4. 多个任务可以各自占一个小窗口
 *   5. 小窗口超过 3 个 → 合并成一张「N 个任务处理中」，
 *      点开是全部任务的列表，再点某个任务看它的明细
 *
 * ★ 一个容易踩的点：容器是 pointer-events:none 的全屏覆盖层，
 *   每个窗口自己 pointer-events:auto。不这么做的话，
 *   坞会吃掉整个页面的点击，网盘就点不动了。
 */
const TaskDock = (() => {
    const MINI_LIMIT = 3;          // 超过这个数就合并
    const EDGE_SNAP = 90;          // 松手时距边缘多少 px 以内算"停靠"
    const POS_KEY = 'gd_taskdock_pos';

    const tasks = new Map();
    let seq = 0;
    let root = null;
    let openPanelId = null;        // 当前展开的任务 id
    let listPanelOpen = false;     // 合并列表面板是否打开
    let focusId = null;            // 列表面板里点开的某个任务
    let miniSuppressed = false;    // 打开"后台进程"面板时，小窗收进列表里

    function L(zh, en) {
        try {
            return (typeof I18n !== 'undefined' && String(I18n.current || '').indexOf('en') === 0) ? en : zh;
        } catch (e) { return zh; }
    }

    // ── 位置记忆 ──
    function loadPos() {
        try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch (e) { return {}; }
    }
    function savePos(p) {
        try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (e) {}
    }
    let pos = loadPos();

    // ── 容器 ──
    function ensureRoot() {
        if (root && document.body.contains(root)) return root;
        const old = document.getElementById('task-dock');
        if (old) old.remove();
        root = document.createElement('div');
        root.id = 'task-dock';
        document.body.appendChild(root);
        return root;
    }

    // ── 任务读写 ──
    function create(opts) {
        const id = 't' + (++seq);
        const t = {
            id,
            type: opts.type || 'upload',
            title: opts.title || '',
            items: (opts.items || []).map(n => ({ name: n, percent: 0, status: 'pending' })),
            percent: 0,
            note: opts.note || '',
            status: 'running',
            error: null,
            startedAt: Date.now(),
            finishedAt: 0,
            view: 'mini',
            dock: { edge: opts.edge || pos.edge || 'right', x: 0, y: 0, free: false },
            // 分享任务是单条进度，没有子项列表
            single: !!opts.single
        };
        tasks.set(id, t);
        // 默认展开：第一次总是让人看见细节，之后才收成小窗
        if (opts.expand !== false) { openPanelId = id; t.view = 'expanded'; }
        render();
        return id;
    }

    function get(id) { return tasks.get(id); }

    function updateItem(id, index, percent) {
        const t = tasks.get(id); if (!t) return;
        const it = t.items[index];
        if (!it) return;
        it.percent = Math.max(0, Math.min(100, Math.round(percent || 0)));
        it.status = it.percent >= 100 ? 'done' : 'active';
        recompute(t);
        render();
    }

    function setItemDone(id, index) {
        const t = tasks.get(id); if (!t) return;
        const it = t.items[index]; if (!it) return;
        it.percent = 100; it.status = 'done';
        recompute(t);
        render();
    }

    function setNote(id, msg) {
        const t = tasks.get(id); if (!t) return;
        t.note = msg || '';
        render();
    }

    function setPercent(id, percent, note) {
        const t = tasks.get(id); if (!t) return;
        let pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
        // ★ 只增不减：分享是多阶段流程，各阶段独立算百分比，
        //   阶段切换时若新阶段从较小值起步，进度条会往回缩看着像卡住。
        if (t.status === 'running' && pct < (t.percent || 0)) pct = t.percent;
        t.percent = pct;
        if (note !== undefined) t.note = note;
        render();
    }

    function recompute(t) {
        if (!t.items.length) return;
        const sum = t.items.reduce((s, i) => s + i.percent, 0);
        t.percent = Math.round(sum / t.items.length);
    }

    function finish(id, error) {
        const t = tasks.get(id); if (!t) return;
        t.status = error ? 'error' : 'done';
        t.error = error || null;
        t.percent = error ? t.percent : 100;
        t.finishedAt = Date.now();
        t.items.forEach(i => { if (!error) i.status = 'done'; });
        render();
        // 完成后自动收起：成功 2.5 秒、失败 8 秒（失败得多留一会儿让人看见）
        setTimeout(() => remove(id), error ? 8000 : 2500);
    }

    function remove(id) {
        tasks.delete(id);
        if (openPanelId === id) openPanelId = null;
        if (focusId === id) { focusId = null; listPanelOpen = true; }
        render();
    }

    // ── 拖拽 ──
    function startDrag(e, win, task) {
        if (e.button !== undefined && e.button !== 0) return;
        const rect = win.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        win.classList.add('td-dragging');
        document.body.classList.add('td-dragging-body');

        let hint = null;
        function move(ev) {
            const x = ev.clientX - dx, y = ev.clientY - dy;
            win.style.left = x + 'px';
            win.style.top = y + 'px';
            win.style.right = 'auto';
            win.style.bottom = 'auto';
            // 停靠提示
            const nearLeft = ev.clientX < EDGE_SNAP;
            const nearRight = ev.clientX > window.innerWidth - EDGE_SNAP;
            const want = nearLeft ? 'left' : (nearRight ? 'right' : null);
            if (!hint) {
                hint = document.createElement('div');
                hint.className = 'td-dock-hint';
                document.body.appendChild(hint);
            }
            if (want) {
                hint.textContent = L('松手停靠到' + (want === 'left' ? '左侧' : '右侧'),
                                     'Release to dock ' + (want === 'left' ? 'left' : 'right'));
                hint.classList.add('show');
                hint.style.left = (want === 'left' ? 12 : window.innerWidth - 12) + 'px';
                hint.style.transform = want === 'left' ? 'none' : 'translateX(-100%)';
            } else {
                hint.classList.remove('show');
            }
        }
        function up(ev) {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            win.classList.remove('td-dragging');
            document.body.classList.remove('td-dragging-body');
            if (hint) hint.remove();
            const nearLeft = ev.clientX < EDGE_SNAP;
            const nearRight = ev.clientX > window.innerWidth - EDGE_SNAP;
            if (nearLeft || nearRight) {
                const edge = nearLeft ? 'left' : 'right';
                task.dock.edge = edge;
                task.dock.free = false;
                pos.edge = edge;
                savePos(pos);
                // ★ 拖到边缘 = 收成小窗：这是"把大窗口拖到一侧"的核心行为
                if (task.view === 'expanded') { task.view = 'mini'; openPanelId = null; }
            } else {
                const r = win.getBoundingClientRect();
                task.dock.free = true;
                task.dock.x = Math.round(r.left);
                task.dock.y = Math.round(r.top);
            }
            render();
        }
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        e.preventDefault();
    }

    /**
     * 小窗口拖拽。
     *
     * ★ 必须先超过 5px 才开始动：小窗的主要交互是"点一下展开"，
     *   如果一按下去就跟着鼠标走，单击会被误判成拖动，永远展开不了。
     */
    function startMiniDrag(e, el, task) {
        if (e.button !== undefined && e.button !== 0) return;
        const rect = el.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        const sx = e.clientX, sy = e.clientY;
        let active = false, hint = null;

        function move(ev) {
            if (!active) {
                if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
                active = true;
                el.classList.add('td-dragging', 'td-no-click');
                document.body.classList.add('td-dragging-body');
            }
            el.style.left = (ev.clientX - dx) + 'px';
            el.style.top = (ev.clientY - dy) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            const nearLeft = ev.clientX < EDGE_SNAP;
            const nearRight = ev.clientX > window.innerWidth - EDGE_SNAP;
            if (!hint) { hint = document.createElement('div'); hint.className = 'td-dock-hint'; document.body.appendChild(hint); }
            if (nearLeft || nearRight) {
                const w = nearLeft ? 'left' : 'right';
                hint.textContent = L('松手停靠到' + (w === 'left' ? '左侧' : '右侧'),
                                     'Release to dock ' + (w === 'left' ? 'left' : 'right'));
                hint.classList.add('show');
                hint.style.left = (w === 'left' ? 12 : window.innerWidth - 12) + 'px';
                hint.style.transform = w === 'left' ? 'none' : 'translateX(-100%)';
            } else hint.classList.remove('show');
        }

        function up(ev) {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            el.classList.remove('td-dragging');
            document.body.classList.remove('td-dragging-body');
            if (hint) hint.remove();
            if (!active) return;                       // 没动 → 交给 click 展开
            const nearLeft = ev.clientX < EDGE_SNAP;
            const nearRight = ev.clientX > window.innerWidth - EDGE_SNAP;
            if (nearLeft || nearRight) {
                task.dock.edge = nearLeft ? 'left' : 'right';
                task.dock.free = false;
                pos.edge = task.dock.edge;
                savePos(pos);
            } else {
                const r = el.getBoundingClientRect();
                task.dock.free = true;
                task.dock.x = Math.round(r.left);
                task.dock.y = Math.round(r.top);
            }
            render();
            setTimeout(() => el.classList.remove('td-no-click'), 0);
        }

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        e.preventDefault();
    }

    // ── 图标 ──
    function iconOf(type) {
        return { upload: '📤', download: '⬇️', share: '🔗' }[type] || '📋';
    }

    /** 移动端？移动端不显示小窗（屏幕小、挡内容、且难拖动），
     *  任务只在「后台进程」面板里查看。 */
    function isMobile() {
        try { return window.matchMedia && window.matchMedia('(max-width: 768px)').matches; }
        catch (e) { return false; }
    }

    /** 通知界面更新角标（后台进程入口上的数字） */
    function notifyChange() {
        try { window.dispatchEvent(new CustomEvent('gd:tasks-changed', {
            detail: { count: tasks.size,
                      running: Array.from(tasks.values()).filter(t => t.status === 'running').length }
        })); } catch (e) {}
    }

    // ── 渲染 ──
    function render() {
        const list = Array.from(tasks.values());
        const el = ensureRoot();

        // ★ 移动端：小窗一律不渲染。但"展开的面板"仍然要渲染
        //   （用户主动点开的详情不能消失），只是不自动收成小窗。
        if (isMobile()) {
            if (!list.length) { el.innerHTML = ''; el.style.display = 'none'; notifyChange(); return; }
            el.style.display = '';
            let mhtml = '';
            for (const t of list) {
                if (t.id === openPanelId && t.view === 'expanded') mhtml += panelHTML(t);
            }
            if (listPanelOpen) mhtml += listPanelHTML(list);
            if (focusId && !openPanelId) {
                const ft = tasks.get(focusId);
                if (ft) mhtml += panelHTML(ft, true);
            }
            el.innerHTML = mhtml;
            bindAll();
            notifyChange();
            return;
        }

        if (!list.length) { el.innerHTML = ''; el.style.display = 'none'; notifyChange(); return; }
        el.style.display = '';

        // ★ 打开"后台进程"面板时小窗不再单独显示 ——
        //   它们已经在列表里了，屏幕边缘再留一排就是重复信息。
        if (miniSuppressed) {
            let sh = '';
            for (const t of list) {
                if (t.id === openPanelId && t.view === 'expanded') sh += panelHTML(t);
            }
            if (listPanelOpen) sh += listPanelHTML(list);
            if (focusId && !openPanelId) {
                const ft = tasks.get(focusId);
                if (ft) sh += panelHTML(ft, true);
            }
            el.innerHTML = sh;
            bindAll();
            notifyChange();
            return;
        }

        const live = list.filter(t => t.status === 'running');
        const merged = live.length > MINI_LIMIT;

        let html = '';

        if (merged) {
            // 合并成一张卡
            const done = list.filter(t => t.status === 'done').length;
            const err = list.filter(t => t.status === 'error').length;
            const avg = Math.round(live.reduce((s, t) => s + t.percent, 0) / (live.length || 1));
            const dockEdge = pos.edge || 'right';
            html += miniCardHTML({
                cls: 'td-merged',
                icon: '⚙️',
                title: L(`${live.length} 个任务处理中`, `${live.length} tasks running`),
                sub: (done || err) ? L(`已完成 ${done}${err ? ` · 失败 ${err}` : ''}`,
                                       `${done} done${err ? ` · ${err} failed` : ''}`) : '',
                percent: avg,
                edge: dockEdge,
                free: false,
                id: '',
                onclick: 'TaskDock.openList()'
            });
        } else {
            // 每个任务一张小窗；展开的那个不放小窗（它自己就是大窗口）
            let stack = 0;
            for (const t of list) {
                if (t.id === openPanelId) continue;
                if (t.view === 'expanded') continue;
                const sub = t.status === 'error' ? (t.error || L('失败', 'Failed'))
                    : t.status === 'done' ? L('已完成', 'Done')
                    : t.single ? (t.note || '')
                    : L(`${t.items.filter(i => i.status === 'done').length}/${t.items.length} 个文件`,
                         `${t.items.filter(i => i.status === 'done').length}/${t.items.length} files`);
                html += miniCardHTML({
                    cls: 'td-task' + (t.status === 'error' ? ' is-error' : (t.status === 'done' ? ' is-done' : '')),
                    icon: iconOf(t.type),
                    title: t.title,
                    sub,
                    percent: t.percent,
                    id: t.id,
                    edge: t.dock.edge,
                    free: t.dock.free,
                    x: t.dock.x, y: t.dock.y,
                    idx: stack++,
                    onclick: `TaskDock.open('${t.id}')`
                });
            }
        }

        // 展开的任务面板
        for (const t of list) {
            if (t.id === openPanelId && t.view === 'expanded') html += panelHTML(t);
        }
        // 合并列表面板
        if (listPanelOpen) html += listPanelHTML(list);
        // 列表里点开的某个任务的明细
        if (focusId && !openPanelId) {
            const ft = tasks.get(focusId);
            if (ft) html += panelHTML(ft, true);
        }

        el.innerHTML = html;
        bindAll();
        notifyChange();
    }

    function miniCardHTML(o) {
        // ★ 自由浮动的窗口必须用自己的 x/y，否则下一次 render 会把它
        //   弹回边缘 —— 拖了跟没拖一样。
        const edgeStyle = o.free
            ? `left:${o.x || 0}px;top:${o.y || 0}px;right:auto;bottom:auto;`
            : (o.edge === 'left'
                ? `left:12px;right:auto;` : `right:12px;left:auto;`)
              + `bottom:${12 + (o.idx || 0) * 74}px;`;
        return `
        <div class="td-mini ${o.cls}" data-id="${o.id || ''}" data-edge="${o.free ? 'free' : o.edge}" style="${edgeStyle}"
             onclick="${o.onclick}">
            <div class="td-mini-ico">${o.icon}</div>
            <div class="td-mini-main">
                <div class="td-mini-title">${esc(o.title)}</div>
                <div class="td-mini-bar"><div class="td-mini-fill" style="width:${o.percent}%"></div></div>
                <div class="td-mini-sub">${esc(o.sub || '')}</div>
            </div>
            <div class="td-mini-pct">${o.percent}%</div>
        </div>`;
    }

    function panelHTML(t, fromList) {
        const rows = t.items.map((it, i) => `
            <div class="td-row ${it.status}">
                <span class="td-row-name">${esc(it.name)}</span>
                <span class="td-row-pct">${it.status === 'done' ? L('完成', 'Done') : it.percent + '%'}</span>
                <div class="td-row-bar"><div style="width:${it.percent}%"></div></div>
            </div>`).join('');
        const body = t.single ? `
            <div class="td-note">${esc(t.note || '')}</div>
            <div class="td-bar"><div class="td-bar-fill" style="width:${t.percent}%"></div></div>`
            : (rows || `<div class="td-note">${esc(t.note || '')}</div>`);
        const statusCls = t.status === 'error' ? 'is-error' : (t.status === 'done' ? 'is-done' : '');
        const posStyle = t.dock.free
            ? `left:${t.dock.x}px;top:${t.dock.y}px;`
            : (t.dock.edge === 'left' ? `left:12px;` : `right:12px;`)
              + `bottom:12px;`;
        return `
        <div class="td-panel ${statusCls}" data-id="${t.id}" style="${posStyle}">
            <div class="td-head" data-id="${t.id}">
                <span class="td-head-ico">${iconOf(t.type)}</span>
                <span class="td-head-title">${esc(t.title)}</span>
                <span class="td-head-pct">${t.percent}%</span>
                <button class="td-btn" title="${L('收起到侧边', 'Dock to side')}"
                        onclick="TaskDock.collapse('${t.id}')">─</button>
                <button class="td-btn" title="${L('关闭', 'Close')}"
                        onclick="TaskDock.dismiss('${t.id}')">✕</button>
            </div>
            <div class="td-body">${body}</div>
            ${t.status === 'error' && t.error ? `<div class="td-err">${esc(t.error)}</div>` : ''}
            <div class="td-foot">${L('拖动标题栏可停靠到侧边', 'Drag the title bar to dock')}</div>
        </div>`;
    }

    function listPanelHTML(list) {
        const rows = list.map(t => {
            const st = t.status === 'error' ? L('失败', 'Failed')
                : t.status === 'done' ? L('完成', 'Done')
                : t.percent + '%';
            return `
            <div class="td-list-row ${t.status}" onclick="TaskDock.focus('${t.id}')">
                <span class="td-list-ico">${iconOf(t.type)}</span>
                <span class="td-list-title">${esc(t.title)}</span>
                <span class="td-list-st">${st}</span>
            </div>`;
        }).join('');
        const edge = pos.edge || 'right';
        return `
        <div class="td-panel td-list-panel" style="${edge === 'left' ? 'left:12px;' : 'right:12px;'}bottom:12px;">
            <div class="td-head">
                <span class="td-head-ico">⚙️</span>
                <span class="td-head-title">${L('全部任务', 'All tasks')}（${list.length}）</span>
                <button class="td-btn" onclick="TaskDock.closeList()">✕</button>
            </div>
            <div class="td-body">${rows}</div>
        </div>`;
    }

    function bindAll() {
        const el = root; if (!el) return;
        // 大窗口标题栏拖动
        el.querySelectorAll('.td-panel > .td-head').forEach(h => {
            const id = h.getAttribute('data-id');
            if (!id) return;
            const t = tasks.get(id); if (!t) return;
            h.addEventListener('pointerdown', e => {
                if (e.target.classList.contains('td-btn')) return;
                startDrag(e, h.parentElement, t);
            });
        });
        // 小窗口拖动：超过 5px 才算拖，否则当点击处理
        el.querySelectorAll('.td-mini').forEach(m => {
            const id = m.getAttribute('data-id');
            const t = id ? tasks.get(id) : null;
            if (!t) return;                      // 合并卡靠点击，不拖
            m.addEventListener('pointerdown', e => startMiniDrag(e, m, t));
        });
    }

    // 点击小窗：如果被判定为拖动过，就不算点击
    document.addEventListener('click', e => {
        const m = e.target.closest && e.target.closest('.td-mini');
        if (m && m.classList.contains('td-no-click')) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function open(id) {
        const t = tasks.get(id); if (!t) return;
        t.view = 'expanded';
        openPanelId = id;
        listPanelOpen = false;
        focusId = null;
        render();
    }
    function collapse(id) {
        const t = tasks.get(id); if (!t) return;
        t.view = 'mini';
        if (openPanelId === id) openPanelId = null;
        render();
    }
    function dismiss(id) {
        // 用户主动关：跑完的直接清掉，还在跑的也清掉（任务本身继续，只是不看）
        remove(id);
    }
    function openList() { listPanelOpen = true; focusId = null; render(); }
    function closeList() { listPanelOpen = false; focusId = null; render(); }
    function focus(id) { focusId = id; render(); }
    function backToList() { focusId = null; render(); }


    /* =====================================================================
       插件窗口
       ---------------------------------------------------------------------
       插件原来是全屏覆盖层（.plugin-overlay），一打开就把网盘整个挡死，
       想一边跑插件一边翻文件根本不可能。现在改成和上传/分享同一套：
       可拖动的窗口，拖到侧边收成小窗，点开继续，多个插件各占一个窗口。

       ★ 和上传任务最不一样的地方：上传任务的窗口是 innerHTML 重绘的，
         但插件窗口里装的是 <iframe> —— 而 **移动 iframe 会导致它重新加载**，
         插件内部状态（比如游戏进度、填了一半的表单）会全部丢失。

         所以插件窗口绝对不能走 render() 的 innerHTML 重绘：
           1. 每个窗口是独立的 DOM 节点，创建后不再重建
           2. 收起/展开只切 class，不移动节点
           3. 拖动只改 left/top，节点始终待在同一个父容器里
         这样 iframe 从头到尾没有离开过文档流，插件也就不会重载。
       ===================================================================== */
    const pwins = new Map();          // id -> win
    const pwStages = new Map();       // 插件 id -> 后台进程里的预览占位元素
    let pwStageRaf = null;            // 预览位置同步循环
    let pwRoot = null;
    let pwSeq = 0;
    let pwZ = 9500;
    const PW_KEY = 'gd_plugindock_pos';

    function pwLoad() {
        try { return JSON.parse(localStorage.getItem(PW_KEY) || '{}'); } catch (e) { return {}; }
    }
    function pwSave(p) { try { localStorage.setItem(PW_KEY, JSON.stringify(p)); } catch (e) {} }
    let pwPos = pwLoad();

    function pwEnsureRoot() {
        if (pwRoot && document.body.contains(pwRoot)) return pwRoot;
        const old = document.getElementById('plugin-dock');
        if (old) old.remove();
        pwRoot = document.createElement('div');
        pwRoot.id = 'plugin-dock';
        document.body.appendChild(pwRoot);
        return pwRoot;
    }

    function pwEsc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * 开一个插件窗口
     * @param {Object} o
     * @param {string} o.title  窗口标题
     * @param {string} o.icon   图标
     * @param {HTMLElement} o.mount 插件内容（通常是 iframe）
     * @param {Function} [o.onClose] 关闭回调（回收 blob URL 用）
     * @returns {string} 窗口 id
     */
    function openPlugin(o) {
        const root = pwEnsureRoot();
        const id = 'pw' + (++pwSeq);
        const w = {
            id,
            title: o.title || L('插件', 'Plugin'),
            icon: o.icon || '🔌',
            mount: o.mount || null,
            onClose: o.onClose || null,
            view: 'expanded',                 // expanded | mini
            full: false,
            dock: { edge: pwPos.edge || 'right', x: 0, y: 0, free: false },
            el: null,
            z: ++pwZ
        };
        pwins.set(id, w);

        // ★ 移动端：打开就是全屏。
        //   手机上再飘一个 460×380 的小窗很难拖，也不符合"点了就进去"的习惯。
        if (isMobile()) { w.view = 'expanded'; w.full = true; }

        // ★ 移动端标题栏不放"全屏"按钮（本来就是全屏），
        //   "收起"也从 ─ 换成 ↧ —— 含义是"收进后台进程"，不是"贴到侧边"。
        const acts = isMobile()
            ? `<button class="tp-btn" data-act="mini" title="${L('收进后台进程', 'Send to background')}">↧</button>
               <button class="tp-btn" data-act="close" title="${L('关闭', 'Close')}">✕</button>`
            : `<button class="tp-btn" data-act="mini" title="${L('收起到侧边', 'Dock to side')}">─</button>
               <button class="tp-btn" data-act="full" title="${L('全屏', 'Fullscreen')}">⤢</button>
               <button class="tp-btn" data-act="close" title="${L('关闭', 'Close')}">✕</button>`;

        const el = document.createElement('div');
        el.className = 'tp-win';
        el.dataset.id = id;
        el.innerHTML = `
            <div class="tp-head">
                <span class="tp-ico">${pwEsc(w.icon)}</span>
                <span class="tp-title">${pwEsc(w.title)}</span>
                <span class="tp-spacer"></span>
                ${acts}
            </div>
            <div class="tp-body"></div>`;
        if (w.mount) el.querySelector('.tp-body').appendChild(w.mount);
        // ★ 预览态的点击层：窗口盖在预览卡上，点 iframe 会被插件自己吃掉，
        //   所以铺一层透明的罩子，点它就全屏打开（标题栏按钮留在外面照常能点）。
        const mask = document.createElement('div');
        mask.className = 'tp-stage-mask';
        mask.addEventListener('click', ev => {
            ev.stopPropagation();
            w.view = 'expanded';
            w.full = true;
            pwBring(id);
            pwLayout();
        });
        el.querySelector('.tp-body').appendChild(mask);
        root.appendChild(el);
        w.el = el;

        // 按钮
        el.querySelectorAll('.tp-btn').forEach(b => {
            b.addEventListener('click', ev => {
                ev.stopPropagation();
                const a = b.getAttribute('data-act');
                if (a === 'mini') pwCollapse(id);
                else if (a === 'full') pwToggleFull(id);
                else if (a === 'close') pwClose(id);
            });
        });
        // 标题栏拖动
        const head = el.querySelector('.tp-head');
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('.tp-btn')) return;
            pwBring(id);
            pwStartDrag(e, el, w);
        });
        // 点窗口本体也置顶
        el.addEventListener('pointerdown', () => pwBring(id));

        pwLayout();
        try { window.dispatchEvent(new CustomEvent('gd:plugin-changed')); } catch (e) {}
        return id;
    }

    function pwBring(id) {
        const w = pwins.get(id); if (!w || !w.el) return;
        w.z = ++pwZ;
        w.el.style.zIndex = w.z;
    }

    function pwCollapse(id) {
        const w = pwins.get(id); if (!w) return;
        // ★ 移动端：收起不是"贴边变小窗"，而是收进「后台进程」里的预览卡
        if (isMobile()) { w.view = 'stage'; w.full = false; pwLayout(); return; }
        w.view = 'mini';
        w.full = false;
        pwLayout();
    }
    function pwExpand(id) {
        const w = pwins.get(id); if (!w) return;
        w.view = 'expanded';
        pwBring(id);
        pwLayout();
    }
    function pwToggleFull(id) {
        const w = pwins.get(id); if (!w) return;
        w.full = !w.full;
        if (w.full) w.view = 'expanded';
        pwBring(id);
        pwLayout();
    }
    function pwClose(id) {
        const w = pwins.get(id); if (!w) return;
        try { if (w.onClose) w.onClose(); } catch (e) { console.warn(e); }
        if (w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
        pwins.delete(id);
        pwStages.delete(id);
        pwLayout();
        // 通知界面：后台进程里的预览卡要跟着少一个
        try { window.dispatchEvent(new CustomEvent('gd:plugin-changed')); } catch (e) {}
    }

    /* =====================================================================
       移动端插件预览 —— 「后台进程」里直接看到插件在跑的样子
       =====================================================================
       难点：iframe 一旦被移动（换父节点）就会重新加载，插件里的进度、
       填了一半的表单全没了。所以这里**绝不移动窗口节点**，
       只把窗口用绝对定位贴到预览卡的位置上（#plugin-dock 是 fixed inset:0，
       它的 absolute 坐标原点就是视口左上角，正好和 getBoundingClientRect 对齐）。
       位置每帧同步一次，列表滚动时也跟得上。
       ===================================================================== */
    /** 找预览占位：视图重绘后节点会换，所以每次都现场确认一遍 */
    function findStage(id) {
        let st = pwStages.get(id);
        if (!st || !document.body.contains(st)) {
            const again = document.querySelector('.tp-stage[data-pid="' + id + '"]');
            if (again) { pwStages.set(id, again); st = again; }
        }
        return (st && document.body.contains(st)) ? st : null;
    }

    function pwSyncStages() {
        for (const w of pwins.values()) {
            const id = w.id;
            const st = findStage(id);
            if (!st) continue;
            if (!w || !w.el) continue;
            // 全屏/展开的窗口不跟随预览卡，否则会被拽回小尺寸
            if (w.full || w.view !== 'stage') continue;
            if (!document.body.contains(st)) continue;
            const r = st.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            const el = w.el;
            el.style.left = Math.round(r.left) + 'px';
            el.style.top = Math.round(r.top) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.width = Math.round(r.width) + 'px';
            el.style.height = Math.round(r.height) + 'px';
            el.style.minWidth = '0';
            el.style.minHeight = '0';
        }
    }

    function pwStartStageSync() {
        if (pwStageRaf) return;
        const tick = () => { pwStageRaf = requestAnimationFrame(tick); pwSyncStages(); };
        pwStageRaf = requestAnimationFrame(tick);
    }

    function pwStopStageSync() {
        if (pwStageRaf) { cancelAnimationFrame(pwStageRaf); pwStageRaf = null; }
    }

    /** 后台进程里的插件预览区 HTML（没插件时返回空串） */
    function pluginStagesHTML() {
        if (!pwins.size) return '';
        let h = '<div class="tp-stage-sec"><div class="tp-stage-title">🧩 '
              + L('运行中的插件', 'Running plugins') + `（${pwins.size}）</div>`;
        for (const w of pwins.values()) {
            h += `<div class="tp-stage-card" data-pid="${pwEsc(w.id)}">`
               + `<div class="tp-stage-head"><span>${pwEsc(w.icon)}</span>`
               + `<span class="tp-stage-name">${pwEsc(w.title)}</span></div>`
               + `<div class="tp-stage" data-pid="${pwEsc(w.id)}"></div>`
               + `<div class="tp-stage-tip">${L('点击预览，全屏打开', 'Tap the preview to open fullscreen')}</div>`
               + `</div>`;
        }
        return h + '</div>';
    }

    /**
     * 收集预览占位并启动同步。
     * @param {HTMLElement} box 预览区容器
     */
    function bindPluginStages(box) {
        const root = box || document;
        pwStages.clear();
        root.querySelectorAll('.tp-stage[data-pid]').forEach(st => {
            pwStages.set(st.getAttribute('data-pid'), st);
        });
        // 点卡片任意处 → 全屏打开（这就是"点小窗口后直接进去应用"）
        root.querySelectorAll('.tp-stage-card[data-pid]').forEach(card => {
            card.addEventListener('click', () => {
                const id = card.getAttribute('data-pid');
                const w = pwins.get(id);
                if (!w) return;
                w.view = 'expanded';
                w.full = true;
                pwBring(id);
                pwLayout();
            });
        });
        if (pwStages.size) { pwLayout(); pwStartStageSync(); }
    }

    /** 离开后台进程视图：停止同步，收起的插件先藏起来 */
    function stopPluginStages() {
        pwStopStageSync();
        pwStages.clear();
        pwLayout();
    }

    /** 拖动：只改 left/top，绝不移动节点（移动 iframe 会重载插件） */
    function pwStartDrag(e, el, w) {
        if (e.button !== undefined && e.button !== 0) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        el.classList.add('tp-dragging');
        document.body.classList.add('td-dragging-body');
        let hint = null;
        function move(ev) {
            const nearL = ev.clientX < EDGE_SNAP;
            const nearR = ev.clientX > window.innerWidth - EDGE_SNAP;
            const want = nearL ? 'left' : (nearR ? 'right' : null);
            if (!hint) { hint = document.createElement('div'); hint.className = 'td-dock-hint'; document.body.appendChild(hint); }
            if (want) {
                hint.textContent = L('松手停靠到' + (want === 'left' ? '左侧' : '右侧'),
                                     'Release to dock ' + (want === 'left' ? 'left' : 'right'));
                hint.classList.add('show');
                hint.style.left = (want === 'left' ? 12 : window.innerWidth - 12) + 'px';
                hint.style.transform = want === 'left' ? 'none' : 'translateX(-100%)';
            } else hint.classList.remove('show');

            el.style.left = (ev.clientX - dx) + 'px';
            el.style.top = (ev.clientY - dy) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
        function up(ev) {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            el.classList.remove('tp-dragging');
            document.body.classList.remove('td-dragging-body');
            if (hint) hint.remove();
            const nearL = ev.clientX < EDGE_SNAP;
            const nearR = ev.clientX > window.innerWidth - EDGE_SNAP;
            if (nearL || nearR) {
                w.dock.edge = nearL ? 'left' : 'right';
                w.dock.free = false;
                pwPos.edge = w.dock.edge; pwSave(pwPos);
                w.view = 'mini';                    // 拖到边缘 = 收成小窗
            } else {
                const rr = el.getBoundingClientRect();
                w.dock.free = true;
                w.dock.x = Math.round(rr.left);
                w.dock.y = Math.round(rr.top);
            }
            pwLayout();
        }
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        e.preventDefault();
    }

    /** 合并卡 / 列表（同样是常驻节点，只切换显示） */
    function pwEnsureMerged() {
        const root = pwEnsureRoot();
        let m = root.querySelector('.tp-merged');
        if (!m) {
            m = document.createElement('div');
            m.className = 'tp-merged';
            m.innerHTML = `<div class="tp-merged-ico">🧩</div>
                           <div class="tp-merged-main"><div class="tp-merged-title"></div></div>`;
            m.addEventListener('click', () => pwOpenList());
            root.appendChild(m);
        }
        return m;
    }
    function pwEnsureList() {
        const root = pwEnsureRoot();
        let p = root.querySelector('.tp-list');
        if (!p) {
            p = document.createElement('div');
            p.className = 'tp-list';
            p.innerHTML = `<div class="tp-head">
                    <span class="tp-ico">🧩</span>
                    <span class="tp-title tp-list-title"></span>
                    <span class="tp-spacer"></span>
                    <button class="tp-btn" data-act="close">✕</button>
                </div>
                <div class="tp-list-body"></div>`;
            p.querySelector('.tp-btn').addEventListener('click', e => { e.stopPropagation(); pwCloseList(); });
            root.appendChild(p);
        }
        return p;
    }
    function pwOpenList() {
        const p = pwEnsureList();
        p.classList.add('show');
        p.style.zIndex = ++pwZ;
        pwRenderList();
    }
    function pwCloseList() { const p = pwEnsureList(); p.classList.remove('show'); }
    function pwRenderList() {
        const p = pwEnsureList();
        p.querySelector('.tp-list-title').textContent = L('运行中的插件', 'Running plugins') + `（${pwins.size}）`;
        const body = p.querySelector('.tp-list-body');
        body.innerHTML = '';
        for (const w of pwins.values()) {
            const row = document.createElement('div');
            row.className = 'tp-list-row';
            row.innerHTML = `<span class="tp-list-ico">${pwEsc(w.icon)}</span>
                             <span class="tp-list-name">${pwEsc(w.title)}</span>
                             <span class="tp-list-st">${w.view === 'mini' ? L('已收起', 'Docked') : L('运行中', 'Running')}</span>`;
            row.addEventListener('click', () => { pwExpand(w.id); pwCloseList(); });
            body.appendChild(row);
        }
    }

    /**
     * 布局：不给节点搬家，只改 style 和 class。
     * 小窗超过 3 个就合并成一张卡 —— 4 个小窗竖着排会占掉半屏。
     */
    function pwLayout() {
        const root = pwEnsureRoot();
        const list = Array.from(pwins.values());
        if (!list.length) {
            const m = root.querySelector('.tp-merged'); if (m) m.classList.remove('show');
            pwCloseList();
            return;
        }
        const minis = list.filter(w => w.view === 'mini');
        const merged = minis.length > MINI_LIMIT;

        let stack = 0;
        for (const w of list) {
            const el = w.el; if (!el) continue;
            el.style.zIndex = w.z;
            el.classList.toggle('is-mini', w.view === 'mini');
            el.classList.toggle('is-full', !!w.full);

            // 收进「后台进程」：位置由 pwSyncStages 每帧对齐到预览卡，
            // 窗口节点始终待在 #plugin-dock 里，iframe 不会重载。
            if (w.view === 'stage') {
                el.classList.add('is-stage');
                const st = findStage(w.id);
                if (st) {
                    // 占位找到了就得有人持续对齐位置（视图重绘后循环可能已停）
                    pwStartStageSync();
                }
                if (st) {
                    el.style.display = '';
                    el.style.width = ''; el.style.height = '';
                } else {
                    // 还没进后台进程视图（或预览卡已销毁）→ 先藏着
                    el.style.display = 'none';
                }
                continue;
            }
            el.classList.remove('is-stage');

            if (w.full) {
                el.style.left = '0px'; el.style.top = '0px';
                el.style.right = 'auto'; el.style.bottom = 'auto';
                el.style.width = '100vw'; el.style.height = '100vh';
                continue;
            }
            el.style.width = ''; el.style.height = '';

            if (w.view === 'mini') {
                // 合并时单独的小窗隐藏，只留一张合并卡
                el.style.display = merged ? 'none' : '';
                if (merged) continue;
                const idx = stack++;
                el.style.top = 'auto';
                if (w.dock.free) {
                    el.style.left = w.dock.x + 'px';
                    el.style.bottom = 'auto';
                    el.style.top = w.dock.y + 'px';
                } else {
                    el.style.left = w.dock.edge === 'left' ? '12px' : 'auto';
                    el.style.right = w.dock.edge === 'right' ? '12px' : 'auto';
                    el.style.bottom = (12 + idx * 74) + 'px';
                }
            } else {
                el.style.display = '';
                if (w.dock.free) {
                    el.style.left = w.dock.x + 'px';
                    el.style.top = w.dock.y + 'px';
                    el.style.right = 'auto'; el.style.bottom = 'auto';
                } else {
                    el.style.top = 'auto';
                    el.style.left = w.dock.edge === 'left' ? '12px' : 'auto';
                    el.style.right = w.dock.edge === 'right' ? '12px' : 'auto';
                    el.style.bottom = '12px';
                }
            }
        }

        const m = pwEnsureMerged();
        if (merged) {
            m.classList.add('show');
            m.style.zIndex = ++pwZ;
            const edge = pwPos.edge || 'right';
            m.style.left = edge === 'left' ? '12px' : 'auto';
            m.style.right = edge === 'right' ? '12px' : 'auto';
            m.style.bottom = '12px';
            m.querySelector('.tp-merged-title').textContent =
                L(`${minis.length} 个插件在后台运行`, `${minis.length} plugins running`);
        } else {
            m.classList.remove('show');
            pwCloseList();
        }
        // 列表开着时同步内容
        const lp = root.querySelector('.tp-list');
        if (lp && lp.classList.contains('show')) pwRenderList();
    }

    // 窗口尺寸随视口变化时保持贴边（小窗堆叠位置重算）
    window.addEventListener('resize', () => { if (pwins.size) pwLayout(); });

    /**
     * 小窗"飞进"后台进程列表。
     *
     * ★ 用 FLIP：先量小窗的起点位置，等列表渲染出落点后再量终点，
     *   用 transform 把元素从终点平移回起点，然后过渡到 0。
     *   全程只动 transform/opacity（合成层），不触发逐帧重排，所以很丝滑。
     *
     * @param {string} taskId - 要飞的任务；不给就飞当前所有小窗
     */
    function flyToList(taskId) {
        if (isMobile()) { miniSuppressed = true; render(); return; }
        const el = ensureRoot();
        const cards = Array.from(el.querySelectorAll('.td-mini'));
        // 没有小窗可飞（比如只剩展开的大面板）也要把状态置上，
        // 否则关掉面板前小窗会重新冒出来，和列表重复。
        if (!cards.length) { miniSuppressed = true; render(); return; }

        // ① 记起点
        const firstRects = new Map();
        cards.forEach(c => firstRects.set(c, c.getBoundingClientRect()));

        // ② 让调用方把面板打开（渲染出落点），下一帧再量终点
        requestAnimationFrame(() => {
            const rows = document.querySelectorAll('.task-mgr-row');
            if (!rows.length) return;

            cards.forEach((card, i) => {
                const id = card.getAttribute('data-id');
                if (taskId && id && id !== taskId) return;

                // 找到对应落点：优先 data-id 匹配，其次按序号兜底
                let target = id ? document.querySelector(`.task-mgr-row[data-id="${id}"]`) : null;
                if (!target) target = rows[Math.min(i, rows.length - 1)];
                if (!target) return;

                const f = firstRects.get(card);
                const last = target.getBoundingClientRect();
                const dx = f.left - last.left;
                const dy = f.top - last.top;

                // ③ 倒置：把卡片放到落点上，再用 transform 拉回起点
                card.classList.add('is-flying');
                card.style.transform = `translate(${dx}px, ${dy}px)`;
                card.style.opacity = '0.85';

                requestAnimationFrame(() => {
                    card.style.transform = 'translate(0, 0)';
                    card.style.opacity = '0';
                    target.classList.add('is-landing');
                    setTimeout(() => {
                        target.classList.remove('is-landing');
                        card.classList.remove('is-flying');
                        card.style.transform = '';
                        card.style.opacity = '';
                        // 飞完了才真正收掉：动画期间小窗必须还在 DOM 里
                        miniSuppressed = true;
                        render();
                    }, 440);
                });
            });
        });
    }

    /** 关掉"后台进程"面板后，小窗回边缘 */
    function resumeMini() {
        if (!miniSuppressed) return;
        miniSuppressed = false;
        render();
    }

    /** 拿全部任务（后台进程面板用） */
    function all() {
        return Array.from(tasks.values()).map(t => ({
            id: t.id, type: t.type, title: t.title, note: t.note,
            percent: t.percent, status: t.status, error: t.error,
            startedAt: t.startedAt, finishedAt: t.finishedAt,
            single: t.single,
            items: t.items.map(i => ({ name: i.name, percent: i.percent, status: i.status }))
        }));
    }

    return {
        create, updateItem, setItemDone, setPercent, setNote, finish, remove,
        open, collapse, dismiss, openList, closeList, focus, backToList, get,
        flyToList, resumeMini, all, isMobile,
        openPlugin, closePlugin: pwClose, expandPlugin: pwExpand, collapsePlugin: pwCollapse,
        togglePluginFull: pwToggleFull, closePluginList: pwCloseList,
        pluginStagesHTML, bindPluginStages, stopPluginStages,
        get pluginCount() { return pwins.size; },
        get count() { return tasks.size; }
    };
})();
