"""配置同步兼容性测试 —— 重点是写入不能破坏网页版配置"""
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core.config_sync import (ConfigSync, normalize_usage,
                                     denormalize_usage, CONFIG_REPO, CONFIG_FILE)

passed = failed = 0
def ck(label, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1; print('  ✓ ' + label)
    else:
        failed += 1; print('  ✗ ' + label + '  ' + str(extra))


class FakeAPI:
    """模拟 GitHub：只保留 config.json 一个文件"""
    def __init__(self, initial=None):
        self.store = {'content': initial, 'sha': 'sha1'}
        self.n_put = 0
        self.n_get = 0

    def get_file(self, owner, repo, path, ref='main'):
        self.n_get += 1
        assert repo == CONFIG_REPO and path == CONFIG_FILE, '路径不对'
        if self.store['content'] is None:
            raise IOError('404')
        return dict(self.store)

    def put_file(self, owner, repo, path, content, message, sha=None, **kw):
        import base64, json
        if sha is not None and sha != self.store.get('sha'):
            raise type('E', (Exception,), {'status': 409})()
        self.n_put += 1
        self.store = {'content': base64.b64encode(
            content if isinstance(content, bytes) else content.encode()
        ).decode(), 'sha': 'sha%d' % (self.n_put + 1)}
        return {}

    def get_repo(self, owner, repo):
        raise IOError('no repo')

    def create_repo(self, name, private=True, description=''):
        return {}


def load(api):
    import base64, json
    return json.loads(base64.b64decode(api.store['content']).decode('utf-8'))


def dump(obj):
    import base64, json
    return base64.b64encode(
        json.dumps(obj, ensure_ascii=False).encode('utf-8')).decode()


print('【1】repoUsage 格式归一化（★ 不归一化会 TypeError 崩溃）')
ck('web 版 {size:..} → int',
   normalize_usage({'o/r': {'size': 123, 'updatedAt': 'x'}}) == {'o/r': 123})
ck('本模块 int 原样', normalize_usage({'o/r': 7}) == {'o/r': 7})
ck('★ 字符串数字能读', normalize_usage({'o/r': '42'}) == {'o/r': 42})
ck('★ 脏数据变 0 不崩', normalize_usage({'o/r': None, 'b': []}) == {'o/r': 0, 'b': 0})
ck('★ 负数归零', normalize_usage({'o/r': -5}) == {'o/r': 0})
ck('非 dict 返回空', normalize_usage(None) == {})
ck('写回是 web 格式',
   denormalize_usage({'o/r': 5})['o/r']['size'] == 5)
ck('★ 往返一致（写回后还能读回来）',
   normalize_usage(denormalize_usage({'o/r': 5})) == {'o/r': 5})

print('\n【2】读网页版写的文件')
web_cfg = {
    'version': 1,
    'updatedAt': '2026-01-01T00:00:00Z',
    'repos': [{'owner': 'me', 'repo': 'drive-storage-x'}],
    'fileIndex': {'files': {'/drive_home/a.txt': {'name': 'a.txt', 'size': 10}},
                  'folders': {}},
    'starred': ['/drive_home/a.txt'],
    'recent': ['x'],
    'shares': [{'repoName': 'gd-share-ab'}],
    'repoUsage': {'me/drive-storage-x': {'size': 999, 'updatedAt': 'y'}},
    'storageConfig': {'chunkSize': 512 * 1024},
}
api = FakeAPI(dump(web_cfg))
cs = ConfigSync(api); cs.owner = 'me'
got = cs.pull()
ck('★ 认出 fileIndex（不是 vfs）', got['vfs'] is not None)
ck('  文件读到了', '/drive_home/a.txt' in (got['vfs'] or {}).get('files', {}))
ck('★ repoUsage 对象格式不崩', got['usage'] == {'me/drive-storage-x': 999})
ck('repos 读到', got['repos'] is not None)
ck('shares 读到', got['shares'] is not None)
ck('storageConfig 读到', got['storageConfig'] is not None)

print('\n【3】★ 写入不能破坏网页版的其他字段')
# ★ 不再用 VFS 类（v0.0.10 已删）：直接构造与 web 版同形的 dict
_vfs = dict(got['vfs'] or {})
_files = dict(_vfs.get('files') or {})
_files['/drive_home/b.txt'] = {
    'name': 'b.txt', 'type': 'file', 'size': 20,
    'chunks': [{'path': 'c/1'}],
}
_vfs['files'] = _files
ok = cs.push(vfs=_vfs, usage={'me/drive-storage-x': 1019})
ck('push 成功', ok)
after = load(api)
for k in ('repos', 'starred', 'recent', 'shares', 'storageConfig', 'version'):
    ck('  保留 %s' % k, k in after, after.keys())
ck('★ fileIndex 被更新', '/drive_home/b.txt' in after['fileIndex']['files'])
ck('★ usage 写成 web 格式（web 版能读）',
   after['repoUsage']['me/drive-storage-x']['size'] == 1019)
ck('★ 原 usage 没被平白清零',
   after['repoUsage']['me/drive-storage-x']['size'] != 0)

print('\n【4】★ 向后兼容：本模块旧版写的 vfs 也能读')
old = {'vfs': {'files': {'/drive_home/old.txt': {'name': 'o', 'size': 1}},
               'folders': {}}}
api2 = FakeAPI(dump(old))
cs2 = ConfigSync(api2); cs2.owner = 'me'
g2 = cs2.pull()
ck('vfs 别名能读出来', g2['vfs'] is not None and
   '/drive_home/old.txt' in g2['vfs']['files'])

print('\n【5】仓库/文件不存在时不崩')
api3 = FakeAPI(None)
cs3 = ConfigSync(api3); cs3.owner = 'me'
g3 = cs3.pull()
ck('返回 vfs=None 而非抛异常', g3['vfs'] is None)
ck('usage 是空 dict', g3['usage'] == {})

print('\n【6】409 冲突重试后合并成功')
api4 = FakeAPI(dump(web_cfg))
cs4 = ConfigSync(api4); cs4.owner = 'me'
# 模拟并发：push 前远端被改了 sha
orig_get = api4.get_file
def racing_get(*a, **k):
    r = orig_get(*a, **k)
    return r
api4.get_file = racing_get
ok4 = cs4.push(vfs={'files': {}, 'folders': {}})
ck('push 最终成功', ok4)
ck('get 被调用多次（说明有重拉）', api4.n_get >= 1)

print('\n' + '=' * 46)
print('  %d 通过 / %d 失败' % (passed, failed))
print('=' * 46)
sys.exit(1 if failed else 0)
