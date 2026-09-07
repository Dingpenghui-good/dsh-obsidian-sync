#!/usr/bin/env pwsh
# 快速记录一次对话到知识库
# 用法: Record-KB-Conversation.ps1 -Role "assistant" -Content "对话内容..."
#
# 或在 Python 中调用:
#   python maintain.py log <session_id> <role> <content_file> [model]

param(
    [Parameter(Mandatory=$true)]
    [string]$Role,
    [Parameter(Mandatory=$true)]
    [string]$Content,
    [string]$SessionId = "default-session",
    [string]$Model = "agts-devflash"
)

$KBRoot = "D:\DSH\workspace\knowledge-base"
$contentFile = Join-Path $KBRoot "_meta\tmp_content.md"

# 写入临时文件
$Content | Out-File -FilePath $contentFile -Encoding utf8

# 调用 Python 记录
$pythonCmd = "python `"$KBRoot\maintain.py`" log `"$SessionId`" `"$Role`" `"$contentFile`" `"$Model`""
$result = Invoke-Expression $pythonCmd
Write-Host $result

# 清理临时文件
Remove-Item $contentFile -Force -ErrorAction SilentlyIgnore
