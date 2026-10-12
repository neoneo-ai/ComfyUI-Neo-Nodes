# build_studio_exe.ps1 - 打包 Neo Studio 桌面壳为单文件 exe
# 构建期依赖 pyinstaller（不进 requirements.txt）；产物 tools/neo-studio.exe。
# 打包两步：
#   1) 把插件的 git 已跟踪文件复制成 build/bundled/ComfyUI-Neo-Nodes，随包一起打进 exe。
#      exe 里插件缺失时靠这份副本装进 custom_nodes / 离线浏览素材库。排除开发目录与产物目录。
#      用户配置与密钥（remote_llm_config / backyard_oss / model_hub 的 token / 收藏 / 缓存）
#      本来就不在跟踪列表里，因此 exe 里只有预设，装插件时也不会覆盖用户已有文件。
#   2) 按 Neo-Studio.spec 打包，副本落在 _MEIPASS/bundled/ComfyUI-Neo-Nodes。
# 用法: tools\build_studio_exe.ps1 [-Python <python.exe>] [-DryRun]
param(
    [string]$Python = "python",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$PluginDir = Split-Path $PSScriptRoot -Parent
Set-Location $PluginDir

$BuildDir = Join-Path $PluginDir "build"
$BUNDLE_DIR = "bundled/ComfyUI-Neo-Nodes"   # Neo-Studio.spec 里的 Tree target
$BundleDir = Join-Path $BuildDir ($BUNDLE_DIR -replace '/', '\')

# 副本边界 = git 已跟踪 - 开发目录。锚定开头，^tools/ 不会误杀 web/studio/tools.js
$EXCLUDES = @(
    '^build/', '^dist/', '^tools/', '^tests/', '^docs/', '^example_workflows/', '^assets/',
    '^__pycache__/', '^\.git/', '^node_modules/', '^\.github/', '^\.vscode/',
    '^neo-studio-app\.vbs$', '^Neo-Studio\.spec$', '^\.gitignore$',
    '^pytest\.ini$', '^package(-lock)?\.json$', '^t\.log$'
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
        $src = Join-Path $PluginDir ($rel -replace '/', '\')
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
& $Python -m PyInstaller --clean --noconfirm --workpath (Join-Path $BuildDir "pyi") --distpath (Join-Path $BuildDir "dist") (Join-Path $PluginDir "Neo-Studio.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item (Join-Path $BuildDir "dist/Neo-Studio.exe") (Join-Path $PluginDir "tools/neo-studio.exe") -Force
$Exe = Join-Path $PluginDir "tools/neo-studio.exe"
if (Test-Path $Exe) {
    Write-Host "[DONE] $Exe" -ForegroundColor Green
    Write-Host ("[DONE] {0:N1} MB" -f ((Get-Item $Exe).Length / 1MB)) -ForegroundColor Green
}
