# recheck-awesome-pr.ps1 — re-trigger the awesome-dsh-plugin Submission gate.
#
# The gate needs the plugin repo to be >= 1 day old. Once that passes, push an
# empty commit to the PR branch and CI re-runs on the same PR (no new PR needed).
#
# Usage:  pwsh scripts/recheck-awesome-pr.ps1            # push when age is met
#         pwsh scripts/recheck-awesome-pr.ps1 -Force     # push regardless
#
# Token:  read from $DSH_HOME/secrets/github-token.txt (one-time setup).
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$REPO_CREATED_AT = '2026-08-16T18:08:28Z'   # github.com/863683348/dsh-plugin-audit created_at
$PR_BRANCH       = 'add/dsh-plugin-audit'
$FORK_OWNER      = '863683348'
$FORK_REPO       = 'awesome-dsh-plugin'
$TOKEN_FILE = Join-Path $env:DSH_HOME "secrets\github-token.txt"
$root = Split-Path $PSScriptRoot -Parent
$forkDir = Join-Path (Split-Path $root -Parent) "awesome-upstream"

if (-not (Test-Path $TOKEN_FILE)) { throw "missing $TOKEN_FILE — create it (one-time): $TOKEN_FILE" }
$token = (Get-Content $TOKEN_FILE -Raw).Trim()

if (-not (Test-Path $forkDir)) { throw "fork clone not found at $forkDir" }

# --- age gate hint ---
$created = [datetime]$REPO_CREATED_AT
$ageDays = (New-TimeSpan -Start $created -End (Get-Date)).TotalDays
if ($ageDays -lt 1.0 -and -not $Force) {
  Write-Host "repo is $([math]::Round($ageDays, 2)) day(s) old - Submission gate needs >= 1 day."
  Write-Host ("ready after: " + $created.AddDays(1).ToString("yyyy-MM-dd HH:mm") + " UTC")
  Write-Host "rerun then, or pass -Force to push anyway."
  exit 0
}

Push-Location $forkDir
try {
  git commit --allow-empty -m "ci: re-run after repo age gate" 2>&1 | Out-Null
  $remote = "https://x-access-token:$token@github.com/$FORK_OWNER/$FORK_REPO.git"
  git -c http.sslBackend=openssl -c credential.helper= push $remote "HEAD:$PR_BRANCH" 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { throw "push failed (exit $LASTEXITCODE)" }
  Write-Host "OK - empty commit pushed to $FORK_OWNER/$FORK_REPO@$PR_BRANCH"
  Write-Host "PR: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1200"
  Write-Host "Watch the Submission gate re-run (a few minutes)."
} finally { Pop-Location }