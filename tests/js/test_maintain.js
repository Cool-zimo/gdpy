const M = require('../../web/js/maintain.js');
const {Maintain, shortenName, dedupeName, BREADCRUMB_MAX, BREADCRUMB_ROOT_LABEL} = M;
let pass=0, fail=0;
const ck=(l,c,e)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l+' '+String(e||'')));};

function fakeStorage(vfs, repos){
  return {_vfs:vfs, getVFS(){return this._vfs;}, setVFS(v){this._vfs=v;}, getRepos(){return repos;}};
}
function fakeApi(trees){
  return {getTree: async (o,r,br,rec)=>{
    const k=o+'/'+r;
    if(!(k in trees)) throw new Error('404 '+k);
    return {tree: trees[k].map(b=>({path:b[0],size:b[1],sha:b[2]||'s',type:'blob'}))};
  }};
}

(async()=>{
console.log('【1】孤儿检测');
{
  const vfs={files:{'/drive_home/a.txt':{chunks:[{owner:'o',repo:'r1',path:'c1',size:100}]}},folders:{}};
  const st=fakeStorage(vfs,[{owner:'o',repo:'r1',branch:'main'}]);
  const rep=await new Maintain(fakeApi({'o/r1':[['c1',100],['c2',200]]}),st).scan();
  ck('孤儿 1 个',rep.orphans.length===1,rep.orphans.length);
  ck('孤儿是 c2',rep.orphans[0].path==='c2');
  ck('孤儿字节',rep.orphan_bytes===200);
  ck('幽灵 0',rep.ghosts.length===0);
  ck('统计字段 file_count',rep.file_count===1);
  ck('统计字段 recorded_bytes',rep.recorded_bytes===100);
  ck('统计字段 actual_bytes',rep.actual_bytes===300);
}

console.log('\n【2】幽灵检测');
{
  const vfs={files:{'/drive_home/a.txt':{chunks:[{owner:'o',repo:'r1',path:'gone',size:100}]}},folders:{}};
  const st=fakeStorage(vfs,[{owner:'o',repo:'r1',branch:'main'}]);
  const rep=await new Maintain(fakeApi({'o/r1':[['c1',100]]}),st).scan();
  ck('幽灵 1 个',rep.ghosts.length===1,rep.ghosts);
  ck('幽灵 vpath 对',rep.ghosts[0].vpath==='/drive_home/a.txt');
}

console.log('\n【3】★ 仓库扫失败不判幽灵（没扫到≠不存在）');
{
  const vfs={files:{'/drive_home/a.txt':{chunks:[{owner:'o',repo:'r1',path:'c1',size:100}]}},folders:{}};
  const st=fakeStorage(vfs,[{owner:'o',repo:'r1',branch:'main'}]);
  const api={getTree:async()=>{throw new Error('boom');}};
  const rep=await new Maintain(api,st).scan();
  ck('幽灵 0（不误判）',rep.ghosts.length===0,rep.ghosts.length);
  ck('错误被记录',rep.errors.length===1);
}

console.log('\n【4】★ 分片 path 含 / 不能误判');
{
  // path 含 / 时，不能用 '/' 拼 key，否则会错位
  const vfs={files:{'/drive_home/a.txt':{chunks:[{owner:'o',repo:'r1',path:'dir/sub/c1',size:50}]}},folders:{}};
  const st=fakeStorage(vfs,[{owner:'o',repo:'r1',branch:'main'}]);
  const rep=await new Maintain(fakeApi({'o/r1':[['dir/sub/c1',50]]}),st).scan();
  ck('孤儿 0',rep.orphans.length===0,rep.orphans.length);
  ck('幽灵 0',rep.ghosts.length===0,rep.ghosts.length);
}

console.log('\n【5】buildPlan：跳过隐藏文件、重名加序号');
{
  const m=new Maintain(null,fakeStorage({files:{},folders:{}},[]));
  const plan=m.buildPlan([
    {owner:'o',repo:'r1',path:'x/a.txt',size:10,sha:'s1',branch:'main'},
    {owner:'o',repo:'r1',path:'y/a.txt',size:20,sha:'s2',branch:'main'},
    {owner:'o',repo:'r1',path:'z/.gitkeep',size:0,sha:'s3',branch:'main'},
  ]);
  ck('两个文件入计划',Object.keys(plan.files).length===2);
  ck('★ 重名加序号',Object.keys(plan.files).some(p=>p.endsWith('a(1).txt')),Object.keys(plan.files));
  ck('★ 隐藏文件被跳过',plan.skipped.length===1&&plan.skipped[0].why.indexOf('隐藏')>=0);
  ck('标记 recovered',plan.files['/drive_home/_recovered/a.txt'].recovered===true);
  ck('chunks 含 branch',plan.files['/drive_home/_recovered/a.txt'].chunks[0].branch==='main');
}

console.log('\n【6】★ applyPlan 绝不覆盖已存在文件');
{
  const vfs={files:{'/drive_home/_recovered/a.txt':{name:'a.txt',type:'file',size:999}},folders:{}};
  const st=fakeStorage(vfs,[]);
  const m=new Maintain(null,st);
  const plan=m.buildPlan([{owner:'o',repo:'r1',path:'x/a.txt',size:10,sha:'s1',branch:'main'}]);
  const res=m.applyPlan(plan);
  ck('★ 冲突跳过',res.conflicts.length===1&&res.added.length===0);
  ck('★ 原文件未被覆盖',st.getVFS().files['/drive_home/_recovered/a.txt'].size===999);
}

console.log('\n【7】applyPlan 正常新增 + 建目录');
{
  const st=fakeStorage({files:{},folders:{}},[]);
  const m=new Maintain(null,st);
  const plan=m.buildPlan([{owner:'o',repo:'r1',path:'x/a.txt',size:10,sha:'s1',branch:'main'}]);
  const res=m.applyPlan(plan);
  ck('新增 1',res.added.length===1);
  ck('目录被建',!!st.getVFS().folders['/drive_home/_recovered']);
}

console.log('\n【8】面包屑截断与重名');
ck('短名不变',shortenName('abc')==='abc');
ck('★ 长名被截断',shortenName('a'.repeat(40)).length<40);
ck('★ 保留后缀',shortenName('a'.repeat(40)+'.txt').endsWith('.txt'));
ck('根标签是中文',BREADCRUMB_ROOT_LABEL==='网盘');
ck('折叠上限 5',BREADCRUMB_MAX===5);

console.log('\n【9】dedupeName');
{
  const used=new Set();
  ck('首次不加序号',dedupeName('a.txt',used)==='a.txt');
  ck('第二次 a(1).txt',dedupeName('a.txt',used)==='a(1).txt');
  ck('第三次 a(2).txt',dedupeName('a.txt',used)==='a(2).txt');
  ck('无扩展名也能加',dedupeName('README',used)==='README');
}

console.log('\n'+(fail?('★ 失败 '+fail+' 项'):('全部通过 '+pass+' 项')));
process.exit(fail?1:0);
})();
