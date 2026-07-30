<#
.SYNOPSIS
  一键构建 LifeOS 桌面应用，使用 MicaSetup 生成现代化安装包，输出到 dist/ 文件夹。
.USAGE
  .\build.ps1            # 完整构建（自动安装依赖）
  .\build.ps1 -SkipCheck # 跳过环境检查，直接构建
#>
[CmdletBinding()]
param(
    [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $repoRoot "desktop"
$buildDir   = Join-Path $repoRoot "Build"
$distDir    = Join-Path $repoRoot "dist"

Write-Host ""
Write-Host "=== LifeOS 一键构建 ===" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# 工具函数
# ============================================================

function Get-NuGetGlobalPackagesPath {
    $localsOutput = & dotnet nuget locals global-packages --list
    if ($LASTEXITCODE -ne 0) {
        throw "读取 NuGet 全局包缓存失败"
    }
    $globalPackages = ($localsOutput -split ":\s*", 2 | Select-Object -Last 1).Trim()
    if ([string]::IsNullOrWhiteSpace($globalPackages) -or -not (Test-Path $globalPackages)) {
        throw "NuGet 全局包缓存路径无效: $globalPackages"
    }
    return $globalPackages
}

function Restore-MicaSetupTools {
    param([string]$ToolProjectFile)

    # 先检查 NuGet 全局缓存是否已有包
    [xml]$toolProjectXml = Get-Content -LiteralPath $ToolProjectFile -Encoding UTF8
    $packageReference = $toolProjectXml.Project.ItemGroup.PackageReference |
        Where-Object { $_.Include -eq "MicaSetup.Tools" } |
        Select-Object -First 1
    if ($null -eq $packageReference) {
        throw "工具项目缺少 MicaSetup.Tools 包引用"
    }
    $packageVersion = $packageReference.Version

    $globalPackages = Get-NuGetGlobalPackagesPath
    $packageDir = Join-Path $globalPackages "micasetup.tools\$packageVersion"

    if (-not (Test-Path $packageDir)) {
        Write-Host "  还原 MicaSetup.Tools NuGet 包..." -ForegroundColor DarkGray
        & dotnet restore $ToolProjectFile -v q
        if ($LASTEXITCODE -ne 0) {
            throw "还原 MicaSetup.Tools 失败"
        }
    } else {
        Write-Host "  MicaSetup.Tools 已缓存，跳过还原" -ForegroundColor DarkGray
    }

    if (-not (Test-Path $packageDir)) {
        throw "MicaSetup.Tools NuGet 包目录不存在: $packageDir"
    }

    $toolExe = Join-Path $packageDir "build\makemica.exe"
    $toolSevenZip = Join-Path $packageDir "build\bin\7z.exe"
    if (-not (Test-Path $toolExe)) { throw "缺少 makemica.exe: $toolExe" }
    if (-not (Test-Path $toolSevenZip)) { throw "缺少 7z.exe: $toolSevenZip" }

    return [pscustomobject]@{
        Exe      = $toolExe
        SevenZip = $toolSevenZip
        MicaDir  = Join-Path $packageDir "build"
    }
}

function Test-MicaSetupBuildEnvironment {
    $vsRoots = @(
        (Join-Path $env:ProgramFiles "Microsoft Visual Studio\2022\Community\MSBuild"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\MSBuild"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\Community\MSBuild")
    ) | Where-Object { Test-Path $_ }

    if ($vsRoots.Count -eq 0) {
        throw "未找到 Visual Studio 2022 MSBuild。MicaSetup 需要 VS Build Tools 编译安装器。"
    }

    foreach ($vsRoot in $vsRoots) {
        $msBuildExe = Join-Path $vsRoot "Current\Bin\MSBuild.exe"
        $roslynTargets = Join-Path $vsRoot "Current\Bin\Roslyn\Microsoft.CSharp.Core.targets"
        if ((Test-Path $msBuildExe) -and (Test-Path $roslynTargets)) {
            $sdkTargets = Join-Path $vsRoot "Sdks\Microsoft.NET.Sdk\Sdk"
            $sdkRoot = $null
            if (-not (Test-Path $sdkTargets)) {
                # 从 dotnet SDK 获取
                $sdkLine = & dotnet --list-sdks | Where-Object { $_ -match '^8\.' } | Select-Object -Last 1
                if (-not $sdkLine) { $sdkLine = & dotnet --list-sdks | Select-Object -Last 1 }
                if ($sdkLine) {
                    $sdkVersion = $sdkLine.Split(' ')[0]
                    $dotnetRoot = Split-Path -Parent (Get-Command dotnet).Source
                    $sdkRoot = Join-Path $dotnetRoot "sdk\$sdkVersion"
                }
            }
            return [pscustomobject]@{
                MSBuildBin      = (Split-Path -Parent $msBuildExe)
                RoslynBin       = (Split-Path -Parent $roslynTargets)
                MSBuildSDKsPath = $(if ($sdkRoot) { Join-Path $sdkRoot "Sdks" } else { $null })
            }
        }
    }

    throw "VS 2022 缺少 Roslyn 编译器组件，请通过 Visual Studio Installer 修复。"
}

function ConvertTo-CSharpStringLiteral {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return 'null!' }
    $text = [string]$Value
    $text = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $text + '"'
}

function ConvertTo-CSharpBoolLiteral {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return 'null!' }
    if ([System.Convert]::ToBoolean($Value, [Globalization.CultureInfo]::InvariantCulture)) { return 'true' }
    return 'false'
}

