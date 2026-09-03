@echo off
chcp 65001 >nul
echo ========================================
echo   DSH Obsidian Sync - GitHub 推送助手
echo ========================================
echo.
echo ?按照以下??操作：
echo.
echo ?? 1: ?建 GitHub ??
echo   1. 打???器??: https://github.com/new
echo   2. Repository name: dsh-obsidian-sync
echo   3. ?? Private (建?)
echo   4. 不要勾? "Add a README file"
echo   5. 点? "Create repository"
echo.
echo ?? 2: 返回?里，按任意???推送...
pause >nul

echo.
echo 正在推送代?...
echo.

cd /d D:\DSH\workspace\dsh-obsidian-sync

REM ?除旧的 remote
git remote remove origin 2>nul

REM 添加新的 remote
git remote add origin https://github.com/Dingpenghui-good/dsh-obsidian-sync.git

REM 推送代?
git branch -M main
git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   推送成功！
    echo   ??: https://github.com/Dingpenghui-good/dsh-obsidian-sync
    echo ========================================
) else (
    echo.
    echo ========================================
    echo   推送失?
    echo   ???:
    echo   1. GitHub ??是否已?建
    echo   2. 用?名和密?是否正?
    echo ========================================
)

pause
