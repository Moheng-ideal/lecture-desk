# Upload-time secret audit for the lecture-desk repo.
# Run before any `git add` / `git push`:
#   powershell -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
Push-Location $repo
$fail = 0

function Check($label, [bool]$ok) {
    if ($ok) { Write-Host "  [OK]   $label" -ForegroundColor Green }
    else { Write-Host "  [FAIL] $label" -ForegroundColor Red; $script:fail++ }
}

Write-Host "== .gitignore rules =="
$ignore = Get-Content .gitignore -Raw
Check ".sites-runtime/ ignored" ($ignore -match '(?m)^\.sites-runtime/?\s*$')
Check "release/ ignored"        ($ignore -match '(?m)^release/?\s*$')
Check ".env ignored"            ($ignore -match '(?m)^\.env\s*$')
Check "node_modules/ ignored"   ($ignore -match '(?m)^node_modules/?\s*$')
Check "dist/ ignored"           ($ignore -match '(?m)^dist/?\s*$')

Write-Host "== loose key files in the working tree =="
$loose = Get-ChildItem . -Recurse -File -Include '*.p12', '*.keystore', 'store.secret' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\.sites-runtime\*' -and $_.FullName -notlike '*\node_modules\*' }
Check "no *.p12 / store.secret outside .sites-runtime" (-not $loose)
if ($loose) { $loose | ForEach-Object { Write-Host "         $($_.FullName)" } }

Write-Host "== git index (skipped when not a git repo) =="
if (Test-Path .git) {
    $tracked = git ls-files 2>$null | Select-String -Pattern '\.p12|store\.secret|sites-runtime|^\.env$'
    Check "no secrets tracked by git" (-not $tracked)
    $staged = git status --short 2>$null | Select-String -Pattern 'sites-runtime|store\.secret|\.p12|^.. \.env$'
    Check "nothing secret staged" (-not $staged)
} else {
    Write-Host "  [SKIP] not a git repository yet" -ForegroundColor Yellow
}

Write-Host "== packaged artifacts =="
$zip = Get-ChildItem -File -Filter '*.zip' -ErrorAction SilentlyContinue
foreach ($file in $zip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($file.FullName)
    $bad = $archive.Entries | Where-Object { $_.FullName -match 'sites-runtime|\.p12|store\.secret|(^|/)\.env$' }
    $archive.Dispose()
    Check "$($file.Name) has no secrets" (-not $bad)
}

Write-Host ""
if ($fail -eq 0) {
    Write-Host "All checks passed - safe to commit." -ForegroundColor Green
    Pop-Location
    exit 0
} else {
    Write-Host "$fail check(s) failed - do NOT commit." -ForegroundColor Red
    Pop-Location
    exit 1
}