function Set-CSharpOptionAssignment {
    param([string]$Content, [string]$Name, [string]$ValueLiteral)
    $pattern = '(option\.' + [regex]::Escape($Name) + '\s*=\s*)[^;]+;'
    return [regex]::Replace($Content, $pattern, { param($match) $match.Groups[1].Value + $ValueLiteral + ';' }, 1)
}

function Set-CSharpAssemblyStringAttribute {
    param([string]$Content, [string]$Name, [string]$Value)
    $valueLiteral = ConvertTo-CSharpStringLiteral $Value
    if ($valueLiteral -eq 'null!') { return $Content }
    $pattern = '(\[assembly:\s*' + [regex]::Escape($Name) + '\()("[^"]*")(\)\])'
    return [regex]::Replace($Content, $pattern, { param($match) $match.Groups[1].Value + $valueLiteral + $match.Groups[3].Value }, 1)
}

function Update-MicaSetupProgramFile {
    param(
        [string]$ProgramFile,
        [object]$Config,
        [string]$Version,
        [switch]$Uninstall
    )

    if (-not (Test-Path $ProgramFile)) { return }

    $appName = [string]$Config.AppName
    $keyName = [string]$Config.KeyName
    $exeName = [string]$Config.ExeName
    $publisher = [string]$Config.Publisher
    $requestExecutionLevel = [string]$Config.RequestExecutionLevel

    $suffix = $(if ($Uninstall) { 'Uninst' } else { 'Setup' })
    $programText = [System.IO.File]::ReadAllText($ProgramFile, [System.Text.Encoding]::UTF8)
    $programText = $programText -replace '(\[assembly:\s*Guid\(")[^"]*("\)\])', "`${1}$($Config.Guid)`${2}"
    $programText = Set-CSharpAssemblyStringAttribute -Content $programText -Name 'AssemblyTitle' -Value "$appName $suffix"
    $programText = Set-CSharpAssemblyStringAttribute -Content $programText -Name 'AssemblyProduct' -Value $appName
    $programText = Set-CSharpAssemblyStringAttribute -Content $programText -Name 'AssemblyDescription' -Value "$appName $suffix"
    $programText = Set-CSharpAssemblyStringAttribute -Content $programText -Name 'AssemblyCompany' -Value $publisher
    $programText = Set-CSharpAssemblyStringAttribute -Content $programText -Name 'AssemblyCopyright' -Value "Copyright (c) $publisher"
    $programText = $programText -replace '(\[assembly:\s*AssemblyVersion\(")[^"]*("\)\])', "`${1}$Version`${2}"
    $programText = $programText -replace '(\[assembly:\s*AssemblyFileVersion\(")[^"]*("\)\])', "`${1}$Version`${2}"
    $programText = $programText -replace '(\[assembly:\s*RequestExecutionLevel\(")[^"]*("\)\])', "`${1}$requestExecutionLevel`${2}"

    foreach ($name in @(
            'IsCreateDesktopShortcut', 'IsCreateUninst', 'IsCreateStartMenu',
            'IsPinToStartMenu', 'IsCreateQuickLaunch', 'IsCreateRegistryKeys',
            'IsCreateAsAutoRun', 'IsCustomizeVisiableAutoRun',
            'IsUseFolderPickerPreferClassic', 'IsUseInstallPathPreferX86',
            'IsUseRegistryPreferX86', 'IsAllowFullFolderSecurity',
            'IsAllowFirewall', 'IsRefreshExplorer', 'IsInstallCertificate',
            'IsEnableUninstallDelayUntilReboot', 'IsEnvironmentVariable')) {
        if ($Config.PSObject.Properties.Name -contains $name) {
            $programText = Set-CSharpOptionAssignment -Content $programText -Name $name -ValueLiteral (ConvertTo-CSharpBoolLiteral $Config.$name)
        }
    }

    foreach ($name in @('AutoRunLaunchCommand', 'OverlayInstallRemoveExt', 'UnpackingPassword')) {
        if ($Config.PSObject.Properties.Name -contains $name) {
            $programText = Set-CSharpOptionAssignment -Content $programText -Name $name -ValueLiteral (ConvertTo-CSharpStringLiteral $Config.$name)
        }
    }

    $programText = Set-CSharpOptionAssignment -Content $programText -Name 'AppName' -ValueLiteral (ConvertTo-CSharpStringLiteral $appName)
    $programText = Set-CSharpOptionAssignment -Content $programText -Name 'KeyName' -ValueLiteral (ConvertTo-CSharpStringLiteral $keyName)
    $programText = Set-CSharpOptionAssignment -Content $programText -Name 'ExeName' -ValueLiteral (ConvertTo-CSharpStringLiteral $exeName)
    $programText = Set-CSharpOptionAssignment -Content $programText -Name 'DisplayVersion' -ValueLiteral (ConvertTo-CSharpStringLiteral $Version)
    $programText = Set-CSharpOptionAssignment -Content $programText -Name 'Publisher' -ValueLiteral (ConvertTo-CSharpStringLiteral $publisher)

    foreach ($name in @('MessageOfPage1', 'MessageOfPage2', 'MessageOfPage3')) {
        if (($Config.PSObject.Properties.Name -contains $name) -and $null -ne $Config.$name) {
            $programText = Set-CSharpOptionAssignment -Content $programText -Name $name -ValueLiteral (ConvertTo-CSharpStringLiteral $Config.$name)
        }
    }

    [System.IO.File]::WriteAllText($ProgramFile, $programText, (New-Object System.Text.UTF8Encoding $true))
}

