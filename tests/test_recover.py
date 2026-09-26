"""recover.py 测试

★ 核心原则：只增不删。任何一条"会破坏现有数据"的行为都必须被拦下。
  这里的孤儿是**用户丢失的文件**，不是垃圾 —— 删错不可逆。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gdrive.core import recover
from gdrive.core.recover import build_plan, apply_plan, summary, RECOVER_DIR


def orph(*items):
    out = []
    for p, sz in items:
        out.append({'owner': 'o', 'repo': 'r1', 'path': p,
                    'size': sz, 'sha': 'sha-' + p, 'branch': 'main'})
    return out


class TestPlan(unittest.TestCase):

    def test_path_under_recover_dir(self):
        plan = build_plan(orph(('mt1/a.pdf', 100)))
        self.assertIn('/drive_home/_recovered/a.pdf', plan['files'])

    def test_chunk_shape_matches_web(self):
        """★ 字段必须与 web 版 VFS 一致，否则前端认不出"""
        plan = build_plan(orph(('mt1/a.pdf', 100)))
        e = plan['files']['/drive_home/_recovered/a.pdf']
        self.assertEqual(sorted(e.keys()),
                         ['chunks', 'createdAt', 'name', 'recovered',
                          'size', 'type', 'updatedAt'])
        c = e['chunks'][0]
        self.assertEqual(sorted(c.keys()),
                         ['branch', 'owner', 'path', 'repo', 'sha', 'size'])
        self.assertEqual(c['sha'], 'sha-mt1/a.pdf')
        self.assertEqual(c['path'], 'mt1/a.pdf')

    def test_dedupe(self):
        plan = build_plan(orph(('m1/a.txt', 1), ('m2/a.txt', 2)))
        names = sorted(v['name'] for v in plan['files'].values())
        # '(' < '.' 所以 a(1).txt 排在 a.txt 前 —— 断言集合不是顺序
        self.assertEqual(set(names), {'a.txt', 'a(1).txt'})
        self.assertEqual(len(set(names)), 2)

    def test_hidden_skipped(self):
        plan = build_plan(orph(('m1/.gitkeep', 0)))
        self.assertEqual(plan['files'], {})
        self.assertEqual(len(plan['skipped']), 1)

    def test_zero_size_still_recovered(self):
        """★ 0 字节也恢复 —— 看不见比占地方更糟"""
        plan = build_plan(orph(('m1/empty.txt', 0)))
        self.assertEqual(len(plan['files']), 1)

    def test_folder_entry_created(self):
        plan = build_plan(orph(('m1/a.txt', 1)))
        self.assertIsNotNone(plan['folder_entry'])
        self.assertEqual(plan['folder_entry']['type'], 'folder')

    def test_empty_orphans_no_folder(self):
        plan = build_plan([])
        self.assertIsNone(plan['folder_entry'])
        self.assertEqual(plan['files'], {})


class TestApply(unittest.TestCase):
    """★ 只增不删"""

    def test_existing_not_overwritten(self):
        """★ 覆盖会毁掉现有记录 —— 必须跳过并报告"""
        plan = build_plan(orph(('m1/a.txt', 1)))
        vfs = {'files': {'/drive_home/_recovered/a.txt': {'name': 'old'}},
               'folders': {}}
        r = apply_plan(vfs, plan)
        self.assertEqual(r['added'], [])
        self.assertEqual(len(r['conflict']), 1)
        self.assertEqual(r['vfs']['files']['/drive_home/_recovered/a.txt']['name'], 'old')

    def test_other_files_preserved(self):
        """★ 不能碰任何已有数据"""
        plan = build_plan(orph(('m1/new.txt', 1)))
        vfs = {'files': {'/drive_home/keep.txt': {'name': 'keep'}}, 'folders': {}}
        r = apply_plan(vfs, plan)
        self.assertIn('/drive_home/keep.txt', r['vfs']['files'])
        self.assertEqual(len(r['vfs']['files']), 2)

    def test_vfs_none_safe(self):
        r = apply_plan(None, build_plan(orph(('m1/a.txt', 1))))
        self.assertEqual(len(r['vfs']['files']), 1)

    def test_folder_not_duplicated(self):
        plan = build_plan(orph(('m1/a.txt', 1)))
        vfs = {'files': {}, 'folders': {RECOVER_DIR: {'name': '_recovered'}}}
        r = apply_plan(vfs, plan)
        self.assertEqual(r['vfs']['folders'][RECOVER_DIR]['name'], '_recovered')

    def test_summary_readable(self):
        plan = build_plan(orph(('m1/a.txt', 1048576)))
        r = apply_plan({'files': {}, 'folders': {}}, plan)
        s = summary(plan, r)
        self.assertIn('1 个', s)
        self.assertIn('1.0 MB', s)


if __name__ == '__main__':
    unittest.main(verbosity=2)
