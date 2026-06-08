[CmdletBinding()]
param(
    [switch]$PreferDev,
    [string]$ExecutablePath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$desktopDir = Join-Path $repoRoot "desktop"
$releaseExe = Join-Path $desktopDir "src-tauri\target\release\lifeos-morning-journal.exe"

if ($ExecutablePath -and (Test-Path -LiteralPath $ExecutablePath)) {
    Start-Process -FilePath (Resolve-Path -LiteralPath $ExecutablePath) -WorkingDirectory $desktopDir
    exit 0
}

if (-not $PreferDev -and (Test-Path -LiteralPath $releaseExe)) {
    Start-Process -FilePath $releaseExe -WorkingDirectory $desktopDir
    exit 0
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
}

if (-not $npm) {
    throw "npm was not found. Install Node.js or build the Tauri app, then run this launcher again."
}

Push-Location $desktopDir
try {
    & $npm.Source run tauri:dev
}
finally {
    Pop-Location
}