function Copy-MicaSetupIconAssets {
    param(
        [object]$Config,
        [string]$ConfigDir,
        [string]$ImagesDir
    )

    if (-not (Test-Path $ImagesDir)) {
        New-Item -ItemType Directory -Path $ImagesDir -Force | Out-Null
    }

    $iconAssets = @(
        @{ Name = "安装器窗口图标"; Path = $Config.Favicon; Png = "Favicon.png"; Ico = "Favicon.ico"; RequireIco = $false },
        @{ Name = "安装包图标"; Path = $Config.Icon; Png = "FaviconSetup.png"; Ico = "FaviconSetup.ico"; RequireIco = $true },
        @{ Name = "卸载程序图标"; Path = $Config.UnIcon; Png = "FaviconUninst.png"; Ico = "FaviconUninst.ico"; RequireIco = $false }
    )

    foreach ($asset in $iconAssets) {
        $resolvedAsset = $null
        if (-not [string]::IsNullOrWhiteSpace($asset.Path)) {
            $expandedPath = [Environment]::ExpandEnvironmentVariables($asset.Path)
            if ([IO.Path]::IsPathRooted($expandedPath)) {
                $resolvedAsset = [IO.Path]::GetFullPath($expandedPath)
            } else {
                $resolvedAsset = [IO.Path]::GetFullPath((Join-Path $ConfigDir $expandedPath))
            }
        }

        if ($null -eq $resolvedAsset -or -not (Test-Path $resolvedAsset)) {
            throw "MicaSetup 配置缺少$($asset.Name): $resolvedAsset"
        }

        # 复制 PNG
        $pngPath = if ([IO.Path]::GetExtension($resolvedAsset) -eq ".png") { $resolvedAsset }
                   else { [IO.Path]::ChangeExtension($resolvedAsset, ".png") }
        if (Test-Path $pngPath) {
            Copy-Item -LiteralPath $pngPath -Destination (Join-Path $ImagesDir $asset.Png) -Force
        }

        # 复制 ICO
        $icoPath = if ([IO.Path]::GetExtension($resolvedAsset) -eq ".ico") { $resolvedAsset }
                   else { [IO.Path]::ChangeExtension($resolvedAsset, ".ico") }
        if (Test-Path $icoPath) {
            Copy-Item -LiteralPath $icoPath -Destination (Join-Path $ImagesDir $asset.Ico) -Force
        }
        elseif ($asset.RequireIco) {
            throw "MicaSetup $($asset.Name) 缺少 ico 文件: $([IO.Path]::ChangeExtension($resolvedAsset, '.ico'))"
        }
    }
}

