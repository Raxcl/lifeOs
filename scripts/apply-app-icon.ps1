[CmdletBinding()]
param(
  [string]$SourcePath,
  [switch]$SkipWhenUnconfigured
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$desktopDir = Join-Path $repoRoot "desktop"
$iconsDir = Join-Path $desktopDir "src-tauri\icons"

function Get-SettingsCandidates {
  $names = @(
    "com.lifeos.morning-journal",
    "LifeOS Morning Journal",
    "lifeos-morning-journal"
  )
  $roots = @(
    [Environment]::GetFolderPath("ApplicationData"),
    [Environment]::GetFolderPath("LocalApplicationData")
  ) | Where-Object { $_ }

  foreach ($root in $roots) {
    foreach ($name in $names) {
      Join-Path (Join-Path $root $name) "settings.json"
    }
  }
}

function Get-ConfiguredIconSource {
  foreach ($candidate in Get-SettingsCandidates) {
    if (-not (Test-Path -LiteralPath $candidate)) {
      continue
    }

    try {
      $settings = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($settings.app_icon_source) {
        return [string]$settings.app_icon_source
      }
    } catch {
      Write-Verbose "Skipped unreadable settings file: $candidate"
    }
  }

  return $null
}

function ConvertFrom-Utf8AsAnsiMojibake {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  try {
    $ansi = [Text.Encoding]::GetEncoding(936)
  } catch {
    Add-Type -AssemblyName System.Text.Encoding.CodePages -ErrorAction SilentlyContinue
    [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
    $ansi = [Text.Encoding]::GetEncoding(936)
  }

  return [Text.Encoding]::UTF8.GetString($ansi.GetBytes($Value))
}

function Resolve-ExistingPath {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return (Resolve-Path -LiteralPath $Path).Path
  }

  $repaired = ConvertFrom-Utf8AsAnsiMojibake -Value $Path
  if ($repaired -and (Test-Path -LiteralPath $repaired -PathType Leaf)) {
    Write-Host "Repaired stored icon path encoding."
    return (Resolve-Path -LiteralPath $repaired).Path
  }

  throw "App icon source does not exist: $Path"
}

function Resolve-IconSource {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Get-ConfiguredIconSource
  }

  if ([string]::IsNullOrWhiteSpace($Path)) {
    if ($SkipWhenUnconfigured) {
      return $null
    }
    throw "No app icon source was provided. Choose one in Settings or pass -SourcePath."
  }

  $resolved = Resolve-ExistingPath -Path $Path

  $extension = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
  if ($extension -notin @(".png", ".jpg", ".jpeg", ".ico")) {
    throw "Unsupported app icon source. Use PNG, JPG, JPEG, or ICO."
  }

  return $resolved
}

function New-NormalizedIconPng {
  param([string]$Path)

  Add-Type -AssemblyName System.Drawing

  $target = Join-Path ([IO.Path]::GetTempPath()) ("lifeos-app-icon-{0}-{1}.png" -f $PID, [DateTimeOffset]::Now.ToUnixTimeMilliseconds())
  $image = [System.Drawing.Image]::FromFile($Path)
  $bitmap = New-Object System.Drawing.Bitmap 1024, 1024, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

    $scale = [Math]::Max(1024 / $image.Width, 1024 / $image.Height)
    $width = [int][Math]::Round($image.Width * $scale)
    $height = [int][Math]::Round($image.Height * $scale)
    $x = [int][Math]::Round((1024 - $width) / 2)
    $y = [int][Math]::Round((1024 - $height) / 2)

    $graphics.DrawImage($image, $x, $y, $width, $height)
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $image.Dispose()
  }

  return $target
}

function Remove-UnusedDesktopIconOutputs {
  $paths = @(
    (Join-Path $iconsDir "64x64.png"),
    (Join-Path $iconsDir "StoreLogo.png"),
    (Join-Path $iconsDir "android"),
    (Join-Path $iconsDir "ios")
  )

  $paths += Get-ChildItem -LiteralPath $iconsDir -Filter "Square*Logo.png" -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }

  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

$source = Resolve-IconSource -Path $SourcePath
if (-not $source) {
  Write-Host "No app icon source configured; skipped icon generation."
  return
}
$normalizedPng = New-NormalizedIconPng -Path $source

try {
  Push-Location $desktopDir
  & npm run tauri:icon -- $normalizedPng
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri icon generation failed with exit code $LASTEXITCODE."
  }
  Remove-UnusedDesktopIconOutputs
} finally {
  Pop-Location
  Remove-Item -LiteralPath $normalizedPng -Force -ErrorAction SilentlyContinue
}

Write-Host "Updated desktop Tauri icon resources in desktop/src-tauri/icons/."
Write-Host "Restart tauri:dev or run from desktop/: npm run tauri:build"
