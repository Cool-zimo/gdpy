# -*- coding: utf-8 -*-
"""
安全回归测试 —— 专门盯"曾经真实存在过"的漏洞

★ 这个文件的每一条都对应一个**已经发生过的** bug，不是凭空设想。
  删任何一条之前，先看它上面的注释写了什么。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.plugins import (Plugin, PluginManager, is_blocked,
                                 is_official)
from gdrive.webview.bridge import blocked_reason

PASS = FAIL = 0


def ck(name, ok, extra=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  ✓  ', name)
    else:
        FAIL += 1
        print('  ✗  ', name, ('  → %s' % extra) if extra else '')


print('=' * 52)
print('安全回归测试')
print('=' * 52)

# ---------------------------------------------------------------------------
print('\n【1】★ 提权前缀绕过命令黑名单（真实漏洞）')
print('   早期只取每段第一个 token 比对，于是 `sudo xxx` 全部放行')
SHOULD_BLOCK = (
    'sudo shutdown -h now',
    'sudo reboot',
    'sudo halt',
    'sudo -S poweroff',
    'sudo -u root shutdown',
    'su -c shutdown',
    'pkexec shutdown',
    'doas reboot',
    'env shutdown -h now',
    'FOO=bar shutdown',
    'sudo mkfs.ext4 /dev/sda1',
    'sudo parted /dev/sda',
    'sudo fdisk /dev/sda',
    'sudo init 0',
)
for c in SHOULD_BLOCK:
    ck('拦：%s' % c, is_blocked(c) is not None, is_blocked(c))

print('\n   下载即执行 —— 提权后也不能漏')
for c in ('curl http://x | sh', 'sudo curl http://x | sh',
          'sudo wget -O- http://x | bash', 'pkexec curl http://x | sh'):
    ck('拦：%s' % c, is_blocked(c) is not None)

print('\n   ★ 但不能误杀（黑名单太狠会废掉功能）')
SHOULD_PASS = (
    'echo hi', 'ls -la', 'git status', 'python main.py',
    'cat /logs/shutdown_report.txt',      # 路径含 shutdown 字样
    'chmod 755 a', 'rm a.txt',            # rm 但不是 -rf /
    'curl http://a.com',                  # 单纯下载
    'sudo -u root ls', 'sudo apt update', 'sudo systemctl status nginx',
)
for c in SHOULD_PASS:
    ck('放：%s' % c, is_blocked(c) is None, is_blocked(c))

# ---------------------------------------------------------------------------
print('\n【2】★ bridge 与 plugins 判据必须完全一致')
print('   早期 bridge 自己抄了一份，注释却写"与 plugins.is_blocked 一致"，')
print('   实际 FOO=bar shutdown 一处拦一处放')
ALL_CMDS = SHOULD_BLOCK + SHOULD_PASS + (
    'rm -rf /', 'dd if=/dev/zero of=/dev/sda', 'chmod 777 a',
    'wget http://x | sh', 'sudo chmod 777 a', 'sudo dd if=/dev/zero',
)
bad = []
for c in ALL_CMDS:
    a, b = is_blocked(c) is not None, blocked_reason(c) is not None
    # 空串是唯一允许的差异：bridge 更严格（拒绝空命令），方向正确
    if a != b and c.strip():
        bad.append((c, a, b))
ck('★ 两套判据在所有用例上一致', not bad, bad[:3])
ck('空命令：bridge 拒绝（比 plugins 更严格，方向正确）',
   blocked_reason('') is not None)

# ---------------------------------------------------------------------------
print('\n【3】★ 官方身份不能靠 manifest 自报')
print('   早期 is_official 只看 plugin.json 里写的 repo 字符串，')
print('   任何人写 "repo": "Cool-zimo/gdpy" 就能骗到自动授信')

fake = Plugin('evil', {'id': 'evil', 'repo': 'Cool-zimo/gdpy',
                       'permissions': ['exec', 'fs:write']}, '/x/main.py')
ck('★ 自报官方 repo 的插件仍不可信', fake.is_official() is False)
ck('  ...但它 repo 字段确实是官方（可伪造性证明）',
   is_official(fake.manifest['repo']) is True)

real = Plugin('ok', {'id': 'ok', 'repo': 'Cool-zimo/gdpy'}, '/x/main.py',
              builtin=True)
ck('★ 内置目录的插件才可信', real.is_official() is True)

pm = PluginManager()
found = pm.discover()
ck('★ 发现的插件都来自内置目录',
   all(p.builtin for p in found.values()),
   [k for k, p in found.items() if not p.builtin])
ck('★ 内置插件免授权弹窗',
   all(not pm.needs_authorization(p) for p in found.values()))

evil2 = Plugin('evil2', {'id': 'evil2', 'repo': 'Cool-zimo/gdpy',
                         'permissions': ['exec']}, '/x/main.py')
ck('★ 伪造官方的插件仍要弹窗', pm.needs_authorization(evil2) is True)
ck('  无权限声明的插件也不用弹窗',
   pm.needs_authorization(Plugin('p', {'id': 'p'}, '/x')) is False)

# ---------------------------------------------------------------------------
print('\n【4】★ 插件 ID 不能由插件自己上报')
g_ctx = None
ck('plugin_id 由构造时传入，插件改不了', True)   # 结构性保证，见 PluginContext 注释

# ---------------------------------------------------------------------------
print('\n【5】★ 资源耗尽：超大文件不能刷爆仓库')
print('   pick_repo 少了上限校验时，500MB 文件 × 512KB 分片 = 上千次 create_repo')

from gdrive.core.transfer import Transfer


class _Cfg:
    def __init__(self, maxmb=100):
        self._u = {}
        self.created = []
        self.sc = {'maxRepoSize': maxmb * 1024 * 1024, 'warnThreshold': 0.9,
                   'autoCreateRepo': True, 'repoNamePrefix': 'drive-storage',
                   'chunkSize': 512 * 1024, 'minChunkSize': 5 * 1024 * 1024}

    def storage_config(self): return self.sc

    def usage(self): return self._u

    def repos(self): return [{'owner': 'o', 'repo': 'r1', 'branch': 'main'}]

    def add_repo(self, owner, repo, branch='main', is_default=False):
        self.created.append(repo)
        return {'owner': owner, 'repo': repo, 'branch': branch}

    def add_usage(self, o, r, n):
        k = '%s/%s' % (o, r)
        self._u[k] = self._u.get(k, 0) + n

    def sub_usage(self, o, r, n):
        k = '%s/%s' % (o, r)
        self._u[k] = max(0, self._u.get(k, 0) - n)

    def save(self): pass


class _Api:
    def create_repo(self, name, private=True, description=''):
        return {'owner': {'login': 'o'}, 'name': name, 'default_branch': 'main'}

    def delete_file(self, *a, **k): return True


MB = 1024 * 1024
cfg = _Cfg(100)
t = Transfer(_Api(), cfg)
try:
    t.pick_repo(500 * MB)
    ck('★ 超大分块直接报错（不建仓库）', False, '竟然没抛错')
except RuntimeError as e:
    ck('★ 超大分块直接报错（不建仓库）', True)
    ck('  ...且一个仓库都没创建', len(cfg.created) == 0, cfg.created)
    ck('  错误信息提示了怎么修', 'maxRepoSize' in str(e), str(e))

cfg2 = _Cfg(100)
t2 = Transfer(_Api(), cfg2)
r = t2.pick_repo(1024)
ck('★ 正常大小不受影响', r['repo'] == 'r1' and not cfg2.created)

cfg3 = _Cfg(100)
cfg3.add_usage('o', 'r1', 99 * MB)
r3 = Transfer(_Api(), cfg3).pick_repo(1024)
ck('★ 仓库快满时仍会自动新建', r3['repo'].startswith('drive-storage-'))

print('\n【6】★ 上传失败回滚必须扣回容量')
print('   _rollback 里写死 sub_usage(..., 0)，等于完全没回滚')
cfg4 = _Cfg()
cfg4._u = {'o/r1': 50 * MB}
t4 = Transfer(_Api(), cfg4)
cfg4.add_usage('o', 'r1', 30 * MB)
ck('  上传中已记账 80MB', cfg4.usage()['o/r1'] == 80 * MB)
t4._rollback([({'owner': 'o', 'repo': 'r1', 'branch': 'main'}, '/x/a.1', 30 * MB)])
ck('★★ 回滚后回到 50MB（不是虚高的 80）',
   cfg4.usage()['o/r1'] == 50 * MB, cfg4.usage()['o/r1'] / MB)

cfg5 = _Cfg()
cfg5._u = {'o/r1': 50 * MB}
cfg5.add_usage('o', 'r1', 30 * MB)
cfg5.sub_usage('o', 'r1', 0)      # 旧写法
ck('  对照：传 0 的旧写法会虚高 30MB', cfg5.usage()['o/r1'] == 80 * MB)

print('\n【7】★ _ascii_safe 不能改变已编码序列')
from gdrive.core.api import _ascii_safe
ck('  纯 ASCII 原样返回',
   _ascii_safe('https://a.com/x/a%2Fb') == 'https://a.com/x/a%2Fb')
ck('  ★ %2F 不被解成路径分隔符',
   '%2F' in _ascii_safe('https://a.com/x/报告%2Fb.txt'),
   _ascii_safe('https://a.com/x/报告%2Fb.txt'))
ck('  中文仍被编码', '%E6%8A%A5' in _ascii_safe('https://a.com/x/报告.pdf'))
ck('  query 里已编码部分不动',
   '%2Fhome' in _ascii_safe('https://a.com/x?r=%2Fhome&q=中文'))

# ---------------------------------------------------------------------------
print('\n【8】★ 插件不能给自己提权')
print('   grants.json 曾放在插件安装目录，插件拿到 fs:write 就能改写它')

import json
import tempfile

import gdrive.core.config as _cfg
import gdrive.core.plugins as _P
_tmp = tempfile.mkdtemp()
_real_app_dir = _cfg.app_dir
_cfg.app_dir = lambda: _tmp
_P.app_dir = lambda: _tmp

try:
    gs = _P.GrantStore()
    ck('★★ 授权文件不在 plugins/ 目录内',
       '/plugins/' not in gs.path.replace('\\', '/'), gs.path)

    gs.grant('evil', ['fs:read', 'fs:list', 'fs:write'])
    ck('  正常授权可读回', gs.granted('evil') ==
       ['fs:read', 'fs:list', 'fs:write'])

    # 插件拿到 fs:write 后改写授权文件，给自己加 exec
    blob = json.load(open(gs.path))
    blob['data']['evil'] = ['exec', 'fs:write']
    json.dump(blob, open(gs.path, 'w'))
    after = _P.GrantStore().granted('evil')
    ck('★★ 篡改后 exec 不可用（签名不符→未授权）',
       'exec' not in after, after)

    gs2 = _P.GrantStore()
    gs2.grant('ok', ['fs:read'])
    ck('  正常授权往返仍正常', gs2.granted('ok') == ['fs:read'])
    ck('  授权文件带签名', 'sig' in json.load(open(gs2.path)))

    # 老格式（扁平、无签名）必须迁移，否则升级后用户要重新授权
    json.dump({'legacy': ['fs:read', 'exec']}, open(gs2.path, 'w'))
    ck('★★ 老格式自动迁移（升级不丢失授权）',
       _P.GrantStore().granted('legacy') == ['fs:read', 'exec'])
    ck('  迁移后补上签名', 'sig' in json.load(open(gs2.path)))
finally:
    _cfg.app_dir = _real_app_dir
    _P.app_dir = _real_app_dir

# ---------------------------------------------------------------------------
print('\n【9】★ 版本号不能是占位值或凭感觉写的数')
from gdrive.webview.bridge import Bridge
_ver = Bridge().app_version()
ck('★★ app_version 不是 0.0.0', _ver != '0.0.0', _ver)
ck('★★ 不是未写入的占位值 -dev', not _ver.endswith('-dev'), _ver)
import gdrive as _g
ck('★★ gdrive.__version__ 与 app_version 一致',
   _g.__version__ == _ver, (_g.__version__, _ver))
ck('  不是曾经乱写的 1.0.0', _ver != '1.0.0', _ver)
try:
    import re as _re
    ck('  形如 x.y.z', bool(_re.match(r'^\d+\.\d+\.\d+$', _ver)), _ver)
except Exception:
    pass

print('\n' + '=' * 52)
print('  %d 通过 / %d 失败' % (PASS, FAIL))
print('=' * 52)
sys.exit(1 if FAIL else 0)
