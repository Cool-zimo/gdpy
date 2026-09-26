"""gdpy · GitHub Drive 桌面版"""

# ★ 真实版本号由 CI 构建时写入 gdrive/_version.py。
#
#   曾经这里硬编码 __version__ = '1.0.0'，而实际发布的是 0.0.x ——
#   与实际完全不符，且与另一个版本号（_version.py，该文件当时根本不存在）
#   互不一致。版本号不能凭感觉写。
#
#   占位值 '0.0.0-dev' 表示"CI 没写入"，此时回退到下面这个兜底值。
_FALLBACK = '0.0.7'

try:
    from ._version import __version__ as _v
except Exception:
    _v = ''

__version__ = _v if (_v and not str(_v).endswith('-dev')) else _FALLBACK
