# One-time copy of the standalone LeadFinder data into Supabase.
#
# Before running: copy the Supabase Postgres connection string (Session pooler URI,
# with the password filled in) to the clipboard. This script reads it from the
# clipboard so it never appears on screen or in chat.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File leadfinder-worker\scripts\migrate-to-supabase.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$worker = Join-Path $repo 'leadfinder-worker'
$python = Join-Path $repo 'LeadFinder\LeadFinder\.venv\Scripts\python.exe'
$sqlite = Join-Path $repo 'LeadFinder\LeadFinder\data\leadfinder.db'

if (-not (Test-Path $python)) { throw "Python not found at $python" }
if (-not (Test-Path $sqlite)) { throw "Old database not found at $sqlite" }

$url = (Get-Clipboard -Raw)
if ($null -eq $url) { $url = '' }
$url = $url.Trim()
if (-not ($url -match '^postgres(ql)?://')) {
    throw 'The clipboard does not hold a postgres:// connection string. Copy it from Supabase first.'
}

$env:DATABASE_URL = $url
$env:PYTHONUNBUFFERED = '1'
Push-Location $worker
try {
    & $python -m pip install --quiet "psycopg[binary]>=3.2"
    & $python -m leadfinder migrate-to-supabase --sqlite $sqlite
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    Set-Clipboard -Value ' '
}
if ($code -eq 0) {
    Write-Host ''
    Write-Host 'Done. The clipboard was cleared.' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "The copy stopped with exit code $code. The clipboard was cleared." -ForegroundColor Red
}