# ============================================================
# 1. 环境检查
# ============================================================

if (-not $SkipCheck) {
    Write-Host "[1/5] 检查构建环境..." -ForegroundColor Yellow

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

    $dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnetCmd) {
        Write-Error "未找到 .NET SDK，MicaSetup 需要它来编译安装器。请安装: https://dotnet.microsoft.com/"
        exit 1
    }
    Write-Host "  .NET SDK $(dotnet --version)" -ForegroundColor DarkGray

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

# ============================================================
# 2. 安装前端依赖
# ============================================================

Write-Host "[2/5] 安装前端依赖..." -ForegroundColor Yellow
Push-Location $desktopDir
try {
    if (-not (Test-Path "node_modules")) {
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    } else {
        Write-Host "  node_modules 已存在，跳过安装" -ForegroundColor DarkGray
    }

    # ============================================================
    # 3. Tauri 构建
    # ============================================================

    Write-Host "[3/5] 正在构建桌面应用（首次构建可能需要几分钟）..." -ForegroundColor Yellow
    & $npm.Source run tauri:build
    if ($LASTEXITCODE -ne 0) { throw "Tauri 构建失败，请检查上方错误信息" }
}
finally {
    Pop-Location
}

# ============================================================
# 4. MicaSetup 打包安装器
# ============================================================

Write-Host "[4/5] 生成 MicaSetup 现代安装包..." -ForegroundColor Yellow

# 读取版本号
$tauriConf = Get-Content (Join-Path $desktopDir "src-tauri\tauri.conf.json") -Encoding UTF8 | ConvertFrom-Json
$version = $tauriConf.version
$productName = $tauriConf.productName
Write-Host "  产品: $productName  版本: $version" -ForegroundColor DarkGray

# 定位 Tauri 构建产物
$tauriExe = Join-Path $desktopDir "src-tauri\target\release\lifeos-morning-journal.exe"
if (-not (Test-Path $tauriExe)) {
    throw "未找到 Tauri 构建产物: $tauriExe"
}

# 还原 MicaSetup 工具
$toolProjectFile = Join-Path $buildDir "MicaSetup.Tools.csproj"
$micaTools = Restore-MicaSetupTools -ToolProjectFile $toolProjectFile
$sevenZip = $micaTools.SevenZip
$micaDir = $micaTools.MicaDir

# 检测 MSBuild 环境
$micaBuildEnv = Test-MicaSetupBuildEnvironment

# 准备打包目录
$packageRoot = Join-Path $buildDir ".package"
$archiveFile = Join-Path $buildDir "publish.7z"

if (Test-Path $packageRoot) { Remove-Item $packageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $packageRoot | Out-Null
Copy-Item -LiteralPath $tauriExe -Destination $packageRoot -Force

# 7z 压缩
Write-Host "  压缩应用文件..." -ForegroundColor DarkGray
if (Test-Path $archiveFile) { Remove-Item $archiveFile -Force }
& $sevenZip a $archiveFile (Join-Path $packageRoot "*") -t7z -mx=5 -mf=BCJ2 -r -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "生成 publish.7z 失败" }
Remove-Item $packageRoot -Recurse -Force

# 读取 MicaSetup 配置
$configFile = Join-Path $buildDir "micasetup.json"
$micaConfig = Get-Content -LiteralPath $configFile -Encoding UTF8 | ConvertFrom-Json

# 确保 .dist 项目目录存在（首次需由 makemica 生成）
$micaSetupCsproj = Join-Path $buildDir ".dist\MicaSetup.csproj"
if (-not (Test-Path $micaSetupCsproj)) {
    Write-Host "  首次运行，生成安装器项目模板..." -ForegroundColor DarkGray
    # makemica 内部会调用 MSBuild，需要设置 SDK 路径
    $env:MSBuildSDKsPath = $micaBuildEnv.MSBuildSDKsPath
    $env:MSBuildEnableWorkloadResolver = "false"
    Push-Location $buildDir
    try {
        & $micaTools.Exe 2>&1 | Out-Null  # 首次编译可能失败，但 .dist 目录会生成
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path $micaSetupCsproj)) {
        throw "makemica.exe 未能生成 .dist\MicaSetup.csproj"
    }
}

