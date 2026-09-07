#!/usr/bin/env pwsh
# 知识库每小时整理 - Windows 定时任务入口
# 用法: Schedule-KB-Maintenance.ps1
# 注册定时任务: schtasks /create /tn "KB-Maintain" /tr "powershell -WindowStyle Hidden -File D:\DSH\workspace\knowledge-base\schedule-maintenance.ps1" /sc hourly /mo 1 /st 00:00

$ErrorActionPreference = "Continue"
$KBRoot = "D:\DSH\workspace\knowledge-base"
$Python = "python"

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] KB 维护任务开始" -ForegroundColor Cyan

try {
    # 执行整理
    $result = & $Python "$KBRoot\maintain.py" maintain 2>&1
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 整理结果: $result" -ForegroundColor Green
    
    # 记录执行日志
    $logEntry = @{
        time     = (Get-Date).ISO8601
        status   = "success"
        output   = $result
    }
    $logDir = Join-Path $KBRoot "_meta\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $logFile = Join-Path $logDir "$(Get-Date -Format 'yyyy-MM').jsonl"
    $logEntry | ConvertTo-Json -Compress | Out-File -Append -FilePath $logFile -Encoding utf8
} catch {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 错误: $($_.Exception.Message)" -ForegroundColor Red
    $logDir = Join-Path $KBRoot "_meta\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $logFile = Join-Path $logDir "$(Get-Date -Format 'yyyy-MM').jsonl"
    $logEntry = @{ time = (Get-Date).ToUniversalTime().ToString('o'); status = "error"; message = $_.Exception.Message }
    $logEntry | ConvertTo-Json -Compress | Out-File -Append -FilePath $logFile -Encoding utf8
}

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 维护任务完成" -ForegroundColor Cyan
