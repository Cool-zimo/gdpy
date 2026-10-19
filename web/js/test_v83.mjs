/**
 * v0.0.83 跨账号归属校验测试
 *
 * 重点不是"渲染出来了"，而是：
 *   1. 读/删路径真的会拦下跨账号分片（而不是刷一串 401）
 *   2. 同账号完全不受影响（不能误伤）
 *   3. scanForeignFiles 只报告、purgeForeignFiles 只删本地索引
 */
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('./file-manager.js', import.meta.url), 'utf8');

// 最小 Storage stub —— 只需要 file-manager 用到的那几个方法
class StorageStub {
    constructor(vfs) { this.vfs = vfs; this.repos = []; this.user = { login: 'Feng-zimo' }; }
    getVFS() { return this.vfs; }
    setVFS(v) { this.vfs = v; }
    getUser() { return this.user; }
    setUser(u) { this.user = u; }
    getRepos() { return this.repos; }
    setRepos(r) { this.repos = r; }
    getStorageConfig() { return { maxRepoSize: 900 * 1024 * 1024 }; }
    subtractFromRepoUsage() {}
    addToRepoUsage() {}
    static normalizePath(p) { return p.startsWith('/drive_home') ? p : '/drive_home/' + p.replace(/^\//, ''); }
}

// api stub：任何请求都记录下来，用来验证"到底有没有发出去"
function makeApi(login) {
    const calls = [];
    return {
        calls,
        async getMe() { return { login }; },
        async getBlobBytes(o, r, s) { calls.push(['getBlobBytes', o, r, s]); return new Uint8Array([1]); },
        async getFileRaw() { return new Uint8Array([1]); },
        async getFileContents() { return { sha: 'x' }; },
        async deleteFile(o, r, p) { calls.push(['deleteFile', o, r, p]); return {}; },
    };
}

const ctx = vm.createContext({
    Storage: StorageStub, console,
    setTimeout, Date, Math, JSON, Promise, Array, Object, Error, Uint8Array,
});
vm.runInContext(src + '\n;globalThis.FileManager = FileManager;', ctx);
const FileManager = ctx.FileManager;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

const mkChunks = (owner) => [
    { owner, repo: 'drive-storage-x', path: 'a/1.bin', sha: 's1', branch: 'main', size: 10 },
];

console.log('\n=== 1. 读取路径：跨账号必须拦下 ===');
{
    const api = makeApi('Feng-zimo');
    const fm = new FileManager(api, new StorageStub({ files: {}, folders: {} }));
    let err = null;
    try { await fm._fetchChunks(mkChunks('Cool-zimo')); } catch (e) { err = e; }
    ok('抛错而不是静默 401', !!err);
    ok('错误里点名了真实归属', !!err && err.message.includes('Cool-zimo'), err?.message);
    ok('错误里点名了当前账号', !!err && err.message.includes('Feng-zimo'), err?.message);
    ok('错误里说明文件没丢', !!err && err.message.includes('没丢'), err?.message);
    ok('★ 一个请求都没发出去', api.calls.length === 0, '实际发了 ' + api.calls.length);
}

console.log('\n=== 2. 读取路径：同账号必须放行 ===');
{
    const api = makeApi('Feng-zimo');
    const fm = new FileManager(api, new StorageStub({ files: {}, folders: {} }));
    let err = null, res = null;
    try { res = await fm._fetchChunks(mkChunks('Feng-zimo')); } catch (e) { err = e; }
    ok('不抛错', !err, err?.message);
    ok('真的取到了分片', !!res && res.length === 1);
    ok('请求确实发出', api.calls.length === 1);
}

console.log('\n=== 3. 删除路径：跨账号必须拦下 ===');
{
    const api = makeApi('Feng-zimo');
    const st = new StorageStub({ files: {}, folders: {} });
    const fm = new FileManager(api, st);
    let err = null;
    try { await fm._cleanupOrphanChunks(mkChunks('Cool-zimo'), 'test'); } catch (e) { err = e; }
    ok('抛错', !!err);
    ok('★ 没有发出删除请求', api.calls.filter(c => c[0] === 'deleteFile').length === 0);
}

console.log('\n=== 4. deleteFile：跨账号必须拦下 ===');
{
    const api = makeApi('Feng-zimo');
    const vfs = { files: { '/drive_home/x.jpg': { name: 'x.jpg', size: 10, chunks: mkChunks('Cool-zimo') } }, folders: {} };
    const st = new StorageStub(vfs);
    st.getFile = (p) => vfs.files[p];
    const fm = new FileManager(api, st);
    let err = null;
    try { await fm.deleteFile('/drive_home/x.jpg'); } catch (e) { err = e; }
    ok('抛错', !!err);
    ok('没发删除请求', api.calls.length === 0);
    ok('★ VFS 条目还在（拦下时不能顺手删索引）', !!vfs.files['/drive_home/x.jpg']);
}

console.log('\n=== 5. scanForeignFiles 只报告不改动 ===');
{
    const api = makeApi('Feng-zimo');
    const vfs = {
        files: {
            '/drive_home/a.jpg': { name: 'a.jpg', size: 1, chunks: mkChunks('Cool-zimo') },
            '/drive_home/b.jpg': { name: 'b.jpg', size: 1, chunks: mkChunks('Feng-zimo') },
            '/drive_home/c.jpg': { name: 'c.jpg', size: 1, chunks: mkChunks('Cool-zimo') },
        }, folders: {}
    };
    const fm = new FileManager(api, new StorageStub(vfs));
    const r = await fm.scanForeignFiles();
    ok('me 正确', r.me === 'Feng-zimo', r.me);
    ok('识别出 2 项外来', r.foreign.length === 2, String(r.foreign.length));
    ok('识别的名字对', r.foreign.map(f => f.name).sort().join(',') === 'a.jpg,c.jpg');
    ok('★ 扫描后 VFS 条目数不变', Object.keys(vfs.files).length === 3);
}

console.log('\n=== 6. purgeForeignFiles 只删本地索引 ===');
{
    const api = makeApi('Feng-zimo');
    const vfs = {
        files: {
            '/drive_home/a.jpg': { name: 'a.jpg', size: 1, chunks: mkChunks('Cool-zimo') },
            '/drive_home/b.jpg': { name: 'b.jpg', size: 1, chunks: mkChunks('Feng-zimo') },
            '/drive_home/c.jpg': { name: 'c.jpg', size: 1, chunks: mkChunks('Cool-zimo') },
        }, folders: {}
    };
    const fm = new FileManager(api, new StorageStub(vfs));
    const r = await fm.purgeForeignFiles();
    ok('清理了 2 项', r.removed === 2, String(r.removed));
    ok('★ 自己的文件还在', !!vfs.files['/drive_home/b.jpg']);
    ok('★ 外来的两个没了', !vfs.files['/drive_home/a.jpg'] && !vfs.files['/drive_home/c.jpg']);
    ok('★ 全程零网络请求', api.calls.length === 0, '发了 ' + api.calls.length);
}

console.log('\n=== 7. 边界：空分片 / 无 owner 不误伤 ===');
{
    const api = makeApi('Feng-zimo');
    const fm = new FileManager(api, new StorageStub({ files: {}, folders: {} }));
    let err = null;
    try { await fm._guardChunks([], '读取'); await fm._guardChunks(null, '读取'); } catch (e) { err = e; }
    ok('空/null 不抛错', !err, err?.message);
    let err2 = null;
    try { await fm._guardChunks([{ owner: null, repo: 'r', path: 'p' }], '读取'); } catch (e) { err2 = e; }
    ok('owner 缺失时不拦（避免误伤老数据）', !err2, err2?.message);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
