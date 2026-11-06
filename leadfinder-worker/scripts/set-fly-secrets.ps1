# Sets the Lead Finder worker's Fly secrets (app instrata-leadfinder) without showing them.
#
#   - SAM_API_KEY, HTTP_USER_AGENT_CONTACT, APS_CLIENT_ID, APS_CLIENT_SECRET: read from the
#     old LeadFinder\LeadFinder\.env
#   - SUPABASE_URL, SUPABASE_ANON_KEY: read from app\local.env (VITE_SUPABASE_*)
#   - DATABASE_URL: from the clipboard (Supabase Session pooler URI); if it still says
#     [YOUR-PASSWORD] you are asked to copy the password and press Enter
#
# ANTHROPIC_API_KEY and DOWNLOAD_SIGNING_KEY are left out: bid documents and triage are
# off on the interim Fly deploy (DOCUMENTS_ENABLED=false in fly.toml).
#
# Values go to `fly secrets import` on stdin, so they never appear on screen or in the
# process list. Staged: they take effect on the first deploy.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File leadfinder-worker\scripts\set-fly-secrets.ps1

$ErrorActionPreference = 'Stop'
$app = 'instrata-leadfinder'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Read-EnvFile([string]$path) {
    $values = @{}
    if (-not (Test-Path $path)) { throw "Not found: $path" }
    foreach ($raw in Get-Content $path) {
        $line = $raw.TrimStart([char]0xFEFF)
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $v = $Matches[2].Trim()
            if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            $values[$Matches[1]] = $v
        }
    }
    return $values
}

$old = Read-EnvFile (Join-Path $repo 'LeadFinder\LeadFinder\.env')
$web = Read-EnvFile (Join-Path $repo 'app\local.env')

$secrets = [ordered]@{}
foreach ($name in 'SAM_API_KEY', 'HTTP_USER_AGENT_CONTACT', 'APS_CLIENT_ID', 'APS_CLIENT_SECRET') {
    if (-not $old[$name]) { throw "$name is empty in LeadFinder\LeadFinder\.env" }
    $secrets[$name] = $old[$name]
}
if (-not $web['VITE_SUPABASE_URL'] -or -not $web['VITE_SUPABASE_ANON_KEY']) {
    throw 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing in app\local.env'
}
$secrets['SUPABASE_URL'] = $web['VITE_SUPABASE_URL']
$secrets['SUPABASE_ANON_KEY'] = $web['VITE_SUPABASE_ANON_KEY']

$url = (Get-Clipboard -Raw)
if ($null -eq $url) { $url = '' }
$url = $url.Trim()
if (-not ($url -match '^postgres(ql)?://')) {
    throw 'The clipboard does not hold a postgres:// connection string. Copy the Session pooler URI from Supabase first.'
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
$secrets['DATABASE_URL'] = $url

$count = $secrets.Count
$lines = ($secrets.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
# Windows PowerShell can pipe text to programs with a byte-order mark (here the console's
# input encoding is UTF-8 with BOM), which fly reads as part of the first secret name.
# Send plain UTF-8 instead, and put the console back afterwards.
$utf8 = New-Object System.Text.UTF8Encoding $false
$prevInput = [Console]::InputEncoding
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8
try {
    $lines | fly secrets import --app $app --stage
    $code = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $prevInput
    $lines = $null
    $secrets = $null
    Set-Clipboard -Value ' '
}
Write-Host ''
if ($code -eq 0) {
    Write-Host "Staged $count secrets for $app. The clipboard was cleared." -ForegroundColor Green
    fly secrets list --app $app
} else {
    Write-Host "fly secrets import failed (exit code $code). The clipboard was cleared." -ForegroundColor Red
}
