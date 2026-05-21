$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$project = Join-Path $root 'design-package\process-doc-2026\project'
$assets  = Join-Path $project 'assets'
$out     = Join-Path $root 'Process Doc.html'

function ToB64Uri([string]$path, [string]$mime) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $b64   = [System.Convert]::ToBase64String($bytes)
    return "data:$mime;base64,$b64"
}

$wordmarkWhiteUri = ToB64Uri (Join-Path $assets 'logo-wordmark-white.png') 'image/png'
$logomarkUri      = ToB64Uri (Join-Path $assets 'logo-logomark.png')       'image/png'
$faviconUri       = ToB64Uri (Join-Path $assets 'favicon.svg')             'image/svg+xml'

$css   = Get-Content (Join-Path $assets 'colors_and_type.css') -Raw -Encoding UTF8
$html  = Get-Content (Join-Path $project 'Process Doc.html')  -Raw -Encoding UTF8
$steps = Get-Content (Join-Path $project 'steps.js')          -Raw -Encoding UTF8
$org   = Get-Content (Join-Path $project 'orgchart.js')       -Raw -Encoding UTF8

# Replace the local Gantari @font-face with a Google Fonts import (so no external
# files are required alongside the standalone HTML).
$gantariFace = @"
@font-face {
  font-family: 'Gantari';
  src: url('fonts/Gantari-VariableFont_wght.ttf') format('truetype-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
"@
if (-not $css.Contains($gantariFace)) { throw "Gantari @font-face block not found in colors_and_type.css" }
$css = $css.Replace($gantariFace, '')

# Drop the original JetBrains Mono @import (we'll add a combined one).
$css = [regex]::Replace($css, "@import url\('https://fonts\.googleapis\.com/css2\?family=JetBrains\+Mono[^']*'\);", '')

# Prepend a combined Gantari + JetBrains Mono Google Fonts import.
$cssImport = "@import url('https://fonts.googleapis.com/css2?family=Gantari:wght@100..900&family=JetBrains+Mono:wght@400;500&display=swap');"
$css = $cssImport + "`n" + $css

# Inline the design-tokens stylesheet in place of the <link> reference.
$linkTag = '<link rel="stylesheet" href="assets/colors_and_type.css" />'
if (-not $html.Contains($linkTag)) { throw "design tokens <link> not found in Process Doc.html" }
$html = $html.Replace($linkTag, "<style>`n$css`n</style>")

# Swap asset URL references for data URIs.
$html = $html.Replace('href="assets/favicon.svg"',          ('href="'  + $faviconUri       + '"'))
$html = $html.Replace('src="assets/logo-wordmark-white.png"', ('src="' + $wordmarkWhiteUri + '"'))
$html = $html.Replace("url('assets/logo-logomark.png')",      ("url('" + $logomarkUri      + "')"))

# Inline steps.js in place of the external <script> reference.
$stepsScript = '<script src="steps.js"></script>'
if (-not $html.Contains($stepsScript)) { throw "<script src=`"steps.js`"> tag not found" }
$html = $html.Replace($stepsScript, "<script>`n$steps`n</script>")

# Inline orgchart.js in place of the external <script> reference.
$orgScript = '<script src="orgchart.js"></script>'
if (-not $html.Contains($orgScript)) { throw "<script src=`"orgchart.js`"> tag not found" }
$html = $html.Replace($orgScript, "<script>`n$org`n</script>")

# Verify no leftover references to assets/, steps.js or orgchart.js.
$leftover = [regex]::Matches($html, '(assets/[A-Za-z0-9_./-]+|steps\.js|orgchart\.js)')
if ($leftover.Count -gt 0) {
    $names = ($leftover | ForEach-Object { $_.Value } | Sort-Object -Unique) -join ', '
    throw "Leftover asset references in HTML: $names"
}

[System.IO.File]::WriteAllText($out, $html, [System.Text.UTF8Encoding]::new($false))
"Wrote $out ($([System.IO.File]::ReadAllBytes($out).Length) bytes)"
