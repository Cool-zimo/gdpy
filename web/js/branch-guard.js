/**
 * 版本切换守卫
 *
 * ★ 存在的理由：切到一个加载不出来的分支会**永久死锁**。
 *
 *   流程是 localStorage 写入分支名 → reload → 从 jsdelivr 加载该分支的
 *   CSS/JS。如果那个分支没部署成功（实测 preview/AI-Agent/dark-mode
 *   在 jsdelivr 上就是 404），CSS 和 JS 全部 404 → 页面白得只剩骨架 →
 *   用户根本进不去设置页 → 也就没法再切回 main。
 *
 *   白屏的页面里没有任何可以点的东西，localStorage 又一直存着坏分支名，
 *   刷新多少次都是白屏。这是"自己把自己锁在门外"。
 *
 *   所以这里在最外层做兜底：只要发现关键模块没加载出来，就插一条逃生横幅。
 *   横幅用纯 DOM API 构建，不依赖任何可能已经挂掉的模块。
 */
(function () {
    'use strict';

    var KEY = 'gd_custom_branch';

    function isValidBranch(b) {
        return typeof b === 'string' && b.length > 0 && b.length <= 200 &&
               /^[A-Za-z0-9._\/-]+$/.test(b) && b.indexOf('..') === -1;
    }

    // URL 逃生入口：?branch=main 也能回官方版，?safe=1 直接强制
    function applyEscapeHatch() {
        try {
            var q = new URLSearchParams(window.location.search);
            if (q.get('safe') === '1') {
                localStorage.removeItem(KEY);
                return true;
            }
            var b = q.get('branch');
            if (b !== null) {
                if (!isValidBranch(b)) {
                    localStorage.removeItem(KEY);
                } else if (b === 'main') {
                    localStorage.removeItem(KEY);
                }
                return true;
            }
        } catch (e) { /* localStorage 不可用时什么都不做 */ }
        return false;
    }

    // ★ 必须在加载任何脚本之前跑，否则分支名已经拼进 CDN URL 了
    var escaped = applyEscapeHatch();

    // 分支名不合法就地清掉，别让它进入后续流程
    try {
        var cur = localStorage.getItem(KEY);
        if (cur && !isValidBranch(cur)) localStorage.removeItem(KEY);
    } catch (e) {}

    function modulesMissing() {
        // ★ 不能用 'Storage' 当探针：浏览器原生就有 window.Storage 接口，
        //   即使分支上的 storage.js 没加载成功，typeof Storage 也是 'function'，
        //   会漏判。挑的都是不会与浏览器内置重名的。
        var need = ['GitHubAPI', 'FileManager', 'ShareManager', 'Maintain', 'UI', 'I18n', 'App'];
        var miss = [];
        for (var i = 0; i < need.length; i++) {
            // 用 window 直查：class 声明不会挂到 window，但 const/class 在
            // 全局作用域下可通过 eval 间接访问；这里改用 typeof 直查标识符
            try {
                if (eval('typeof ' + need[i]) === 'undefined') miss.push(need[i]);
            } catch (e) {
                miss.push(need[i]);
            }
        }
        return miss;
    }

    function buildBanner(missing, branch) {
        var bar = document.createElement('div');
        bar.id = 'gd-branch-guard';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
            'background:#dc2626;color:#fff;padding:12px 16px;font:14px/1.5 ' +
            '-apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
            'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';

        var txt = document.createElement('div');
        txt.style.cssText = 'flex:1;min-width:200px;';
        txt.textContent = '⚠️ 版本「' + branch + '」加载失败（缺少 ' +
            missing.join('、') + '）。页面可能无法正常使用。';
        bar.appendChild(txt);

        var btn = document.createElement('button');
        btn.textContent = '🏠 恢复官方版';
        btn.style.cssText = 'background:#fff;color:#dc2626;border:none;border-radius:6px;' +
            'padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;';
        btn.onclick = function () {
            try { localStorage.removeItem(KEY); } catch (e) {}
            // ★ 带上 safe=1：有些环境下 location.reload() 会命中缓存，
            //   带上参数可以确保走一遍清理逻辑
            var u = new URL(window.location.href);
            u.search = '?safe=1';
            u.hash = '';
            window.location.replace(u.toString());
        };
        bar.appendChild(btn);
        return bar;
    }

    function check() {
        var branch = null;
        try { branch = localStorage.getItem(KEY); } catch (e) {}
        if (!branch || branch === 'main') return;   // 官方版不需要守卫
        if (window.__BRANCH_BASE__ === undefined &&
            window.__CUSTOM_BRANCH__ === undefined) return;  // 没真的走分支加载

        var missing = modulesMissing();
        if (!missing.length) return;

        console.error('[branch-guard] 分支 ' + branch + ' 加载失败，缺少: ' + missing.join(', '));
        var bar = buildBanner(missing, branch);
        if (document.body) {
            document.body.insertBefore(bar, document.body.firstChild);
            document.body.style.paddingTop = '56px';
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                document.body.insertBefore(bar, document.body.firstChild);
                document.body.style.paddingTop = '56px';
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            // 等一拍：document.write 的脚本是同步加载的，但保险起见
            setTimeout(check, 0);
        });
    } else {
        setTimeout(check, 0);
    }

    window.BranchGuard = {
        isValidBranch: isValidBranch,
        escapeHatchApplied: escaped,
        KEY: KEY
    };
})();
