const fs=require('fs'), vm=require('vm'), path=require('path');
const WEB=path.join(__dirname,'..','..','web','js');
const srcMaintain=fs.readFileSync(path.join(WEB,'maintain.js'),'utf8');
const srcFM=fs.readFileSync(path.join(WEB,'file-manager.js'),'utf8');

// Storage.normalizePath 的等价实现（与 storage.js 同形：补 /drive_home、去尾斜杠）
const Storage={ normalizePath(p){
  p=(p||'').trim();
  if(!p) return '/drive_home';
  if(!p.startsWith('/')) p='/'+p;
  if(!p.startsWith('/drive_home')) p='/drive_home'+p;
  if(p.length>1&&p.endsWith('/')) p=p.slice(0,-1);
  return p;
}};

const ctx={Storage,console,module:{}};
vm.createContext(ctx);
// ★ class/const 是词法声明，不会自动挂到 context 上，必须显式导出
vm.runInContext(srcMaintain + '\n;globalThis.__c={ROOT:BREADCRUMB_ROOT_LABEL,MAX:BREADCRUMB_MAX,ELL:BREADCRUMB_ELLIPSIS,shorten:shortenName};', ctx);
vm.runInContext(srcFM + '\n;globalThis.FileManager=FileManager;', ctx);

const fm=new ctx.FileManager({}, {});
let pass=0,fail=0;
const ck=(l,c,e)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l+' '+String(e||'')));};

console.log('【1】浅路径不折叠');
{
  const c=fm.getBreadcrumbs('/drive_home/a/b.txt');
  ck('3 段',c.length===3,c.map(x=>x.name));
  ck('根是网盘',c[0].name==='网盘');
  ck('末项是当前路径',c[2].path==='/drive_home/a/b.txt');
}

console.log('\n【2】★ 深路径折叠');
{
  const deep='/drive_home/a/b/c/d/e/f/g';
  const c=fm.getBreadcrumbs(deep);
  ck('★ 不超过 5 项',c.length<=5,c.length);
  ck('★ 保留根',c[0].name==='网盘');
  ck('★ 中间是省略号',c[1].name==='…',c[1].name);
  ck('★ 折叠项 path 为 null',c[1].path===null,c[1].path);
  ck('★ 末尾保留当前目录',c[c.length-1].path===deep,c[c.length-1].path);
}

console.log('\n【3】★ 长名截断');
{
  const long='d'+'i'.repeat(40);
  const c=fm.getBreadcrumbs('/drive_home/'+long+'/f.txt');
  const seg=c.find(x=>x.name.indexOf('…')>=0&&x.name.length>5);
  ck('★ 长段被截断',c.some(x=>x.name.includes('…')&&x.name.length<=24),c.map(x=>x.name.length));
  ck('截断后仍保留后缀信息',c[1].name.length<long.length);
}

console.log('\n【4】★ 边界：正好 5 段不折叠');
{
  const c=fm.getBreadcrumbs('/drive_home/a/b/c/d');   // 根+a+b+c+d = 5
  ck('5 段不折叠',c.length===5&&c[1].name==='a',c.map(x=>x.name));
}
{
  const c=fm.getBreadcrumbs('/drive_home/a/b/c/d/e'); // 6 段
  ck('★ 6 段折叠',c.length<6&&c[1].name==='…',c.map(x=>x.name));
}

console.log('\n【5】根节点单独');
{
  const c=fm.getBreadcrumbs('/drive_home');
  ck('只有根',c.length===1&&c[0].name==='网盘');
}

console.log('\n【6】源码级断言（防补丁被悄悄移除）');
ck('★ 源码含折叠逻辑',srcFM.includes('BREADCRUMB_MAX'));
ck('★ 源码调用 shortenName',srcFM.includes('shortenName(part)'));
ck('★ ui 渲染判空',fs.readFileSync(path.join(WEB,'ui.js'),'utf8')
    .includes("crumb.path !== null && crumb.path !== undefined"));

console.log('\n'+(fail?('★ 失败 '+fail):('全部通过 '+pass)));
process.exit(fail?1:0);
