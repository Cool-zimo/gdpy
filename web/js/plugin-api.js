/* ==================================================================
   plugin-api.js —— 给插件用的宿主接口
   ------------------------------------------------------------------
   用户要求："给插件提供更多的接口"

   ★ 现状：插件（iframe）只能拿 token，别的什么都做不了。
     于是插件只能自己再走一遍 GitHub API —— 把宿主已有的能力重做一遍，
     而且 token 还得再传一次，暴露面更大。

   ★ 三条原则：
     1) 插件拿不到原始 token。所有需鉴权的操作由宿主代做。
        token 一旦进 iframe，任何插件脚本都能读走 —— 这是最大风险点。
     2) 来源校验。只接受插件 iframe 发来的消息，其他来源一律丢弃。
     3) 按需授权。插件声明要用的能力，没声明的直接拒绝。
        默认只给只读能力，写操作必须显式声明。

   ★ 通信方式：postMessage + requestId 配对（沿用 extension.js 的约定），
     插件侧用 await 就能拿到结果，不用自己写回调。
   ================================================================== */
(function (root) {
    'use strict';

    var API_VERSION = 1;

    /* 能力表：name → 是否属于"写"操作 */
    var CAPS = {
        'files.list':      false,
        'files.read':      false,
        'files.stat':      false,
        'files.write':     true,
        'files.delete':    true,
        'files.upload':    true,
        'shares.create':   true,
        'shares.list':     false,
        'repo.info':       false,
        'repo.usage':      false,
        'ui.toast':        false,
        'ui.close':        false,
        'ui.navigate':     false,
        'state.get':       false,
        'state.set':       true,
        'api.request':     true    // 代发 GitHub API，风险最高，需显式声明
    };

    /* 已注册的插件：origin → {caps, frame} */
    var registry = {};
    /* 默认给未声明的插件的最小能力 */
    var DEFAULT_CAPS = ['files.list', 'files.read', 'repo.info', 'ui.toast'];

    function normOrigin(o) {
        try { return new URL(o).origin; } catch (e) { return null; }
    }

    /**
     * 注册一个插件 iframe。
     * @param {HTMLIFrameElement} frame 插件的 iframe
     * @param {string[]} caps           声明的能力；不传则只给只读最小集
     */
    function register(frame, caps) {
        if (!frame || !frame.src) return false;
        var o = normOrigin(frame.src);
        if (!o) return false;
        registry[o] = {
            caps: (Array.isArray(caps) && caps.length ? caps : DEFAULT_CAPS).filter(function (c) {
                return Object.prototype.hasOwnProperty.call(CAPS, c);
            }),
            frame: frame
        };
        return true;
    }

    function unregister(frame) {
        if (!frame || !frame.src) return;
        var o = normOrigin(frame.src);
        if (o) delete registry[o];
    }

    function allowed(origin, cap) {
        var r = registry[origin];
        if (!r) return false;
        return r.caps.indexOf(cap) >= 0;
    }

    function fail(msg) { return Promise.reject(new Error(msg)); }

    /* ---------- 能力实现：全部复用宿主已有的模块 ---------- */

    function filesList() {
        var fm = root.app && root.app.fileManager;
        if (!fm) return fail('宿主页文件管理器未就绪');
        return Promise.resolve(fm.getCurrentFiles ? (fm.getCurrentFiles() || []) : [])
            .then(function (list) {
                // ★ 只回传结构化字段，不把内部对象整个丢过去
                return (list || []).map(function (f) {
                    return {
                        name: f.name, path: f.path,
                        type: f.type || (f.isFolder ? 'folder' : 'file'),
                        size: f.size || 0,
                        modified: f.modified || f.updatedAt || null
                    };
                });
            });
    }

    function filesRead(p) {
        var fm = root.app && root.app.fileManager;
        if (!fm) return fail('宿主页文件管理器未就绪');
        if (!p || !p.path) return fail('缺少 path');
        var fn = fm.readFile || fm.getFileContent || fm.downloadFile;
        if (!fn) return fail('宿主不支持读取文件');
        return Promise.resolve(fn.call(fm, p.path));
    }

    function filesWrite(p) {
        var fm = root.app && root.app.fileManager;
        if (!fm) return fail('宿主页文件管理器未就绪');
        if (!p || !p.path) return fail('缺少 path');
        var fn = fm.writeFile || fm.saveFile || fm.uploadText;
        if (!fn) return fail('宿主不支持写入文件');
        return Promise.resolve(fn.call(fm, p.path, p.content == null ? '' : p.content));
    }

    function filesDelete(p) {
        var fm = root.app && root.app.fileManager;
        if (!fm) return fail('宿主页文件管理器未就绪');
        if (!p || !p.path) return fail('缺少 path');
        var fn = fm.deleteFile || fm.removeFile;
        if (!fn) return fail('宿主不支持删除文件');
        return Promise.resolve(fn.call(fm, p.path));
    }

    function repoInfo() {
        var st = root.app && root.app.storage;
        if (!st) return fail('宿主存储模块未就绪');
        return Promise.resolve({
            repos: st.getAllRepos ? (st.getAllRepos() || []) : [],
            current: st.getCurrentRepo ? st.getCurrentRepo() : null
        });
    }

    function uiToast(p) {
        if (root.ui && root.ui.showToast) {
            root.ui.showToast(String(p && p.message || ''), (p && p.level) || 'info');
            return Promise.resolve(true);
        }
        return fail('宿主不支持提示');
    }

    function uiNavigate(p) {
        if (root.ui && root.ui.switchView && p && p.view) {
            root.ui.switchView(p.view);
            return Promise.resolve(true);
        }
        return fail('宿主不支持切换视图');
    }

    function stateGet(p) {
        var st = root.app && root.app.storage;
        if (!st || !st.get) return fail('宿主存储模块未就绪');
        return Promise.resolve(st.get(p && p.key, null));
    }

    function stateSet(p) {
        var st = root.app && root.app.storage;
        if (!st || !st.set) return fail('宿主存储模块未就绪');
        if (!p || !p.key) return fail('缺少 key');
        return Promise.resolve(st.set(p.key, p.value));
    }

    /**
     * 代发 GitHub API —— 风险最高的一项。
     * ★ 必须声明才能用，且只允许相对路径（"/user"），
     *   不给完整 URL：否则插件可以拿宿主的 token 去打任意站点。
     */
    function apiRequest(p, ctx) {
        var api = root.GitHubAPI || (root.app && root.app.github);
        if (!api) return fail('宿主 API 模块未就绪');
        if (!p || !p.path) return fail('缺少 path');
        if (!/^\//.test(p.path)) return fail('只允许相对路径，不接受完整 URL');
        if (p.url) return fail('不接受自定义 url 字段');
        var method = (p.method || 'GET').toUpperCase();
        if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) < 0) {
            return fail('不支持的请求方法: ' + method);
        }
        var fn = api.request || api.call || api.fetch;
        if (!fn) return fail('宿主 API 不支持通用请求');
        return Promise.resolve(fn.call(api, method, p.path, p.body));
    }

    var IMPL = {
        'files.list': filesList,
        'files.read': filesRead,
        'files.stat': filesRead,
        'files.write': filesWrite,
        'files.delete': filesDelete,
        'repo.info': repoInfo,
        'ui.toast': uiToast,
        'ui.navigate': uiNavigate,
        'state.get': stateGet,
        'state.set': stateSet,
        'api.request': apiRequest
    };

    function dispatch(cap, params, ctx) {
        var fn = IMPL[cap];
        if (!fn) return fail('能力未实现: ' + cap);
        try {
            return Promise.resolve(fn(params || {}, ctx));
        } catch (e) {
            return fail(String((e && e.message) || e));
        }
    }

    /* ---------- 消息通道 ---------- */

    function onMessage(e) {
        var d = e.data;
        if (!d || d.source !== 'gd-plugin') return;
        if (!e.source || !e.origin) return;

        var reqId = d.requestId;
        var cap = d.cap;

        function reply(ok, data, err) {
            try {
                e.source.postMessage({
                    source: 'gd-host',
                    requestId: reqId,
                    ok: ok,
                    data: data,
                    error: err ? String(err) : null
                }, e.origin);
            } catch (err2) { /* 插件已关闭，忽略 */ }
        }

        // 握手：插件问宿主在不在、有什么能力
        if (d.type === 'hello') {
            var r = registry[e.origin];
            reply(true, {
                apiVersion: API_VERSION,
                caps: r ? r.caps : DEFAULT_CAPS,
                registered: !!r
            });
            return;
        }

        if (!cap) { reply(false, null, '缺少 cap'); return; }
        if (!Object.prototype.hasOwnProperty.call(CAPS, cap)) {
            reply(false, null, '未知能力: ' + cap); return;
        }
        if (!allowed(e.origin, cap)) {
            reply(false, null, '插件未声明该能力: ' + cap); return;
        }

        dispatch(cap, d.params, { origin: e.origin })
            .then(function (data) { reply(true, data); })
            .catch(function (err) { reply(false, null, (err && err.message) || err); });
    }

    function init() {
        root.addEventListener('message', onMessage);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    root.GdPluginAPI = {
        register: register,
        unregister: unregister,
        caps: CAPS,
        defaultCaps: DEFAULT_CAPS,
        version: API_VERSION,
        /* 给插件的接入说明，宿主里也能直接打出来看 */
        describe: function () {
            return Object.keys(CAPS).map(function (c) {
                return c + (CAPS[c] ? '  [写]' : '  [读]');
            });
        }
    };
})(typeof window !== 'undefined' ? window : this);
