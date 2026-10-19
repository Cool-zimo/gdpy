const APP_VERSION = {
    internalVersion: '87',
    formalVersion: '0.0.87',
    displayVersion: 'v0.0.87',
    //   = 1：契约体系建立。移除侧边栏 nav-group 折叠结构。
    //   = 2：侧边栏图标从 emoji 换成 <img src="assets/icons/...">。
    //        HTML 结构变了（nav-icon 内新增 img 节点），CSS 也新增了
    //        .nav-icon img 规则 —— 老 CSS 配新 HTML 会导致图标尺寸失控。
    //   = 3：后台进程视图拆出「插件预览区」（#tm-stages / .tp-stage）。
    //        JS 会按 .tp-stage[data-pid] 收集占位并把插件窗口贴上去，
    //        老 CSS 没有 .tp-stage 规则 → 占位框没高度，预览会塌成一条线。
    //   = 4：弹窗退场。JS 会往 .modal-overlay 上加 .is-closing 并把节点
    //        挪进 #modal-exit-layer 播完动画再移除。老 CSS 没有这两条规则 →
    //        退场中的弹窗会以无定位状态挂在页面底部约 260ms。
    //   = 6：新增 js/theme.js（给内联硬编码标题打 data-gd-force 标记，
    //        并处理内联白底）、js/i18n-scan.js（英文兜底，依赖
    //        body 上有 [data-gd-force] 与 CSS 变量 --text-* 已定义）、
    //        js/plugin-api.js（插件接口，CSS 无依赖）。
    //        theme.js 依赖 CSS 里 [data-gd-force="title"] 等规则，
    //        老 CSS 没有 → 打了标记也不生效，暗色下标题依旧看不清。
    //
    //   = 7：侧边栏右边缘新增拖拽把手 div.gd-sb-resizer（由 js/custom.js
    //        动态插入）。老 CSS 没有这条规则 → 把手没有尺寸和 col-resize
    //        光标，表现为「右边缘拖不动」。同时 js/i18n.js 的 t(key, fallback)
    //        新增第二参数，i18n-scan 新增裸键清洗 —— 这两处 CSS 无依赖。
    //
    //   = 5：动画行为层 js/anim.js 上线。JS 会往按钮里注入
    //        <span class="gd-ripple"> 并给宿主加 .gd-ripple-host，
    //        同时给仪表盘加 .dash-card / .dash-num[data-count]。
    //        老 CSS 没有 gd-ripple 规则 → 涟漪会是一个不透明的实心色块
    //        盖在按钮上；没有 dash-card → 仪表盘卡片没有入场动画。
    //
    //   = 7 期间的加载改造（v0.0.87，不涉及契约变化，故不 bump）：
    //       - index.html 里 15 个 CORE 脚本从 document.write 改成静态
    //         <script defer>，CSS 也改成静态 <link>。目的是让浏览器的
    //         预加载扫描器能看见它们 —— 原来 URL 是 JS 运行时拼的，
    //         扫描器不执行 JS，必须等 HTML 下载完才开始请求，白等 RTT。
    //       - CSS 的 URL 从 ?v=N 改成 ?h=<内容 hash>；--stamp 移到
    //         index.html 的内联 <style>，否则它每轮都变，会把 CSS 的
    //         内容 hash 也带着变，样式表每次升级都要重新下载。
    //       - app.js 的版本戳读取改为跨样式表累加：--stamp 在内联、
    //         --api-stamp 在 css 文件，原来遇到第一个就 break 会漏掉
    //         另一个。CSS 无依赖，故不 bump api。
    apiVersion: '7'
};
