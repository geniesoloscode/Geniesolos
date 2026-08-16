<#
    build-og.ps1 - regenerate assets/og-card.png from assets/og-card.html

    The OG card is the image that renders in every link preview (LinkedIn,
    Slack, iMessage, Facebook, X). Its text duplicates claims made in
    index.html's meta tags, so it has to be rebuilt whenever those change.

    Usage, from anywhere:
        pwsh -File scripts\build-og.ps1

    Notes for whoever touches this next:
      * Output paths passed to Chrome MUST be absolute. Given a relative
        path Chrome fails to write the file, reports the error only on
        stderr, and still exits 0 - so a no-op run looks like a success.
        This script resolves everything to absolute paths for that reason.
      * The card pulls webfonts from Google Fonts, so the build needs
        network access. --virtual-time-budget gives them time to load;
        without it the screenshot can land on fallback system fonts.
#>

[CmdletBinding()]
param(
    [string]$ChromePath,
    [int]$VirtualTimeBudgetMs = 10000
)

$ErrorActionPreference = 'Stop'

# Resolve paths relative to this script, not the caller's working directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
$source   = Join-Path $repoRoot 'assets\og-card.html'
$output   = Join-Path $repoRoot 'assets\og-card.png'

if (-not (Test-Path $source)) {
    throw "Source not found: $source"
}

# Locate Chrome unless the caller named it explicitly.
if (-not $ChromePath) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath) {
    throw "Chrome not found. Pass -ChromePath 'C:\path\to\chrome.exe'."
}

$sizeBefore = if (Test-Path $output) { (Get-Item $output).Length } else { 0 }

Write-Host "Rendering $source -> $output"

& $ChromePath `
    --headless=new `
    --disable-gpu `
    --hide-scrollbars `
    --force-device-scale-factor=1 `
    --window-size=1200,630 `
    --virtual-time-budget=$VirtualTimeBudgetMs `
    --screenshot="$output" `
    ("file:///" + ($source -replace '\\', '/')) 2>&1 |
    Where-Object { $_ -notmatch 'registration_request|DEPRECATED_ENDPOINT|GCM' } |
    ForEach-Object { Write-Host "  $_" }

# Chrome exits 0 even when it fails to write, so verify the artifact itself.
if (-not (Test-Path $output)) {
    throw "Chrome reported success but no file was written to $output"
}

$item = Get-Item $output
if ($item.Length -eq $sizeBefore -and $sizeBefore -ne 0) {
    Write-Warning "Output byte size is unchanged ($sizeBefore). If you expected a visual change, confirm the render actually picked up your edit."
}

Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($item.FullName)
$dims = "$($img.Width) x $($img.Height)"
$img.Dispose()

if ($dims -ne '1200 x 630') {
    throw "Expected a 1200 x 630 image, got $dims. Open Graph consumers require 1200x630."
}

Write-Host ""
Write-Host "OK  $($item.FullName)"
Write-Host "    $dims, $([math]::Round($item.Length / 1KB, 1)) KB"
