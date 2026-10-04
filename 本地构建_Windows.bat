@echo off
chcp 65001 >nul
REM ============================================================
REM  本地构建 Windows 版 exe
REM  双击运行即可，产物在 dist\ 目录
REM ============================================================

set VER=0.0.3
set NAME=Desktop_Github-Drive-Windows-V%VER%

echo.
echo === gdpy 本地构建 v%VER% ===
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [x] 没找到 python，请先安装 Python 3.8+ 并勾选 Add to PATH
    pause
    exit /b 1
)

echo [1/4] 安装 PyInstaller ...
python -m pip install --upgrade pyinstaller
if errorlevel 1 (
    echo [x] PyInstaller 安装失败
    pause
    exit /b 1
)

echo.
echo [2/4] 加 Defender 排除项
echo       ^(PyInstaller 生成的 exe 常被误判为木马当场删除^)
powershell -Command "Add-MpPreference -ExclusionPath \"$env:LOCALAPPDATA\Temp\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath \"$PWD\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath \"$PWD\dist\" -ErrorAction SilentlyContinue" >nul 2>nul
echo       完成

echo.
echo [3/4] 打包中，请等待 1-3 分钟 ...
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name %NAME% ^
  --collect-all tkinter ^
  --collect-submodules gdrive ^
  --hidden-import gdrive.core.api ^
  --hidden-import gdrive.core.config ^
  --hidden-import gdrive.core.config_sync ^
  --hidden-import gdrive.core.vfs ^
  --hidden-import gdrive.core.transfer ^
  --hidden-import gdrive.core.share ^
  --hidden-import gdrive.core.plugins ^
  --hidden-import gdrive.ui.app ^
  --hidden-import gdrive.ui.plugins_ui ^
  main.py

if errorlevel 1 (
    echo.
    echo [x] 打包失败，看上面的报错
    pause
    exit /b 1
)

echo.
echo [4/4] 完成
echo.
echo 产物： %CD%\dist\%NAME%.exe
echo.
start "" explorer "%CD%\dist"
pause
