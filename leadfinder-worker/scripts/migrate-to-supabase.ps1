# One-time copy of the standalone LeadFinder data into Supabase.
#
# Before running: copy the Supabase Postgres connection string (Session pooler URI)
# to the clipboard. If it still says [YOUR-PASSWORD], the script then asks you to
# copy the database password and press Enter. Both are read from the clipboard so
# they never appear on screen or in chat, and the clipboard is cleared afterwards.
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
if ($url.Contains('[YOUR-PASSWORD]')) {
    Write-Host 'Connection string read. Now copy the database password from your password manager,'
    Read-Host 'then press Enter here' | Out-Null
    $pw = (Get-Clipboard -Raw)
    if ($null -eq $pw) { $pw = '' }
    $pw = $pw.Trim()
    if ($pw -eq '' -or $pw -match '^postgres(ql)?://') {
        Set-Clipboard -Value ' '
        throw 'The clipboard does not hold the password. Run the script again.'
    }
    $url = $url.Replace('[YOUR-PASSWORD]', [Uri]::EscapeDataString($pw))
    $pw = $null
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
