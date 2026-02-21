#!/usr/bin/env pwsh
# save.ps1 — End-of-session backup to GitHub.
# Usage:  .\save.ps1
#         .\save.ps1 "optional custom commit message"

param(
    [string]$Message = ""
)

Set-Location $PSScriptRoot

# Check there is anything to commit
$status = git status --porcelain
if (-not $status) {
    Write-Host "Nothing to commit — working tree clean." -ForegroundColor Green
    exit 0
}

# Build commit message
if (-not $Message) {
    $date    = Get-Date -Format "yyyy-MM-dd HH:mm"
    $staged   = git diff --cached --name-only
    $unstaged = git diff --name-only
    $untracked = git ls-files --others --exclude-standard
    $files   = ($staged + $unstaged + $untracked) | Sort-Object -Unique | Select-Object -First 5
    $summary = $files -join ", "
    $Message = "chore: session save $date — $summary"
}

git add .
git commit -m $Message
git push

Write-Host "`nPushed to origin/main." -ForegroundColor Cyan
