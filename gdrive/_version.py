"""版本号

★ 这个文件由 CI 在构建时写入真实版本号（见 .github/workflows/build.yml）。
  仓库里提交的是开发占位值，打包后会被覆盖。

★ 为什么要单独一个文件：
  早期 bridge.app_version() 从 gdrive._version 导入，但这个文件从来
  没被创建过，也没有任何地方生成它 —— 于是永远返回 '0.0.0'。
  而 gdrive/__init__.py 里同时有一个硬编码的 __version__ = '1.0.0'，
  与实际版本（0.0.x）不符。两个版本号互不一致，且都是错的。
"""
__version__ = '0.0.0-dev'
