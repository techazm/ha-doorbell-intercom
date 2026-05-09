<#
.SYNOPSIS
    Bump the add-on patch version in config.yaml, commit all staged/unstaged
    changes, and push to origin (techazm account via SSH alias).

.USAGE
    .\deploy.ps1 [-Message "optional commit message"]
#>
param(
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot  = $PSScriptRoot
$ConfigFile = Join-Path $RepoRoot "doorbell_intercom\config.yaml"

# ── 1. Read & bump patch version ───────────────────────────────────────────────
$content = Get-Content $ConfigFile -Raw
if ($content -notmatch 'version:\s+"(\d+)\.(\d+)\.(\d+)"') {
    Write-Error "Could not find version string in config.yaml"
    exit 1
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
$patch = [int]$Matches[3]
$oldVersion = "$major.$minor.$patch"
$newVersion = "$major.$minor.$($patch + 1)"

$content = $content -replace "version:\s+`"$oldVersion`"", "version: `"$newVersion`""
Set-Content $ConfigFile $content -NoNewline
Write-Host "Version bumped: $oldVersion → $newVersion"

# ── 2. Stage everything (config.yaml + any other modified files) ───────────────
git -C $RepoRoot add -A
if ($LASTEXITCODE -ne 0) { Write-Error "git add failed"; exit 1 }

# ── 3. Build commit message ────────────────────────────────────────────────────
if (-not $Message) {
    $Message = "chore: release v$newVersion"
}
$fullMessage = "$Message`n`nCo-Authored-By: Oz <oz-agent@warp.dev>"

git -C $RepoRoot commit -m $fullMessage
if ($LASTEXITCODE -ne 0) { Write-Error "git commit failed"; exit 1 }

# ── 4. Push (uses github-techazm SSH alias in ~/.ssh/config) ──────────────────
git -C $RepoRoot push origin main
if ($LASTEXITCODE -ne 0) { Write-Error "git push failed"; exit 1 }

Write-Host ""
Write-Host "Pushed v$newVersion to origin/main"
