@echo off
echo ========================================
echo   DSH Obsidian Sync - 推送脚本
echo ========================================
echo.
echo ??保已在 GitHub 上?建??:
echo   https://github.com/new
echo   Repository name: dsh-obsidian-sync
echo.
echo 正在推送代?...
echo.

cd /d D:\DSH\workspace\dsh-obsidian-sync
git remote set-url origin https://github.com/Dingpenghui-good/dsh-obsidian-sync.git
git push -u origin master

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   推送成功！
    echo   ??: https://github.com/Dingpenghui-good/dsh-obsidian-sync
    echo ========================================
) else (
    echo.
    echo ========================================
    echo   推送失?，???:
    echo   1. GitHub ??是否已?建
    echo   2. 用?名和密?是否正?
    echo   3. 网??接是否正常
    echo ========================================
)

pause
