# AI Knowledge Base Auto-Maintenance
$ErrorActionPreference = "Continue"
$env:PYTHONIOENCODING = "utf-8"
$kbRoot = "D:\DSH\workspace\knowledge-base"

try {
    $result = python "$kbRoot\maintain.py" maintain 2>&1
    if ($result) { Write-Host $result }
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
