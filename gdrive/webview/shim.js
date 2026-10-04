/* ============================================================
 * gdpy 桌面版注入脚本（由本地服务注入，网页版不会加载它）
 *
 * ★ 为什么存在：
 *   网页版跑在浏览器里，直接 fetch api.github.com。
 *   桌面版的页面来自 http://127.0.0.1，cross-origin 请求会走 CORS 预检，
 *   而且部分环境（企业代理 / 国产浏览器内核）会直接拦掉。
 *
 *   所以这里把「所有非同源请求」改道到 Python 桥：
 *   JS → pywebview.api.http_request → Python urllib → GitHub
 *
 * ★ 注入位置：<head> 里第一个脚本（见 server.py）
 *
 *   早期版本注入在 </body> 前，理由是"那时所有 class 已定义"。
 *   但本脚本不引用任何页面 class，而在 <head> 才能拦住 index.html 里
 *   那段「分支预览 → 从 jsdelivr CDN 拉代码」的 document.write ——
 *   一旦走 CDN，桌面版跑的就不是打包进来的代码了。
 *
 * ★★ 三个曾经让桌面版"跑不动"的坑，都在这里修掉：
 *   1. 开头 `if (!window.pywebview) return;` ——
 *      若注入时机早于 pywebview 注入桥，整段静默失效，
 *      fetch 全走原生 → CORS 全挂 → 症状是"能开但什么都刷不出来"。
 *      现在把检查挪到**调用时**，加载时不依赖它。
 *   2. 分支预览会从 CDN 加载 13 个 js —— 桌面版必须永远用本地文件。
 *   3. window.open 在 pywebview 里开的是没有桥的新窗口，
 *      9 处调用（分享下载 / 仓库链接 / 文档）全是坏的。
 * ============================================================ */
(function () {
    'use strict';

    window.__GDPY__ = { desktop: true };

    var origFetch = window.fetch.bind(window);
    var origOpen = window.open.bind(window);

    /* ---------- 1. 桌面版永远用本地资源，不从 CDN 拉代码 ---------- */

    // 分支预览会把选中的分支记在 localStorage；
    // 桌面版不该继承网页版的选择 —— 清掉它，index.html 就会走本地分支。
    try { localStorage.removeItem('gd_custom_branch'); } catch (e) { }

    // 兜底：即便上面没拦住（比如 URL 里带了 ?branch=），
    // 也把 document.write 里的 CDN 前缀改成相对路径。
    var _write = document.write.bind(document);
    document.write = function (s) {
        if (typeof s === 'string' && s.indexOf('cdn.jsdelivr.net') !== -1) {
            s = s.replace(/https?:\/\/cdn\.jsdelivr\.net\/gh\/[^/'"\s]+\//g, '');
        }
        return _write(s);
    };

    /* ---------- 2. window.open → 系统浏览器 ---------- */

    window.open = function (url, target, features) {
        // 下载类的空 URL / about:blank 交给原生
        if (!url || url === 'about:blank') return origOpen(url, target, features);
        try {
            var api = window.pywebview && window.pywebview.api;
            if (api && api.open_external) {
                api.open_external({ url: String(url) });
                return null;
            }
        } catch (e) { }
        return origOpen(url, target, features);
    };

    /* ---------- 3. fetch 改道 ---------- */

    function isSameOrigin(url) {
        try {
            var u = new URL(url, location.href);
            return u.origin === location.origin;
        } catch (e) {
            return false;
        }
    }

    function b64ToBytes(b64) {
        var bin = atob(b64 || '');
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToB64(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function collectHeaders(init) {
        var h = init && init.headers;
        var out = {};
        if (!h) return out;
        if (typeof Headers !== 'undefined' && h instanceof Headers) {
            h.forEach(function (v, k) { out[k] = v; });
        } else if (Array.isArray(h)) {
            h.forEach(function (p) { out[p[0]] = p[1]; });
        } else if (typeof h === 'object') {
            for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k];
        }
        return out;
    }

    function makeResponse(res) {
        var status = res.status || 0;
        // 204/304/205 不允许有 body —— 带 body 构造 Response 会抛 TypeError
        var noBody = (status === 204 || status === 304 || status === 205 || status === 0);
        var body = null;
        if (!noBody && res.body_b64) body = b64ToBytes(res.body_b64);
        return new Response(body, {
            status: status,
            statusText: res.status_text || '',
            headers: res.headers || {}
        });
    }

    window.fetch = function (input, init) {
        var url;
        if (typeof input === 'string') url = input;
        else if (input && input.url) url = input.url;
        else url = String(input);

        if (isSameOrigin(url)) return origFetch(input, init);

        // ★ 调用时再取桥 —— 加载时它可能还没注入好。
        //   取不到就退回原生 fetch：宁可撞 CORS 报个错，
        //   也不要像以前那样静默什么都不做。
        var api = window.pywebview && window.pywebview.api;
        if (!api || !api.http_request) return origFetch(input, init);

        var method = (init && init.method) || 'GET';
        var headers = collectHeaders(init);
        var body = null;

        if (init && init.body !== undefined && init.body !== null) {
            var b = init.body;
            if (typeof b === 'string') {
                body = btoa(unescape(encodeURIComponent(b)));   // UTF-8 安全
            } else if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) {
                body = bytesToB64(new Uint8Array(b));
            } else if (typeof Uint8Array !== 'undefined' && b instanceof Uint8Array) {
                body = bytesToB64(b);
            } else if (typeof Blob !== 'undefined' && b instanceof Blob) {
                return origFetch(input, init);      // Blob 异步读不了
            } else {
                body = btoa(unescape(encodeURIComponent(String(b))));
            }
        }

        return api.http_request({
            method: method,
            url: url,
            headers: headers,
            body_b64: body
        }).then(makeResponse);
    };

    /* ---------- 4. 桌面原生能力 ---------- */

    window.gdpy = {
        pickOpen: function (title, multiple, filetypes) {
            return window.pywebview.api.pick_open_file({
                title: title || '选择文件', multiple: !!multiple,
                filetypes: filetypes || []
            });
        },
        pickSave: function (defaultName, filetypes) {
            return window.pywebview.api.pick_save_file({
                default_name: defaultName || '', filetypes: filetypes || []
            });
        },
        pickFolder: function (title) {
            return window.pywebview.api.pick_folder({ title: title || '选择文件夹' });
        },
        readFile: function (path) {
            return window.pywebview.api.read_file_b64({ path: path });
        },
        writeFile: function (path, b64) {
            return window.pywebview.api.write_file_b64({ path: path, b64: b64 });
        },
        exec: function (cmd, cwd) {
            return window.pywebview.api.exec_command({ cmd: cmd, cwd: cwd || '' });
        },
        showInFolder: function (path) {
            return window.pywebview.api.open_in_explorer({ path: path });
        },
        version: function () {
            return window.pywebview.api.app_version();
        },
        log: function (msg) {
            return window.pywebview.api.js_log({ msg: String(msg) });
        }
    };
})();
