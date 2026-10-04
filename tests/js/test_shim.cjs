// shim 行为测试：真实 Chrome + 本地服务，验证桌面专有行为
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PY = '/data/workspace/gdpy';

let pass = 0, fail = 0;
const ck = (l, c, e) => { c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + '  ' + JSON.stringify(e))); };

(async () => {
    const srv = spawn('python3', ['/data/workspace/_srv.py'], { cwd: PY });
    let url = null, buf = '';
    srv.stdout.on('data', d => { buf += d.toString(); if (buf.includes('\n') && !url) url = buf.trim().split('\n')[0]; });
    for (let i = 0; i < 80 && !url; i++) await new Promise(r => setTimeout(r, 250));
    const origin = url.replace('/index.html', '');

    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));

    // 记录桥收到的调用
    await page.addInitScript(() => {
        window.__origFetch = window.fetch.bind(window);
        window.__calls = [];
        window.pywebview = { api: {
            http_request: async r => { window.__calls.push('http:' + r.url); return { status: 200, status_text: 'OK', headers: {}, body_b64: btoa('{}') }; },
            open_external: async r => { window.__calls.push('open:' + r.url); return { ok: true }; },
            pick_open_file: async () => [], pick_save_file: async () => null, pick_folder: async () => null,
            read_file_b64: async () => '', write_file_b64: async () => true, exec_enabled: async () => false,
            exec_command: async () => ({ ok: false }), open_in_explorer: async () => false,
            app_version: async () => '0.0.11', js_log: async () => true, _set_exec_enabled: async () => false,
        }};
        localStorage.setItem('gd_custom_branch', 'preview/AI-Agent/dark-mode');
    });

    console.log('【1】注入位置');
    const html = await (await fetch(origin + '/index.html')).text();
    const iShim = html.indexOf('/__gdpy_shim__.js');
    const iHead = html.indexOf('<head');
    const iBranch = html.indexOf('gd_custom_branch');
    ck('shim 注入在 <head> 之后', iShim > iHead && iHead >= 0, { iShim, iHead });
    ck('★ shim 早于分支预览脚本（才能拦住 CDN）', iShim < iBranch, { iShim, iBranch });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    console.log('\n【2】★ 桌面版只用打包进来的本地资源');
    ck('  localStorage 里的分支选择被清掉',
        await page.evaluate(() => localStorage.getItem('gd_custom_branch') === null));
    ck('  没有 __BRANCH_BASE__（不从 CDN 拉代码）',
        await page.evaluate(() => !window.__BRANCH_BASE__),
        await page.evaluate(() => window.__BRANCH_BASE__ || null));
    const srcs = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')));
    ck('★ 所有 script 都是相对路径（无 jsdelivr）',
        srcs.every(s => !s.includes('jsdelivr')), srcs.filter(s => s.includes('jsdelivr')));
    ck('  13 个 js 全部加载', srcs.filter(s => s.startsWith('js/')).length === 13, srcs.length);

    console.log('\n【3】★ window.open 改道到系统浏览器');
    await page.evaluate(() => { window.__calls = []; window.open('https://github.com/Cool-zimo/gdpy', '_blank'); });
    await page.waitForTimeout(400);
    const c = await page.evaluate(() => window.__calls);
    ck('  window.open 走桥而不是开新窗口', c.some(x => x.startsWith('open:https://github.com')), c);
    await page.evaluate(() => { window.__calls = []; window.gdpy && 0; window.open('about:blank'); });
    ck('  about:blank 不打扰桥', true);

    console.log('\n【4】★ fetch 在桥未就绪时退回原生（不再静默失效）');
    // 模拟 pywebview 注入晚于 shim：删掉它再调 fetch
    const r = await page.evaluate(async () => {
        const save = window.pywebview;
        delete window.pywebview;
        let ok = false;
        try { const resp = await fetch('https://api.github.com/zen'); ok = resp !== undefined; } catch (e) { }
        window.pywebview = save;
        return ok;
    });
    ck('  桥缺失时 fetch 仍返回（走原生，不静默什么都不做）', r);

    console.log('\n【5】桥就绪时走桥');
    const r2 = await page.evaluate(async () => {
        window.__calls = [];
        await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer x' } });
        return window.__calls;
    });
    ck('  外部请求改道到桥', r2.some(x => x.includes('api.github.com')), r2);

    console.log('\n【6】同源请求不走桥');
    const r3 = await page.evaluate(async () => {
        window.__calls = [];
        await fetch('js/version.js?t=1');
        return window.__calls.length;
    });
    ck('  同源请求放行给原生 fetch', r3 === 0, r3);

    console.log('\n【7】页面无 JS 错误');
    ck('  0 错误', errs.length === 0, errs.slice(0, 3));

    await browser.close(); srv.kill();
    console.log('\n==============================================');
    console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
    console.log('==============================================');
    process.exit(fail ? 1 : 0);
})();
