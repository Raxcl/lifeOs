<#
.SYNOPSIS
  Auto-increment the patch version across package.json, tauri.conf.json and Cargo.toml.
.USAGE
  powershell -File scripts\bump-version.ps1
  powershell -File scripts\bump-version.ps1 -DryRun
#>
param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Use UTF-8 for all file I/O to preserve CJK characters
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Resolve paths relative to this script
$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $scriptsDir "..\desktop"

$files = @(
  @{ Path = Join-Path $desktopDir "package.json";              Regex = [regex]'("version"\s*:\s*")([^"]+)' }
  @{ Path = Join-Path $desktopDir "src-tauri\tauri.conf.json"; Regex = [regex]'("version"\s*:\s*")([^"]+)' }
  @{ Path = Join-Path $desktopDir "src-tauri\Cargo.toml";      Regex = [regex]::new('(^version\s*=\s*")([^"]+)', 'Multiline') }
)

# Read current version from the first file
$firstContent = [System.IO.File]::ReadAllText($files[0].Path, $utf8NoBom)
$m = $files[0].Regex.Match($firstContent)
if (-not $m.Success) {
  Write-Error "Cannot find version in $($files[0].Path)"
  exit 1
}
$currentVersion = $m.Groups[2].Value
$parts = $currentVersion -split '\.'
if ($parts.Count -ne 3) {
  Write-Error "Version '$currentVersion' is not in major.minor.patch format"
  exit 1
}

$patch = [int]$parts[2] + 1
$newVersion = "$($parts[0]).$($parts[1]).$patch"

if ($DryRun) {
  Write-Host "[dry-run] $currentVersion -> $newVersion" -ForegroundColor Cyan
} else {
  Write-Host "Bumping version: $currentVersion -> $newVersion" -ForegroundColor Green
}

foreach ($file in $files) {
  $path = $file.Path
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Warning "File not found: $path"
    continue
  }

  $content = [System.IO.File]::ReadAllText($path, $utf8NoBom)
  $newContent = $file.Regex.Replace($content, "`${1}$newVersion")

  if ($newContent -eq $content) {
    Write-Warning "No version found in $path, skipped"
    continue
  }

  if (-not $DryRun) {
    [System.IO.File]::WriteAllText($path, $newContent, $utf8NoBom)
  }

  Write-Host "  Updated: $path" -ForegroundColor DarkGray
}

# Output the new version for use by other scripts
Write-Output $newVersion
