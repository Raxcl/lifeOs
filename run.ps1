<#
.SYNOPSIS
  一键启动 LifeOS 桌面应用（优先使用已构建的 release，否则进入开发模式）。
.USAGE
  .\run.ps1              # 自动选择 release 或 dev 模式
  .\run.ps1 -Dev         # 强制使用开发模式
#>
[CmdletBinding()]
param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

$repoRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $repoRoot "desktop"
$releaseExe = Join-Path $desktopDir "src-tauri\target\release\lifeos-morning-journal.exe"

# 优先启动已构建的 release 版本
if (-not $Dev -and (Test-Path -LiteralPath $releaseExe)) {
    Write-Host "启动 Release 版本..." -ForegroundColor Green
    Start-Process -FilePath $releaseExe -WorkingDirectory $desktopDir
    exit 0
}

# 否则进入开发模式
Write-Host "启动开发模式..." -ForegroundColor Yellow

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) {
    Write-Error "未找到 npm。请先安装 Node.js，或运行 .\build.ps1 构建 release 版本。"
    exit 1
}

Push-Location $desktopDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "首次运行，正在安装依赖..." -ForegroundColor DarkGray
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    }
    & $npm.Source run tauri:dev
}
finally {
    Pop-Location
}
