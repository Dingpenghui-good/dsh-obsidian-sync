@echo off
chcp 65001 >nul
echo ========================================
echo   DSH Obsidian Sync - 本地安装脚本
echo ========================================
echo.
echo 正在安装插件...
echo.

cd /d D:\DSH\workspace\dsh-obsidian-sync

REM ??是否有 node_modules
if not exist "node_modules" (
    echo 正在安装依?...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo ? 依?安装失?
        pause
        exit /b 1
    )
)

REM ?建插件
echo 正在?建插件...
npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ? ?建失?
    pause
    exit /b 1
)

echo.
echo ========================================
echo   插件?建成功！
echo ========================================
echo.
echo 下一?：手?安装到 DSH
echo.
echo 方法 1: 使用 dsh 命令
echo   dsh plugin --profile web add .
echo.
echo 方法 2: ?? cordis.patch.yml 手?添加
echo.
echo 然后重? DSH 即可使用。
echo.
pause
