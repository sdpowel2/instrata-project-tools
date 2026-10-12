<#
  Sets the sync engine's Fly secrets by reading each value from the clipboard, so
  no secret is ever typed, shown, or saved in PowerShell's history file.

  Staging (defaults):
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\set-secrets.ps1

  Production (later):
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\set-secrets.ps1 `
      -App instrata-sync-engine -Schema public -SalesforceLoginUrl https://instrata.my.salesforce.com

  Secrets are staged (--stage): saved, but nothing restarts until the next deploy.
  The integration user id is not a secret; it lives in fly.toml [env].
#>
param(
  [string]$App = 'instrata-sync-engine-staging',
  [ValidateSet('sync_sandbox', 'public')]
  [string]$Schema = 'sync_sandbox',
  [ValidateSet('dry_run', 'live')]
  [string]$Mode = 'dry_run',
  [string]$SalesforceLoginUrl = 'https://instrata--partial.sandbox.my.salesforce.com'
)

$ErrorActionPreference = 'Stop'

$fly = (Get-Command fly -ErrorAction SilentlyContinue).Source
if (-not $fly) { $fly = Join-Path $env:USERPROFILE '.fly\bin\fly.exe' }
if (-not (Test-Path $fly)) { throw "Can't find fly. Install flyctl or check $fly" }

# Values come from the CLIPBOARD, not from typing or pasting: Windows PowerShell
# turns Ctrl+V in a hidden prompt into a single character. Copy the value in your
# password manager, press Enter here, and the script reads it. Only its length is shown.
$script:lastValue = $null
function Read-Secret([string]$label, [scriptblock]$check, [string]$hint) {
  while ($true) {
    [void](Read-Host "Copy $label to the clipboard, then press Enter")
    $value = (Get-Clipboard -Raw)
    if ($null -eq $value) { $value = '' }
    $value = $value.Trim()
    if ($value -eq '') { Write-Host '  (clipboard is empty - copy the value and try again)' -ForegroundColor Yellow; continue }
    if ($value -match '[\r\n]') { Write-Host '  (clipboard has more than one line - copy just the value)' -ForegroundColor Yellow; continue }
    if ($value -eq $script:lastValue) { Write-Host '  (same value as the previous prompt - did the copy happen? try again)' -ForegroundColor Yellow; continue }
    if ($check -and -not (& $check $value)) { Write-Host "  ($hint - try again)" -ForegroundColor Yellow; continue }
    Write-Host "  got it ($($value.Length) characters)" -ForegroundColor Green
    $script:lastValue = $value
    return $value
  }
}

Write-Host ""
Write-Host "Setting secrets on $App  (schema=$Schema, mode=$Mode)" -ForegroundColor Cyan
Write-Host "For each prompt: copy the value in your password manager, then press Enter. Values are never shown."
Write-Host ""

$secrets = [ordered]@{
  DATABASE_URL = Read-Secret 'DATABASE_URL (Staging - DATABASE_URL)' {
    param($v) $v -match '^postgres(ql)?://sync_engine\.' -and $v -match ':5432/'
  } 'should start postgresql://sync_engine. and use port :5432'
  MONDAY_API_TOKEN           = Read-Secret 'MONDAY_API_TOKEN (monday - AV Integrations API token)' $null ''
  MONDAY_WEBHOOK_PATH_SECRET = Read-Secret 'MONDAY_WEBHOOK_PATH_SECRET' { param($v) $v -match '^[0-9a-f]{64}$' } 'expected the 64-character value from Step 1'
  SF_CLIENT_ID               = Read-Secret 'SF_CLIENT_ID (Consumer Key)' $null ''
  SF_CLIENT_SECRET           = Read-Secret 'SF_CLIENT_SECRET (Consumer Secret)' $null ''
  SF_WEBHOOK_SECRET          = Read-Secret 'SF_WEBHOOK_SECRET' { param($v) $v -match '^[0-9a-f]{64}$' } 'expected the 64-character value from Step 1'
  ENGINE_INTERNAL_SECRET     = Read-Secret 'ENGINE_INTERNAL_SECRET' { param($v) $v -match '^[0-9a-f]{64}$' } 'expected the 64-character value from Step 1'
}
$secrets['DB_SCHEMA'] = $Schema
$secrets['SYNC_MODE'] = $Mode
$secrets['SF_LOGIN_URL'] = $SalesforceLoginUrl

$distinct = @($secrets['MONDAY_WEBHOOK_PATH_SECRET'], $secrets['SF_WEBHOOK_SECRET'], $secrets['ENGINE_INTERNAL_SECRET']) | Select-Object -Unique
if ($distinct.Count -ne 3) { throw 'The three Step 1 secrets must all be different - one was pasted twice.' }

# Passed as arguments, NOT piped: Windows PowerShell 5.1 prepends a UTF-8 byte-order
# mark to anything piped into a native program (even with a no-BOM $OutputEncoding),
# which fly reads as part of the first secret's name. Arguments built here never
# reach PowerShell's history; only typed lines do.
foreach ($kv in $secrets.GetEnumerator()) {
  if ($kv.Value -match '[\s"]') { throw "$($kv.Key) contains a space or a double quote; check the value you copied." }
}
$pairs = @($secrets.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
& $fly secrets set -a $App --stage @pairs
if ($LASTEXITCODE -ne 0) { throw "fly secrets set failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done. Secrets now on ${App}:" -ForegroundColor Green
& $fly secrets list -a $App

# Don't leave the last secret sitting on the clipboard.
Set-Clipboard -Value ' '
Write-Host "(Clipboard cleared.)"
