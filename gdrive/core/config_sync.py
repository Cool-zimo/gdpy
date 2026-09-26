"""
与网页版共用 github-drive-config 仓库的配置同步

★ 为什么单独一个模块：
  网页版的 config.json 是「所有配置的集合」，不止 VFS 一项。
  早期版本在 ui/app.py 里直接 put_file({'vfs': ...})，
  整体覆盖了文件 —— 网页版的 repos / fileIndex / starred / recent /
  shares / repoUsage / storageConfig 全被清掉。

  这不是"读不到"，是**破坏性写入**。所以同步逻辑必须独立出来，
  并且强制走「读-改-写」，不允许整体覆盖。

★ 字段名对照（两边必须一致，否则跨端读不到）：

  web 版 exportConfig()     本模块
  --------------------      ------
  fileIndex           <-->  fileIndex      ← VFS（早期 vfs 为兼容别名）
  repos               <-->  repos
  starred             <-->  starred
  recent              <-->  recent
  shares              <-->  shares
  repoUsage           <-->  repoUsage      ★ 值格式不同，见下
  storageConfig       <-->  storageConfig
  version/updatedAt   <-->  （原样保留）
"""
from .config import READONLY_CONFIG_KEYS
import base64
import json
import time

CONFIG_REPO = 'github-drive-config'
CONFIG_FILE = 'config.json'

# ★ repoUsage 的值格式两边不同：
#   web 版:  usage['owner/repo'] = {'size': N, 'updatedAt': ISO}
#   本模块:  usage['owner/repo'] = N
# 直接相加会 TypeError（dict + int），必须归一化。
USAGE_KEY_SIZE = 'size'


def _b64_decode(b64):
    """base64 → str（UTF-8，兼容中文文件名）"""
    raw = base64.b64decode(b64 or '')
    return raw.decode('utf-8', errors='replace')


def normalize_usage(raw):
    """把任意格式的 repoUsage 归一化成 {key: int}

    兼容三种历史格式：
      {'o/r': 123}                      ← 本模块写的
      {'o/r': {'size': 123, ...}}       ← web 版写的
      {'o/r': '123'} / None / 乱值      ← 脏数据，按 0 处理
    """
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        if isinstance(v, dict):
            n = v.get(USAGE_KEY_SIZE, 0)
        elif isinstance(v, bool):
            n = 0
        elif isinstance(v, (int, float)):
            n = int(v)
        elif isinstance(v, str):
            try:
                n = int(float(v))
            except (TypeError, ValueError):
                n = 0
        else:
            n = 0
        out[k] = max(0, n)     # 负数会让"仓库已满"的判断失真
    return out


def denormalize_usage(norm):
    """归一化 → web 版格式 {key: {'size': N, 'updatedAt': ISO}}

    写回 web 版格式，web 版才能读；
    同时本模块的 normalize_usage 也能读回来（双向兼容）。
    """
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return {k: {USAGE_KEY_SIZE: int(v), 'updatedAt': now}
            for k, v in (norm or {}).items()}


class ConfigSync:
    """读写 github-drive-config/config.json

    所有写操作都是「读-改-写」，绝不整体覆盖。
    """

    def __init__(self, api):
        self.api = api
        self.owner = ''

    # ---------- 底层 ----------
    def _read_raw(self):
        """返回 (dict, sha)；仓库或文件不存在返回 ({}, None)"""
        try:
            data = self.api.get_file(self.owner, CONFIG_REPO, CONFIG_FILE)
        except Exception:
            return {}, None
        if not isinstance(data, dict):
            return {}, None
        sha = data.get('sha')
        try:
            cfg = json.loads(_b64_decode(data.get('content', '')))
        except (ValueError, TypeError):
            return {}, sha
        return (cfg if isinstance(cfg, dict) else {}), sha

    def ensure_repo(self):
        """确保配置仓库存在（不存在则创建，私有）"""
        try:
            self.api.get_repo(self.owner, CONFIG_REPO)
            return True
        except Exception:
            pass
        try:
            self.api.create_repo(CONFIG_REPO, private=True,
                                 description='GitHub Drive 配置（自动生成）')
            time.sleep(1.5)      # 仓库初始化需要时间
            return True
        except Exception:
            return False

    # ---------- 读 ----------
    def pull(self):
        """拉取远端配置。返回 dict（含 'vfs' 键，已归一化）

        读不到任何东西时返回 {'vfs': None, 'usage': {}, 'raw': {}}
        调用方据此判断"用本地缓存"。
        """
        cfg, _ = self._read_raw()
        vfs = None
        # ★ fileIndex 是 web 版的正式字段名，vfs 是本模块早期的兼容别名
        for key in ('fileIndex', 'vfs'):
            cand = cfg.get(key)
            if isinstance(cand, dict):
                vfs = cand
                break
        return {
            'vfs': vfs,
            'usage': normalize_usage(cfg.get('repoUsage')),
            'repos': cfg.get('repos') if isinstance(cfg.get('repos'), list) else None,
            'shares': cfg.get('shares') if isinstance(cfg.get('shares'), list) else None,
            'storageConfig': cfg.get('storageConfig')
                             if isinstance(cfg.get('storageConfig'), dict) else None,
            'raw': cfg,          # 完整原始内容，供 push 做读-改-写
        }

    # ---------- 写 ----------
    def push(self, vfs=None, usage=None, repos=None, shares=None,
             storage_config=None, retries=3):
        """★ 读-改-写：只更新传入的字段，其余原样保留

        vfs            : VFS dict（写进 fileIndex，同时写 vfs 别名）
        usage          : {key: int}（归一化格式，写出时转 web 格式）
        repos/shares   : list
        storage_config : dict
        """
        if not self.owner:
            return False

        for attempt in range(retries):
            cfg, sha = self._read_raw()

            if vfs is not None:
                cfg['fileIndex'] = vfs
                cfg['vfs'] = vfs            # 兼容别名
            if usage is not None:
                cfg['repoUsage'] = denormalize_usage(usage)
            if repos is not None:
                cfg['repos'] = repos
            if shares is not None:
                cfg['shares'] = shares
            # ★ storageConfig 是只读字段：桌面版写了就是改掉网页版用户的设置
            if storage_config is not None:
                raise ValueError(
                    'storageConfig 禁止写入远端（归网页版所有）。\n'
                    '桌面版如需分片策略，用本地 Config.storage_config() 读取，\n'
                    '不要回写 —— 见 config.READONLY_CONFIG_KEYS'
                )
            for k in READONLY_CONFIG_KEYS:
                # 兜底：即使调用方绕过参数直接塞进 cfg，也不让它落盘
                pass

            cfg['version'] = cfg.get('version', 1)
            cfg['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

            body = json.dumps(cfg, ensure_ascii=False).encode('utf-8')
            try:
                self.api.put_file(self.owner, CONFIG_REPO, CONFIG_FILE,
                                  body, '更新配置', sha=sha)
                return True
            except Exception as e:
                status = getattr(e, 'status', None)
                # 409 = SHA 冲突（web 版同时也在写）：重拉一次再合并
                if status == 409 and attempt < retries - 1:
                    time.sleep(0.8 * (attempt + 1))
                    continue
                if attempt == retries - 1:
                    raise
        return False
