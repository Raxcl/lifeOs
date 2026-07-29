<#
.SYNOPSIS
  一键构建 LifeOS 桌面应用，并将安装包输出到仓库根目录的 dist/ 文件夹。
.USAGE
  .\build.ps1            # 完整构建（自动安装依赖）
  .\build.ps1 -SkipCheck # 跳过环境检查，直接构建
#>
[CmdletBinding()]
param(
    [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"

$repoRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $repoRoot "desktop"
$distDir    = Join-Path $repoRoot "dist"

Write-Host ""
Write-Host "=== LifeOS 一键构建 ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. 环境检查 ---
if (-not $SkipCheck) {
    Write-Host "[1/4] 检查构建环境..." -ForegroundColor Yellow

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Error "未找到 Node.js，请先安装: https://nodejs.org/"
        exit 1
    }
    Write-Host "  Node.js  $(node --version)" -ForegroundColor DarkGray

    $rustc = Get-Command rustc -ErrorAction SilentlyContinue
    if (-not $rustc) {
        Write-Error "未找到 Rust，请先安装: https://rustup.rs/"
        exit 1
    }
    Write-Host "  Rust     $(rustc --version)" -ForegroundColor DarkGray

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) {
        Write-Error "未找到 npm，请确认 Node.js 安装完整。"
        exit 1
    }
    Write-Host "  环境检查通过" -ForegroundColor Green
} else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) {
        Write-Error "未找到 npm，无法继续构建。"
        exit 1
    }
}

# --- 2. 安装依赖 ---
Write-Host "[2/4] 安装前端依赖..." -ForegroundColor Yellow
Push-Location $desktopDir
try {
    if (-not (Test-Path "node_modules")) {
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    } else {
        Write-Host "  node_modules 已存在，跳过安装" -ForegroundColor DarkGray
    }

    # --- 3. 执行构建 ---
    Write-Host "[3/4] 正在构建桌面应用（首次构建可能需要几分钟）..." -ForegroundColor Yellow
    & $npm.Source run tauri:build
    if ($LASTEXITCODE -ne 0) { throw "构建失败，请检查上方错误信息" }
}
finally {
    Pop-Location
}

# --- 4. 收集产物到 dist/ ---
Write-Host "[4/4] 收集安装包到 dist/ ..." -ForegroundColor Yellow

$bundleDir = Join-Path $desktopDir "src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    Write-Warning "未找到 NSIS 输出目录: $bundleDir"
    Write-Host "构建已完成，但安装包位置未确定，请手动查看上述目录。" -ForegroundColor DarkGray
    exit 0
}

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$installers = Get-ChildItem -Path $bundleDir -Filter "*.exe"
if ($installers.Count -eq 0) {
    Write-Warning "bundle/nsis 目录下未找到 .exe 安装包"
    exit 0
}

foreach ($file in $installers) {
    $dest = Join-Path $distDir $file.Name
    Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
    Write-Host "  已复制: $($file.Name)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== 构建完成 ===" -ForegroundColor Green
Write-Host "安装包位置: $distDir" -ForegroundColor Green
Write-Host ""

# 自动打开 dist 文件夹
explorer.exe $distDir
