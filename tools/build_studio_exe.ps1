# build_studio_exe.ps1 - 打包 Neo Studio 桌面壳
# 构建期依赖 pyinstaller（不进 requirements.txt）。产物按 -Mode 分两种分发形态：
#   onefile（默认）tools/neo-studio.exe 单文件，双击即用，每次启动先解包到临时目录
#   onedir         tools/neo-studio/Neo-Studio.exe 目录版，启动不解包，出窗口快得多
#   both           两个都出
# 打包两步：
#   1) 把 kernel-plugin 的 git 已跟踪文件复制成 build/bundled/comfyui-neo-studio，随包一起打进 exe。
#      exe 里插件缺失时靠这份副本装进 custom_nodes / 离线浏览素材库。排除开发目录与产物目录。
#      用户配置与密钥（remote_llm_config / backyard_oss / model_hub 的 token / 收藏 / 缓存）
#      本来就不在跟踪列表里，因此 exe 里只有预设，装插件时也不会覆盖用户已有文件。
#   2) 按 Neo-Studio.spec 打包，副本落在 _MEIPASS/bundled/comfyui-neo-studio
#      （onedir 下 _MEIPASS 就是包目录里的 _internal/）。
# 用法: tools\build_studio_exe.ps1 [-Python <python.exe>] [-DryRun] [-Mode onefile|onedir|both]
#                                 [-Sign] [-Notarize] [-Publish]
# 发布开关（默认全关，产物与不传开关时逐字节一致）：
#   -Sign      signtool 签名：机器证书走 -CertThumbprint，证书文件走 -Pfx/-PfxPass，时间戳 -Timestamp
#   -Notarize  macOS 公证（notarytool + stapler + spctl），只能在 mac 上跑，需要 -AppleTeamId
#   -Publish   在 kernel-plugin 里跑 comfy node publish，把内核插件发到 Comfy Registry
param(
    [string]$Python = "python",
    [switch]$DryRun,
    # 分发形态：onefile 单文件（默认，双击即用，每次启动先解包到临时目录）；
    # onedir 目录版（exe + _internal 摊开，启动不解包，出窗口快得多，代价是要整包拷贝）
    [ValidateSet('onefile', 'onedir', 'both')][string]$Mode = 'onefile',
    [switch]$Sign,
    [string]$CertThumbprint = "",
    [string]$Pfx = "",
    [string]$PfxPass = "",
    [string]$Timestamp = "http://timestamp.digicert.com",
    [switch]$Notarize,
    [string]$AppleTeamId = "",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$PluginSrc = Join-Path $RepoRoot "kernel-plugin"
Set-Location $PluginSrc

$BuildDir = Join-Path $RepoRoot "build"
$BUNDLE_DIR = "bundled/comfyui-neo-studio"   # Neo-Studio.spec 里的 Tree target
$BundleDir = Join-Path $BuildDir ($BUNDLE_DIR -replace '/', '\')

# 副本边界 = kernel-plugin 里 git 已跟踪 - 开发目录。锚定开头，^tools/ 不会误杀 web/studio/tools.js
$EXCLUDES = @(
    '^tests/', '^example_workflows/', '^assets/', '^__pycache__/', '^\.git/',
    '^node_modules/', '^\.gitignore$', '^package(-lock)?\.json$'
)

function Build-Bundle {
    if (Test-Path $BundleDir) { Remove-Item $BundleDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null
    # -z 用 NUL 分条：默认输出把非 ASCII 文件名转义成 "..."，中文提示词预设会丢
    # git 吐的是 UTF-8 字节，控制台编码不是 UTF-8 时名字会被解成乱码、Test-Path 认不出文件
    $enc = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $relFiles = (git ls-files -z -- .) -split "`0" | Where-Object { $_ }
    [Console]::OutputEncoding = $enc
    $copied = 0
    $missing = @()
    foreach ($rel in $relFiles) {
        $rel = $rel -replace '\\', '/'
        $keep = $true
        foreach ($pat in $EXCLUDES) { if ($rel -match $pat) { $keep = $false; break } }
        if (-not $keep) { continue }
        $src = Join-Path $PluginSrc ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $src)) { $missing += $rel; continue }
        $dst = Join-Path $BundleDir ($rel -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $copied++
    }
    Write-Host "[BUNDLE] $copied files -> $BundleDir" -ForegroundColor Cyan
    if ($missing) { Write-Host "[WARN] tracked but missing: $($missing -join ', ')" -ForegroundColor Yellow }
    $size = (Get-ChildItem $BundleDir -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host ("[BUNDLE] {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Cyan
}

Write-Host "[RUN] building bundled plugin copy" -ForegroundColor Cyan
Build-Bundle
if ($DryRun) { Write-Host "[DRY] bundle only, no exe" -ForegroundColor Green; exit 0 }

Write-Host "[RUN] pyinstaller Neo-Studio.spec" -ForegroundColor Cyan
# workpath 必须避开 build/bundled：--clean 会清空 workpath，同目录等于删掉刚组装好的副本
& $Python -m PyInstaller --clean --noconfirm --workpath (Join-Path $BuildDir "pyi") --distpath (Join-Path $BuildDir "dist") (Join-Path $RepoRoot "tools\Neo-Studio.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Show-Size($Path, $Label) {
    $bytes = (Get-ChildItem $Path -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host ("[DONE] {0} {1:N1} MB" -f $Label, ($bytes / 1MB)) -ForegroundColor Green
}

$Artifacts = @()

if ($Mode -in @('onefile', 'both')) {
    Copy-Item (Join-Path $BuildDir "dist/Neo-Studio.exe") (Join-Path $RepoRoot "tools/neo-studio.exe") -Force
    $Exe = Join-Path $RepoRoot "tools/neo-studio.exe"
    if (Test-Path $Exe) {
        $Artifacts += $Exe
        Write-Host "[DONE] $Exe" -ForegroundColor Green
        Write-Host ("[DONE] {0:N1} MB" -f ((Get-Item $Exe).Length / 1MB)) -ForegroundColor Green
    }
}

if ($Mode -in @('onedir', 'both')) {
    # 目录版整包搬到 tools/neo-studio/：壳的状态目录是 exe 旁的 data/，重打包不能把它带走
    $DirOut = Join-Path $RepoRoot "tools/neo-studio"
    $DirSrc = Join-Path $BuildDir "dist/Neo-Studio"
    if (Test-Path $DirOut) {
        $Keep = $null
        if (Test-Path (Join-Path $DirOut "data")) {
            $Keep = Join-Path ([System.IO.Path]::GetTempPath()) ("neo-studio-data-" + [guid]::NewGuid().ToString("N"))
            Move-Item (Join-Path $DirOut "data") $Keep -Force
        }
        Remove-Item $DirOut -Recurse -Force
    }
    Copy-Item $DirSrc $DirOut -Recurse -Force
    if ($Keep) {
        Move-Item $Keep (Join-Path $DirOut "data") -Force
    }
    Write-Host "[DONE] $DirOut\Neo-Studio.exe" -ForegroundColor Green
    $Artifacts += (Join-Path $DirOut "Neo-Studio.exe")
    Show-Size $DirOut "folder total"
    Show-Size (Join-Path $DirOut "_internal") "_internal"
}

function Find-SignTool() {
    # signtool 随 Windows SDK 装在这里，按版本号取最新那份
    $kits = Get-ChildItem "$env:ProgramFiles\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+(\.\d+)*$' } | Sort-Object { [version]$_.Name }
    foreach ($kit in $kits) {
        $tool = Join-Path $kit.FullName "x64\signtool.exe"
        if (Test-Path $tool) { return $tool }
    }
    return $null
}

function Sign-Artifact($Path) {
    $SignTool = Find-SignTool
    if (-not $SignTool) { throw "没找到 signtool.exe：装 Windows 10/11 SDK（含签名工具）后重试" }
    $signArgs = @('sign', '/fd', 'SHA256', '/tr', $Timestamp, '/td', 'SHA256')
    if ($Pfx) {
        $signArgs += @('/f', $Pfx)
        if ($PfxPass) { $signArgs += @('/p', $PfxPass) }
    } elseif ($CertThumbprint) {
        $signArgs += @('/sha1', $CertThumbprint)
    } else {
        throw "-Sign 需要证书：传 -CertThumbprint <指纹>（机器证书库）或 -Pfx <文件> -PfxPass <口令>"
    }
    & $SignTool @signArgs $Path
    if ($LASTEXITCODE -ne 0) { throw "signtool sign 退出码 $LASTEXITCODE" }
    & $SignTool verify /pa /v $Path
    if ($LASTEXITCODE -ne 0) { throw "签名校验失败：signtool verify 退出码 $LASTEXITCODE" }
    Write-Host "[SIGN] $Path" -ForegroundColor Green
}

function Notarize-Artifact($Path) {
    if ($IsWindows) { throw "-Notarize 走 macOS 的 notarytool，不能在 Windows 上跑" }
    if (-not $AppleTeamId) { throw "-Notarize 需要 -AppleTeamId <Team ID>" }
    if (-not $env:APPLE_ID -or -not $env:APPLE_PASSWORD) {
        throw "公证需要环境变量 APPLE_ID 与 APPLE_PASSWORD（App 专用密码，不是 Apple ID 登录口令）"
    }
    $zip = "$Path.zip"
    Compress-Archive -Path $Path -DestinationPath $zip -Force
    & xcrun notarytool submit $zip --apple-team-id $AppleTeamId --apple-id $env:APPLE_ID `
        --password $env:APPLE_PASSWORD --wait
    if ($LASTEXITCODE -ne 0) { throw "notarytool submit 退出码 $LASTEXITCODE" }
    & xcrun stapler staple $Path
    if ($LASTEXITCODE -ne 0) { throw "stapler staple 退出码 $LASTEXITCODE" }
    & xcrun spctl --assess --type execute $Path
    if ($LASTEXITCODE -ne 0) { throw "spctl 校验失败：签名与公证没通过" }
    Write-Host "[NOTARIZE] $Path" -ForegroundColor Green
}

function Publish-Plugin() {
    # comfy-cli 从 kernel-plugin 的 [tool.comfy] 读包名与版本，发布要在插件目录里跑
    if (-not (Get-Command comfy -ErrorAction SilentlyContinue)) {
        throw "没找到 comfy CLI：pip install comfy-cli 后重试"
    }
    & comfy node publish
    if ($LASTEXITCODE -ne 0) { throw "comfy node publish 退出码 $LASTEXITCODE" }
    Write-Host "[PUBLISH] kernel-plugin 已发到 Comfy Registry" -ForegroundColor Green
}

if ($Sign) { foreach ($artifact in $Artifacts) { Sign-Artifact $artifact } }
if ($Notarize) { foreach ($artifact in $Artifacts) { Notarize-Artifact $artifact } }
if ($Publish) { Publish-Plugin }
