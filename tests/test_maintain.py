"""maintain.py 测试 —— 孤儿 / 幽灵 / 记账偏差 / 僵尸条目

★ 每条测试都对应 2026-09-26 线上数据核验发现的一个真问题。
  断言里写清了"不修会怎样"，不是泛泛的正确性检查。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core import maintain
from gdrive.core.maintain import Maintain, normalize_usage, assert_no_readonly_write


class FakeApi:
    """按预设返回 tree，记录调用次数"""

    def __init__(self, trees=None, fail=()):
        self.trees = trees or {}
        self.fail = set(fail)
        self.calls = []

    def _req(self, method, path, **kw):
        self.calls.append(path)
        # /repos/OWNER/REPO/git/trees/BRANCH?recursive=1
        parts = path.split('?')[0].split('/')
        owner, repo = parts[2], parts[3]
        key = '%s/%s' % (owner, repo)
        if key in self.fail:
            raise RuntimeError('boom ' + key)
        tree = self.trees.get(key, [])
        # 兼容二元组 (path,size) 和三元组 (path,size,sha) —— 老用例写的是二元组
        norm = []
        for item in tree:
            if len(item) == 2:
                p, sz = item
                norm.append({'path': p, 'type': 'blob', 'size': sz,
                             'sha': 'sha-%s' % p})
            else:
                p, sz, sh = item
                norm.append({'path': p, 'type': 'blob', 'size': sz, 'sha': sh})
        return {'tree': norm, 'truncated': False}


def vfs_with(chunks):
    return {'files': {'/drive_home/a.txt': {'chunks': chunks}}}


class TestOrphan(unittest.TestCase):
    """孤儿：物理存在但 VFS 无记录 —— 占容量、拿不回来"""

    def test_orphan_detected(self):
        api = FakeApi({'o/r1': [('c1', 100), ('c2', 200)]})
        m = Maintain(api, 'o')
        vfs = vfs_with([{'owner': 'o', 'repo': 'r1', 'path': 'c1', 'size': 100}])
        rep = m.scan(vfs, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(len(rep['orphans']), 1)
        self.assertEqual(rep['orphans'][0]['path'], 'c2')
        self.assertEqual(rep['orphan_bytes'], 200)
        # ★ 必须带 sha，否则恢复进 VFS 后无法下载/删除
        self.assertEqual(rep['orphans'][0]['sha'], 'sha-c2')

    def test_no_false_orphan(self):
        """全部有记录 → 零孤儿。误报会让用户删掉正在用的文件"""
        api = FakeApi({'o/r1': [('c1', 100)]})
        m = Maintain(api, 'o')
        vfs = vfs_with([{'owner': 'o', 'repo': 'r1', 'path': 'c1', 'size': 100}])
        rep = m.scan(vfs, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(rep['orphans'], [])

    def test_readme_not_orphan(self):
        """README.md 是仓库自带，不能算孤儿"""
        api = FakeApi({'o/r1': [('README.md', 50)]})
        m = Maintain(api, 'o')
        rep = m.scan({'files': {}}, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(rep['orphans'], [])

    def test_chunk_size_missing_does_not_crash(self):
        """★ chunk 缺 size 不能崩 —— 记账会变 NaN 进而让容量判断失效"""
        api = FakeApi({'o/r1': [('c1', 100)]})
        m = Maintain(api, 'o')
        vfs = vfs_with([{'owner': 'o', 'repo': 'r1', 'path': 'c1'}])
        rep = m.scan(vfs, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(rep['orphans'], [])


class TestGhost(unittest.TestCase):
    """幽灵：VFS 有记录但物理不存在 —— 下载必失败"""

    def test_ghost_detected(self):
        api = FakeApi({'o/r1': [('other', 100)]})
        m = Maintain(api, 'o')
        vfs = vfs_with([{'owner': 'o', 'repo': 'r1', 'path': 'gone', 'size': 10}])
        rep = m.scan(vfs, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(len(rep['ghosts']), 1)
        self.assertEqual(rep['ghosts'][0]['path'], 'gone')

    def test_unscannable_repo_not_ghost(self):
        """★ 仓库扫不到时不报幽灵 —— 否则网络一抖就误报成百上千条"""
        api = FakeApi(fail=('o/r1',))
        m = Maintain(api, 'o')
        vfs = vfs_with([{'owner': 'o', 'repo': 'r1', 'path': 'c1', 'size': 10}])
        rep = m.scan(vfs, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(rep['ghosts'], [])
        self.assertEqual(len(rep['errors']), 1)


class TestUsage(unittest.TestCase):
    """记账偏差 —— 低估让 pick_repo 往已满仓库继续写"""

    def test_actual_size(self):
        api = FakeApi({'o/r1': [('c1', 100), ('c2', 200)]})
        m = Maintain(api, 'o')
        rep = m.scan({'files': {}}, [{'owner': 'o', 'repo': 'r1'}])
        self.assertEqual(rep['usage_actual']['o/r1'], 300)

    def test_drift_sorted_by_abs(self):
        """★ 按绝对值降序 —— 最该看的排前面"""
        m = Maintain(FakeApi(), 'o')
        out = m.reconcile_usage({'a': 100, 'b': 100}, {'a': 90, 'b': 500})
        self.assertEqual(out[0]['repo'], 'b')
        self.assertEqual(out[0]['drift'], -400)

    def test_underestimate_is_dangerous(self):
        """★ 低估标记 dangerous —— 这是唯一会让系统持续写错仓库的情况"""
        m = Maintain(FakeApi(), 'o')
        out = m.reconcile_usage({'a': 10}, {'a': 100})
        self.assertTrue(out[0]['dangerous'])

    def test_overestimate_not_dangerous(self):
        m = Maintain(FakeApi(), 'o')
        out = m.reconcile_usage({'a': 100}, {'a': 10})
        self.assertFalse(out[0]['dangerous'])

    def test_zero_drift_no_flag(self):
        m = Maintain(FakeApi(), 'o')
        out = m.reconcile_usage({'a': 5}, {'a': 5})
        self.assertFalse(out[0]['dangerous'])


class TestZombie(unittest.TestCase):
    """僵尸记账：记账里有、仓库已不在列表"""

    def test_zombie_found(self):
        m = Maintain(FakeApi(), 'o')
        z = m.find_zombie_usage({'o/live': 5, 'o/dead': 0, 'f/gone': 0},
                                [{'owner': 'o', 'repo': 'live'}])
        names = sorted(x['repo'] for x in z)
        self.assertEqual(names, ['f/gone', 'o/dead'])

    def test_web_dict_format(self):
        """★ web 版值是 {'size': n}，不能当 int 用"""
        m = Maintain(FakeApi(), 'o')
        z = m.find_zombie_usage({'o/dead': {'size': 7, 'updatedAt': 'x'},
                                 'o/dead2': {'size': None}}, [])
        sizes = sorted(x['size'] for x in z)
        self.assertEqual(sizes, [0, 7])

    def test_no_false_zombie(self):
        m = Maintain(FakeApi(), 'o')
        z = m.find_zombie_usage({'o/live': 1}, [{'owner': 'o', 'repo': 'live'}])
        self.assertEqual(z, [])


class TestNormalize(unittest.TestCase):

    def test_dict_and_int(self):
        self.assertEqual(normalize_usage({'a': {'size': 3}, 'b': 4}),
                         {'a': 3, 'b': 4})

    def test_none_size(self):
        self.assertEqual(normalize_usage({'a': {'size': None}}), {'a': 0})

    def test_empty(self):
        self.assertEqual(normalize_usage(None), {})


class TestReadOnly(unittest.TestCase):
    """★ 防复发：只读字段不能被写回（storageConfig 归网页版所有）"""

    def test_pass_when_unchanged(self):
        before = {'storageConfig': {'chunkSize': 1}, 'x': 1}
        after = {'storageConfig': {'chunkSize': 1}, 'x': 2}
        self.assertTrue(assert_no_readonly_write(before, after))

    def test_raise_when_changed(self):
        before = {'storageConfig': {'minChunkSize': 10485760}}
        after = {'storageConfig': {'minChunkSize': 524288}}
        with self.assertRaises(AssertionError):
            assert_no_readonly_write(before, after)

    def test_missing_after_also_detected(self):
        """字段被整体删掉也算改写"""
        before = {'storageConfig': {'a': 1}}
        after = {'version': 1}
        with self.assertRaises(AssertionError):
            assert_no_readonly_write(before, after)


class TestPlan(unittest.TestCase):
    """清理计划：只生成，不执行"""

    def test_plan_not_execute(self):
        api = FakeApi({'o/r1': [('c2', 200)]})
        m = Maintain(api, 'o')
        rep = m.scan({'files': {}}, [{'owner': 'o', 'repo': 'r1'}])
        plan = m.plan_purge(rep)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]['action'], 'delete')
        # ★ 没有调用任何删除 —— 计划阶段不能碰数据
        self.assertTrue(all('delete' not in c for c in api.calls))

    def test_empty_report_empty_plan(self):
        m = Maintain(FakeApi(), 'o')
        self.assertEqual(m.plan_purge({'orphans': []}), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)


class TestScanStats(unittest.TestCase):
    """★ scan 必须返回统计字段 —— CLI 依赖它们

    曾经 scan 只返回 orphans/ghosts/usage_actual 等，
    而 maintain_cli.py 用了 file_count / recorded_bytes / actual_bytes，
    结果界面全显示 0（59 个文件显示 0 个）。
    """

    def _scan(self):
        from gdrive.core.maintain import Maintain
        api = FakeApi({'o/r1': [('c1', 100, 's1')]})
        vfs = {'files': {'/drive_home/a.txt': {
            'name': 'a.txt', 'type': 'file', 'size': 100,
            'chunks': [{'owner': 'o', 'repo': 'r1', 'path': 'c1',
                        'size': 100, 'sha': 's1'}]}}}
        return Maintain(api, 'o').scan(vfs, [{'owner': 'o', 'repo': 'r1'}])

    def test_has_stat_keys(self):
        rep = self._scan()
        for k in ('file_count', 'recorded_bytes', 'actual_bytes',
                  'orphan_bytes', 'repo_count'):
            self.assertIn(k, rep, '缺少统计字段 %s' % k)

    def test_stats_not_zero(self):
        rep = self._scan()
        self.assertEqual(rep['file_count'], 1)
        self.assertEqual(rep['recorded_bytes'], 100)
        self.assertEqual(rep['actual_bytes'], 100)