# 复制资源到 .dist
$distSetupsDir = Join-Path $buildDir ".dist\Resources\Setups"
if (-not (Test-Path $distSetupsDir)) { New-Item -ItemType Directory -Path $distSetupsDir -Force | Out-Null }
Copy-Item -LiteralPath $archiveFile -Destination $distSetupsDir -Force

$distImagesDir = Join-Path $buildDir ".dist\Resources\Images"
Copy-MicaSetupIconAssets -Config $micaConfig -ConfigDir $buildDir -ImagesDir $distImagesDir

# 更新 .dist 入口代码中的安装器信息
$programCsPath = Join-Path $buildDir ".dist\Program.cs"
Update-MicaSetupProgramFile -ProgramFile $programCsPath -Config $micaConfig -Version $version
$programUnCsPath = Join-Path $buildDir ".dist\Program.un.cs"
Update-MicaSetupProgramFile -ProgramFile $programUnCsPath -Config $micaConfig -Version $version -Uninstall

$msbuildExe = Join-Path $micaBuildEnv.MSBuildBin "MSBuild.exe"
$micaUninstCsproj = Join-Path $buildDir ".dist\MicaSetup.Uninst.csproj"
Write-Host "  编译安装器 (MSBuild)..." -ForegroundColor DarkGray

Push-Location $buildDir
try {
    # 设置 MSBuild 环境
    $env:PATH = "$($micaBuildEnv.MSBuildBin);$env:PATH"
    $env:RoslynTargetsPath = $micaBuildEnv.RoslynBin
    $env:CSharpCoreTargetsPath = Join-Path $micaBuildEnv.RoslynBin "Microsoft.CSharp.Core.targets"
    $env:CscToolPath = $micaBuildEnv.RoslynBin
    $env:CscToolExe = "csc.exe"
    $env:LangVersion = "preview"
    if (-not [string]::IsNullOrWhiteSpace($micaBuildEnv.MSBuildSDKsPath)) {
        $env:MSBuildSDKsPath = $micaBuildEnv.MSBuildSDKsPath
        $env:MSBuildEnableWorkloadResolver = "false"
    }

    # NuGet 还原（两个项目）
    & $msbuildExe $micaUninstCsproj /t:Restore /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "MSBuild NuGet 还原失败 (Uninst)" }
    & $msbuildExe $micaSetupCsproj /t:Restore /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "MSBuild NuGet 还原失败 (Setup)" }

    # 编译卸载器
    & $msbuildExe $micaUninstCsproj /t:Rebuild /p:Configuration=Release /p:LangVersion=preview /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "MSBuild 编译卸载器失败" }

    # 编译安装器
    & $msbuildExe $micaSetupCsproj /t:Build /p:Configuration=Release /p:LangVersion=preview /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw "MSBuild 编译安装器失败" }
}
finally {
    Pop-Location
}

# 查找编译输出
$micaOutput = Join-Path $buildDir ".dist\bin\Release\MicaSetup.exe"
if (-not (Test-Path $micaOutput)) {
    $micaOutput = Join-Path $buildDir ".dist\bin\Debug\MicaSetup.exe"
}
if (-not (Test-Path $micaOutput)) {
    throw "安装器编译输出未找到"
}

# ============================================================
# 5. 收集产物到 dist/
# ============================================================

Write-Host "[5/5] 收集安装包到 dist/ ..." -ForegroundColor Yellow

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$installerName = "$productName.Install.$version.exe"
$installerDest = Join-Path $distDir $installerName
Copy-Item -LiteralPath $micaOutput -Destination $installerDest -Force
Write-Host "  已生成: $installerName" -ForegroundColor DarkGray

# 绿色免安装版 (zip)
$portableName = "$productName.$version.Portable.zip"
$portableDest = Join-Path $distDir $portableName
Compress-Archive -LiteralPath $tauriExe -DestinationPath $portableDest -Force
Write-Host "  已生成: $portableName（绿色免安装版）" -ForegroundColor DarkGray

# 清理临时文件
if (Test-Path $archiveFile) { Remove-Item $archiveFile -Force }

Write-Host ""
Write-Host "=== 构建完成 ===" -ForegroundColor Green
Write-Host "安装包:   $installerDest" -ForegroundColor Green
Write-Host "绿色版:   $portableDest" -ForegroundColor Green
Write-Host ""

# 自动打开 dist 文件夹
explorer.exe $distDir
