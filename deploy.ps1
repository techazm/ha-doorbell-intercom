<#
.SYNOPSIS
    Release the add-on: bump the patch version in config.yaml on a release branch,
    open a pull request and let GitHub squash-merge it once the checks are green.

.DESCRIPTION
    main is protected (no direct pushes), so releases go through a PR like any other
    change. Requires the GitHub CLI (gh) logged in as an account with write access.

.USAGE
    .\deploy.ps1 [-Message "optional PR title"]
#>
param(
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot   = $PSScriptRoot
$ConfigFile = Join-Path $RepoRoot "doorbell_intercom\config.yaml"

function Invoke-Git { git -C $RepoRoot @args; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

# 1. Start from an up-to-date main.
Invoke-Git fetch origin
Invoke-Git switch main
Invoke-Git pull --ff-only origin main

# 2. Read and bump the patch version.
$content = Get-Content $ConfigFile -Raw
if ($content -notmatch 'version:\s+"(\d+)\.(\d+)\.(\d+)"') { throw "Could not find version string in config.yaml" }
$oldVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
$newVersion = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
$content = $content -replace "version:\s+`"$oldVersion`"", "version: `"$newVersion`""

# 3. Commit the bump on a release branch.
$branch = "release/v$newVersion"
Invoke-Git switch -c $branch
Set-Content $ConfigFile $content -NoNewline
Invoke-Git add $ConfigFile
if (-not $Message) { $Message = "chore(release): v$newVersion" }
Invoke-Git commit -m $Message -m "Bump the add-on version from $oldVersion to $newVersion so Home Assistant offers the update."
Invoke-Git push -u origin $branch
Write-Host "Version bumped: $oldVersion -> $newVersion"

# 4. Open the PR and enable auto-merge (squash) once required checks pass.
gh pr create --repo techazm/ha-doorbell-intercom --base main --head $branch --title $Message `
    --body "Release v$newVersion of the Doorbell Intercom add-on (bumps ``doorbell_intercom/config.yaml`` from $oldVersion)."
if ($LASTEXITCODE -ne 0) { throw "gh pr create failed" }
gh pr merge --repo techazm/ha-doorbell-intercom $branch --squash --auto --delete-branch
if ($LASTEXITCODE -ne 0) { throw "gh pr merge --auto failed" }

Invoke-Git switch main
Write-Host ""
Write-Host "Opened release PR for v$newVersion; it merges automatically when checks are green."
