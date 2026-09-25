/* ============================================================
 * gdpy 桌面版注入脚本
 *
 * ★ 为什么存在：
 *   网页版跑在浏览器里，直接 fetch api.github.com。
 *   桌面版的页面来自 http://127.0.0.1，cross-origin 请求会走 CORS 预检，
 *   而且部分环境（企业代理 / 国产浏览器内核）会直接拦掉。
 *
 *   所以这里把「所有非同源请求」改道到 Python 桥：
 *   JS → pywebview.api.http_request → Python urllib → GitHub
 *
 *   好处：
 *     1. 完全没有 CORS 预检
 *     2. 网络行为由 Python 统一控制（重试 / 超时 / 编码）
 *     3. 前端代码一行不改（只覆盖 window.fetch）
 *
 * ★ 同源请求（本地 css/js/图片）必须放行 —— 交给原生 fetch。
 * ============================================================ */
(function () {
    'use strict';

    if (!window.pywebview) return;          // 不在桌面环境里，什么都不做
    window.__GDPY__ = { desktop: true };

    var origFetch = window.fetch.bind(window);

    function isSameOrigin(url) {
        try {
            var u = new URL(url, location.href);
            return u.origin === location.origin;
        } catch (e) {
            return false;                    // 解析不了就当同源，交给原生
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

    /**
     * 把 Python 返回的结果包装成真正的 Response
     * —— 前端代码里所有 .json() / .text() / .blob() / .headers.get() 都还能用
     */
    function makeResponse(res) {
        var status = res.status || 0;
        // ★ 204/304 不允许有 body —— 带 body 构造 Response 会抛 TypeError
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
                // Blob 读不了（异步），只能交给原生
                return origFetch(input, init);
            } else {
                body = btoa(unescape(encodeURIComponent(String(b))));
            }
        }

        // ★ signal（AbortSignal）无法跨桥传递，超时由 Python 侧统一控制
        return window.pywebview.api.http_request({
            method: method,
            url: url,
            headers: headers,
            body_b64: body
        }).then(makeResponse);
    };

    /* ============================================================
     * 桌面原生能力（网页版没有 window.pywebview，这些调用会自然失败）
     * ============================================================ */
    window.gdpy = {
        /** 打开系统文件选择框，返回路径数组（取消返回 []） */
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
        /** 读本地文件，返回 base64 */
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
