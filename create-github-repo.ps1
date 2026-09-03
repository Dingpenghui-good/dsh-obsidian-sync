# GitHub Repository Creator for dsh-obsidian-sync
# 需要 GitHub Token

param(
    [string]$Owner = "Dingpenghui-good",
    [string]$RepoName = "dsh-obsidian-sync",
    [switch]$Private = $true,
    [string]$Description = "DSH Plugin: Auto-sync conversations to Obsidian knowledge base"
)

# 获取 GitHub Token
$token = Read-Host "请输入 GitHub Personal Access Token" -AsSecureString
$tokenBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
$tokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($tokenBstr)

# 创建仓库
$url = "https://api.github.com/user/repos"
$body = @{
    name = $RepoName
    description = $Description
    private = $Private.IsPresent
    auto_init = $false
} | ConvertTo-Json

$headers = @{
    Authorization = "token $tokenPlain"
    Accept = "application/vnd.github.v3+json"
}

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -Headers $headers -Body $body
    Write-Host "✓ 仓库创建成功: $($response.html_url)" -ForegroundColor Green
    
    # 推送代码
    Write-Host "`n开始推送代码..." -ForegroundColor Yellow
    Set-Location "D:\DSH\workspace\dsh-obsidian-sync"
    
    git remote remove origin 2>$null
    git remote add origin "https://$($tokenPlain):x-oauth-basic@github.com/$Owner/$RepoName.git"
    git branch -M main
    git push -u origin main
    
    Write-Host "`n✓ 推送完成! 访问: $($response.html_url)" -ForegroundColor Green
} catch {
    Write-Host "✗ 错误: $($_.Exception.Message)" -ForegroundColor Red
}
