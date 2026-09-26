"""
上传 / 下载 / 分片

★ 分片命名必须与 web 版 js/file-manager.js 一致，否则桌面版读不到网页版传的文件：
    chunk_path = "{base36(毫秒时间戳)}/{文件名}"
    多分片时文件名 = "{原名}.{序号}"（序号从 1 开始）

  chunk 记录结构（写进 VFS）：
    {owner, repo, path, size, sha, branch}
"""
import base64
import os
import random
import time

from .vfs import DRIVE_HOME, human_size

# >1MB 走 Git blob API，<=1MB 走 Contents API（与 web 版同一阈值）
LARGE_THRESHOLD = 1024 * 1024


def _b36(n):
    """毫秒时间戳转 36 进制 —— 与 JS 的 Date.now().toString(36) 同形"""
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n <= 0:
        return '0'
    out = ''
    while n:
        out = digits[n % 36] + out
        n //= 36
    return out


class Transfer:
    def __init__(self, api, config, vfs=None):
        self.api = api
        self.cfg = config
        self.vfs = vfs

    # ==================== 仓库选择 ====================
    def pick_repo(self, need_bytes):
        """
        挑一个有空间的仓库；没有就自动创建

        ★ 容量判断用本地记账（config.repoUsage），不实时查 GitHub ——
          查一次要一次 API，每次上传前都查太贵。
        """
        scfg = self.cfg.storage_config()
        usage = self.cfg.usage()
        cap = scfg['maxRepoSize'] * scfg['warnThreshold']

        # ★ 必须先判断"单块本身就超限"。
        #   少了这一步：上传一个 500MB 文件（单仓上限 100MB）时，
        #   循环永远找不到"有空间"的仓库，于是**每个分片都新建一个仓库** ——
        #   512KB 分片 × 1000 片 = 1000 次 create_repo API，仓库被刷爆。
        #   而且新建的仓库同样装不下，问题并不会被解决，只是被放大。
        if need_bytes > cap:
            raise RuntimeError(
                '单个分块 %s 超过仓库容量上限 %s，无法上传。'
                '请调大 storageConfig.maxRepoSize'
                % (human_size(need_bytes), human_size(int(cap))))

        for r in self.cfg.repos():
            key = '%s/%s' % (r['owner'], r['repo'])
            used = usage.get(key, 0)
            if used + need_bytes <= cap:
                return r
        if not scfg.get('autoCreateRepo', True):
            raise RuntimeError('所有仓库容量不足，且未开启自动创建仓库')
        return self.create_storage_repo()

    def create_storage_repo(self):
        """drive-storage-{YYYY-MM-DD}-{4位hex}，私有"""
        scfg = self.cfg.storage_config()
        import datetime
        date = datetime.date.today().isoformat()
        rand = '%04x' % random.randint(0, 0xFFFF)
        name = '%s-%s-%s' % (scfg['repoNamePrefix'], date, rand)
        repo = self.api.create_repo(name, private=True,
                                    description='gdpy 自动创建的存储仓库')
        owner = repo['owner']['login']
        return self.cfg.add_repo(owner, repo['name'],
                                 branch=repo.get('default_branch', 'main'))

    def scan_storage_repos(self, owner):
        """
        扫描账号下所有 drive-storage-* 仓库并登记

        ★ 为什么需要：换设备/网页版建的仓库，本地配置里没有。
          不扫描就等于那些文件"消失"了（其实还在 GitHub 上）。
        """
        found = []
        for page in (1, 2, 3, 4, 5):
            repos = self.api.list_repos(100, page)
            if not repos:
                break
            for r in repos:
                if r['name'].startswith('drive-storage-') \
                        and r['owner']['login'] == owner:
                    self.cfg.add_repo(owner, r['name'],
                                      branch=r.get('default_branch', 'main'))
                    found.append(r['name'])
            if len(repos) < 100:
                break
        return found

    # ==================== 上传 ====================
    def upload(self, local_path, target_dir=DRIVE_HOME, on_progress=None):
        """
        上传本地文件 → 返回 (virtual_path, chunks)

        ★ 失败清理：中途挂了要把已上传的分片删掉，
          否则仓库里会堆垃圾 —— 占容量且无法自动回收。
        """
        scfg = self.cfg.storage_config()
        name = os.path.basename(local_path)
        vpath = (target_dir.rstrip('/') if target_dir != DRIVE_HOME else '') \
            + '/' + name
        vpath = (DRIVE_HOME + vpath) if not vpath.startswith(DRIVE_HOME) else vpath
        total = os.path.getsize(local_path)

        chunk_size = scfg['chunkSize']
        need_split = total > scfg['minChunkSize']
        if not need_split:
            chunk_size = max(total, 1)
        total_chunks = max(1, (total + chunk_size - 1) // chunk_size)

        stamp = _b36(int(time.time() * 1000))
        chunks = []
        uploaded = []   # 失败回滚用

        try:
            with open(local_path, 'rb') as f:
                for i in range(total_chunks):
                    data = f.read(chunk_size)
                    if not data:
                        break
                    repo = self.pick_repo(len(data))
                    cname = name if total_chunks == 1 else '%s.%d' % (name, i + 1)
                    cpath = '%s/%s' % (stamp, cname)

                    if len(data) > LARGE_THRESHOLD:
                        blob = self.api.create_blob(repo['owner'], repo['repo'], data)
                        tree = self.api.create_tree(
                            repo['owner'], repo['repo'],
                            [{'path': cpath, 'mode': '100644',
                              'type': 'blob', 'sha': blob['sha']}],
                            self._base_tree(repo))
                        commit = self.api.create_commit(
                            repo['owner'], repo['repo'],
                            '上传分片: %s' % cname, tree['sha'],
                            [self._head_sha(repo)])
                        self.api.update_ref(repo['owner'], repo['repo'],
                                            'heads/%s' % repo['branch'],
                                            commit['sha'])
                    else:
                        self.api.put_file(repo['owner'], repo['repo'], cpath,
                                          data, '上传分片: %s' % cname,
                                          branch=repo['branch'])

                    sha = ''
                    try:
                        sha = self.api.get_file(repo['owner'], repo['repo'],
                                                cpath, repo['branch']).get('sha', '')
                    except Exception:
                        pass

                    chunks.append({'owner': repo['owner'], 'repo': repo['repo'],
                                   'path': cpath, 'size': len(data),
                                   'sha': sha, 'branch': repo['branch']})
                    # ★ size 必须一起记 —— 回滚时要按它扣回容量，
                    #   早期版本只存 (repo, cpath)，导致回滚时无从扣减
                    uploaded.append((repo, cpath, len(data)))
                    self.cfg.add_usage(repo['owner'], repo['repo'], len(data))

                    if on_progress:
                        on_progress(i + 1, total_chunks, name)
        except Exception:
            self._rollback(uploaded)
            raise

        self.cfg.save()
        return vpath, chunks

    def _base_tree(self, repo):
        head = self._head_sha(repo)
        return self.api.get_commit(repo['owner'], repo['repo'], head)['tree']['sha']

    def _head_sha(self, repo):
        ref = self.api.get_ref(repo['owner'], repo['repo'],
                               'heads/%s' % repo['branch'])
        return ref['object']['sha']

    def _rollback(self, uploaded):
        """尽力清理，失败只警告 —— 不能因为清理失败掩盖原始异常"""
        for item in uploaded:
            repo, cpath = item[0], item[1]
            size = item[2] if len(item) > 2 else 0
            try:
                self.api.delete_file(repo['owner'], repo['repo'], cpath,
                                     '清理失败上传的分片', branch=repo['branch'])
            except Exception:
                # ★ 删除失败就不扣容量 —— 分片还在仓库里，扣了会少算
                continue
            # ★★ 早期这里写死传 0，等于完全没回滚。
            #    后果：上传失败 N 次，记账虚增 N 倍 → 明明有空间却判满
            #    → 触发上面的"疯狂建仓库"。两个 bug 互相放大。
            self.cfg.sub_usage(repo['owner'], repo['repo'], size)
        try:
            self.cfg.save()
        except Exception:
            pass

    # ==================== 下载 ====================
    def download(self, chunks, dest_path, on_progress=None):
        """
        按序拉取分片并合并写入本地文件

        ★ 必须按 chunks 顺序写 —— 分片序号就是字节顺序。
        """
        tmp = dest_path + '.part'
        try:
            with open(tmp, 'wb') as out:
                for i, c in enumerate(chunks):
                    data = self.api.raw(c['owner'], c['repo'], c['path'],
                                        c.get('branch', 'main'))
                    if isinstance(data, str):
                        data = data.encode('utf-8')
                    out.write(data)
                    if on_progress:
                        on_progress(i + 1, len(chunks))
            os.replace(tmp, dest_path)
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            raise
        return dest_path

    def download_to_bytes(self, chunks, on_progress=None):
        """直接取到内存（分享用，不落盘）"""
        buf = bytearray()
        for i, c in enumerate(chunks):
            data = self.api.raw(c['owner'], c['repo'], c['path'],
                                c.get('branch', 'main'))
            if isinstance(data, str):
                data = data.encode('utf-8')
            buf.extend(data)
            if on_progress:
                on_progress(i + 1, len(chunks))
        return bytes(buf)

    # ==================== 删除分片 ====================
    def delete_chunks(self, chunks):
        """
        真正删除 GitHub 上的分片（永久删除才调用）

        ★ 回收站不要调这个 —— 只改 VFS 就能"秒删"。
          真删是 N 次 API，慢且费配额。
        """
        ok, fail = 0, 0
        for c in chunks:
            try:
                self.api.delete_file(c['owner'], c['repo'], c['path'],
                                     '删除文件分片', branch=c.get('branch', 'main'))
                self.cfg.sub_usage(c['owner'], c['repo'], c.get('size', 0))
                ok += 1
            except Exception:
                fail += 1
        self.cfg.save()
        return ok, fail
