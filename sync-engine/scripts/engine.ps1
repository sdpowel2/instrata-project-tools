<#
  Calls the sync engine's internal admin endpoints. Reads ENGINE_INTERNAL_SECRET
  from the CLIPBOARD (copy it from your password manager first), so the secret
  is never typed, shown, or saved in PowerShell history.

  Usage (from the repo folder):
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 status
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 backfill-preview
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 backfill
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 requeue-linked
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 measure-diff    (dry run: reset dry baseline, re-check all)
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 diff-report     (CSV to Desktop: monday now vs Salesforce)
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 sweep
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 estimator-preview      (CSV to Desktop: Estimator cleanup, read-only)
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 estimator-first-pass   (writes the Estimators; asks first)
    powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 reconcile 006XXXXXXXXXXXXXXX

  Add -App instrata-sync-engine to target production (default: staging).
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'backfill-preview', 'backfill', 'requeue-linked', 'measure-diff', 'diff-report', 'sweep', 'reconcile', 'estimator-preview', 'estimator-first-pass')]
  [string]$Command,
  [Parameter(Position = 1)]
  [string]$OpportunityId,
  [string]$App = 'instrata-sync-engine-staging'
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 doesn't offer TLS 1.2 by default; Fly requires it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$base = "https://$App.fly.dev"

[void](Read-Host "Copy ENGINE_INTERNAL_SECRET for $App to the clipboard, then press Enter")
$secret = (Get-Clipboard -Raw)
if ($null -eq $secret) { $secret = '' }
$secret = $secret.Trim()
if ($secret -notmatch '^[0-9a-f]{64}$') { throw 'Clipboard does not hold a 64-character ENGINE_INTERNAL_SECRET. Copy it and run again.' }
Set-Clipboard -Value ' '
Write-Host "  got it - clipboard cleared" -ForegroundColor Green
$headers = @{ 'x-internal-secret' = $secret }

function Call([string]$method, [string]$path, $body) {
  # 15 minutes: an Estimator first pass writes one line at a time and Salesforce runs its flows on each.
  $request = @{ Method = $method; Uri = "$base$path"; Headers = $headers; TimeoutSec = 900 }
  if ($null -ne $body) { $request.Body = ($body | ConvertTo-Json -Compress); $request.ContentType = 'application/json' }
  try {
    return Invoke-RestMethod @request
  } catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    throw "Engine call failed: $msg"
  }
}

switch ($Command) {
  'status'           { $r = Call 'GET' '/status' $null }
  'backfill-preview' { Write-Host 'Previewing backfill (nothing is saved)...'; $r = Call 'POST' '/admin/backfill' @{ preview = $true } }
  'backfill'         { Write-Host 'Running backfill (saves links + problem tasks, queues reconciles)...'; $r = Call 'POST' '/admin/backfill' @{ preview = $false } }
  'requeue-linked'   { $r = Call 'POST' '/admin/requeue-linked' @{} }
  'measure-diff'     { Write-Host 'Resetting the DRY-RUN baseline and re-checking every linked item...'; $r = Call 'POST' '/admin/requeue-linked' @{ resetDryRunBaseline = $true } }
  'diff-report' {
    Write-Host 'Building the review report from live monday + Salesforce data (read-only)...'
    $csv = Call 'GET' '/admin/diff-report?format=csv' $null
    $desktop = [Environment]::GetFolderPath('Desktop')
    $path = Join-Path $desktop ("sync-review-{0}-{1}.csv" -f $App, (Get-Date -Format 'yyyyMMdd-HHmm'))
    # UTF-8 with BOM so Excel shows names with accents and the em dashes correctly.
    [IO.File]::WriteAllText($path, $csv, (New-Object System.Text.UTF8Encoding $true))
    $lines = ($csv -split "`r`n" | Where-Object { $_ -ne '' }).Count - 1
    Write-Host ("Saved {0} rows to {1}" -f $lines, $path) -ForegroundColor Green
    Invoke-Item $path
    return
  }
  'sweep'            { $r = Call 'POST' '/admin/sweep' @{} }
  'estimator-preview' {
    Write-Host 'Building the Estimator cleanup preview (read-only)...'
    $csv = Call 'POST' '/admin/estimator-first-pass?format=csv' @{ apply = $false }
    $desktop = [Environment]::GetFolderPath('Desktop')
    $path = Join-Path $desktop ("estimator-preview-{0}-{1}.csv" -f $App, (Get-Date -Format 'yyyyMMdd-HHmm'))
    [IO.File]::WriteAllText($path, $csv, (New-Object System.Text.UTF8Encoding $true))
    $lines = ($csv -split "`r`n" | Where-Object { $_ -ne '' }).Count - 1
    Write-Host ("Saved {0} rows to {1}" -f $lines, $path) -ForegroundColor Green
    Invoke-Item $path
    return
  }
  'estimator-first-pass' {
    # live = true: writes the Estimators even while the engine is in dry run (only that
    # field; the engine refuses every other write on this run).
    $answer = Read-Host 'This WRITES the Estimator in Salesforce on every open linked deal, even in dry run (each engineer gets the Salesforce alert email). Type YES to continue'
    if ($answer -cne 'YES') { Write-Host 'Cancelled.'; return }
    $r = Call 'POST' '/admin/estimator-first-pass' @{ apply = $true; live = $true }
  }
  'reconcile' {
    if ($OpportunityId -notmatch '^006[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$') { throw 'Give an opportunity id: engine.ps1 reconcile 006...' }
    $r = Call 'POST' "/admin/reconcile/$OpportunityId" @{}
  }
}

$r | ConvertTo-Json -Depth 8
