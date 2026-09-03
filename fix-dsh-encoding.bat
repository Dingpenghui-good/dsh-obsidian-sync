@echo off
chcp 65001 >nul
echo ========================================
echo   DSH Obsidian Sync - é©?èC?ãrñ{
echo ========================================
echo.

REM ??õÛèC? settings.yaml ??
echo ê≥ç›??ï∂åè??...
powershell -Command "[System.IO.File]::ReadAllText('C:\Users\braindge\.dsh\settings.yaml', [System.Text.Encoding]::UTF8)" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo èC? settings.yaml ??...
    powershell -Command "$c = Get-Content 'C:\Users\braindge\.dsh\settings.yaml' -Raw -Encoding utf8; [System.IO.File]::WriteAllText('C:\Users\braindge\.dsh\settings.yaml', $c, (New-Object System.Text.UTF8Encoding $false))"
    echo ? settings.yaml õﬂèC?
)

REM ?? cordis.patch.yml
if exist "C:\Users\braindge\.dsh\profiles\web\cordis.patch.yml" (
    echo ? cordis.patch.yml ë∂ç›
) else (
    echo ? cordis.patch.yml „ûé∏
)

echo.
echo ========================================
echo   èC?äÆê¨ÅI
echo ========================================
echo.
echo ?ç›â¬à»?çs: pnpm dsh web
echo.
pause
