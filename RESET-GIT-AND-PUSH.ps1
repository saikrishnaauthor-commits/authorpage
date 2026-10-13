$ErrorActionPreference = 'Stop'

# Run this from the extracted cleaned Author Page folder.
# This intentionally replaces local Git history and force-pushes a fresh main branch.
$remote = 'https://github.com/saikrishnaauthor-commits/authorpage.git'

if (-not (Test-Path '.git')) {
    git init
} else {
    Write-Host 'Existing .git folder found; removing it to start fresh history.' -ForegroundColor Yellow
    Remove-Item -Recurse -Force '.git'
    git init
}

git branch -M main
git remote add origin $remote

git add -A
if (-not (git diff --cached --quiet)) {
    git commit -m 'Publish cleaned latest Author Page'
} else {
    Write-Host 'No changes staged; nothing to commit.'
}

Write-Host ''
Write-Host 'About to replace the remote main branch history at:' -ForegroundColor Yellow
Write-Host $remote
$confirm = Read-Host 'Type FORCE-PUSH to continue'
if ($confirm -ne 'FORCE-PUSH') {
    Write-Host 'Cancelled. Your fresh local Git repository is ready, but nothing was pushed.'
    exit 0
}

git push --force -u origin main
