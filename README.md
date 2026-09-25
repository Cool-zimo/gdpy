# gdpy · GitHub Drive 桌面版

Python + Tkinter 写的 GitHub Drive 桌面客户端。**源码公开，可执行文件不入库**（体积太大），
由 GitHub Actions 编译，产物放在 Release 里。

## 为什么做桌面版

网页版跑在浏览器沙箱里，**碰不到文件系统、起不了进程**。所以下面这些事网页版永远做不了：

- 把网盘里的文件同步到本地某个目录
- 下载完自动调用本地工具处理（转码、解压、预览）
- 开机自启、托盘常驻

桌面版补的就是这块。所以这是**新生态，不是移植**。

## 安装

从 Release 下载对应平台的文件，直接运行，**无需安装 Python**。

| 平台 | 文件 |
|---|---|
| Windows | `Desktop_Github-Drive-Windows-Vx.x.x.exe` |
| macOS | `Desktop_Github-Drive-macOS-Vx.x.x` |
| Linux | `Desktop_Github-Drive-Linux-Vx.x.x` |

首次运行填入 GitHub Personal Access Token（需 `repo` 权限）。
令牌只存在本机配置文件里，不上传任何服务器。

## 与网页版的数据兼容性

**完全兼容，双向。** 网页版上传的文件，桌面版打开就能看见、能下载；反之亦然。

保持一致的关键契约：

| 项目 | 约定 |
|---|---|
| VFS 结构 | `files` / `folders` 两个 dict，字段名与 `js/storage.js` 一致 |
| 分片路径 | `{base36(毫秒时间戳)}/{文件名}`，多分片为 `{原名}.{序号}`（从 1 开始） |
| 分片大小 | 512KB（>1MB 走 Git blob API，≤1MB 走 Contents API） |
| 存储仓 | `drive-storage-{YYYY-MM-DD}-{4位hex}`，私有 |
| 配置仓 | `github-drive-config`（与网页版共用） |
| 分享仓 | `gd-share-{6位hex}`，公开 + Pages |
| 忽略文件 | `index.html` / `README.md` / `status.js` / `share.json` |

⚠️ 改这些常量之前先看 `docs` 仓库的 `github-drive.md`，改错一个就会导致跨端读不到文件。

## 插件系统

**与网页版插件不兼容，也不打算兼容。** 网页插件是 HTML+JS，跑在沙箱里；
桌面插件是 Python，能读写本地文件、调用外部程序。

三层安全模型：

1. **声明** —— `plugin.json` 里写 `permissions`
2. **授权** —— 安装时弹窗确认；官方仓库自动授信
3. **校验** —— ★ 运行时**每次调用**都查

```
fs:read / fs:list   低风险
net                 中风险
fs:write            高风险
exec                ⛔ 极高风险（等于把终端交出去）
```

未知权限一律按最高风险处理。授权了 `exec` 也还有命令黑名单兜底。

⚠️ **自动授信 ≠ 取消运行时校验。** 取消校验的话，插件 A 能冒充插件 B 调用
已授权的能力，整个权限模型形同虚设。

插件目录：

```
Windows  %APPDATA%\gdpy\plugins
macOS    ~/Library/Application Support/gdpy/plugins
Linux    ~/.config/gdpy/plugins
```

插件结构：

```
myplugin/
  plugin.json   { "id", "name", "version", "entry": "main.py", "permissions": [...] }
  main.py       def run(ctx): ...
```

## 从源码运行

```bash
pip install -r requirements.txt
python main.py
```

需要系统 Tkinter：

```bash
# Ubuntu/Debian
sudo apt-get install python3-tk
```

## 构建

可执行文件由 GitHub Actions 构建，不入库：

```
Actions → Build Desktop → Run workflow → 填版本号（留空读 VERSION 文件）
```

版本号规范：**测试版 `0.x.x`，正式版从 `1.0.0` 起**。产物名带版本号，
如 `Desktop_Github-Drive-Windows-V0.0.1.exe`。

## 测试

```bash
python tests/test_core.py
```

59 项，纯逻辑不需要 GUI。
