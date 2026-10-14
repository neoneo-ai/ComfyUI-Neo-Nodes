# install_plugin.ps1 - 源码方式把内核插件装进 ComfyUI（不依赖 ComfyCLI，也不动用户数据）
# 装进去的只有代码与内置预设：用户数据归 Neo-Studio/data，插件靠 configs/data_root.json 指针找它。
# 副本边界 = kernel-plugin 里 git 已跟踪文件 - 只服务开发的目录，与 build_studio_exe.ps1 同一份。
# 目标目录里同名代码会被覆盖，其余文件一律保留：脚本从不删除目标目录里的任何东西。
# 用法: tools\install_plugin.ps1 [-ComfyUI <ComfyUI根>] [-DataRoot <数据根>] [-Python <python.exe>]
#                               [-SkipDeps] [-DryRun]
param(
    [string]$ComfyUI = "",
    [string]$DataRoot = "",
    [string]$Python = "",
    [switch]$SkipDeps,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$PluginSrc = Join-Path $RepoRoot "kernel-plugin"
# 目录名 = 前端 URL 前缀（ComfyUI 按目录名挂 /extensions/<目录名>），与 pyproject 包名同形
$PluginName = "comfyui-neo-studio"

# 缺省按整合包布局推：<workspace>/ComfyUI 与 <workspace>/Neo-Studio/data 并排
$Workspace = Split-Path $RepoRoot -Parent
if (-not $ComfyUI) { $ComfyUI = Join-Path $Workspace "ComfyUI" }
if (-not $DataRoot) { $DataRoot = Join-Path $Workspace "Neo-Studio/data" }
if (-not $Python) {
    $Python = Join-Path $Workspace "python/python.exe"
    if (-not (Test-Path $Python)) { $Python = "python" }
}
$ComfyUI = (Resolve-Path $ComfyUI).Path
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$Target = Join-Path $ComfyUI ("custom_nodes\" + $PluginName)

if (-not (Test-Path (Join-Path $ComfyUI "main.py"))) { throw "ComfyUI 根不对：$ComfyUI" }
if (-not (Test-Path $PluginSrc)) { throw "找不到内核插件源码：$PluginSrc" }

$EXCLUDES = @(
    '^tests/', '^example_workflows/', '^assets/', '^__pycache__/', '^\.git/',
    '^node_modules/', '^\.gitignore$', '^package(-lock)?\.json$'
)

# git 吐的是 UTF-8 字节，控制台编码不是 UTF-8 时中文预设名会被解成乱码、Test-Path 认不出文件
$enc = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$relFiles = (git -C $PluginSrc ls-files -z -- .) -split "`0" | Where-Object { $_ }
[Console]::OutputEncoding = $enc

$files = @()
foreach ($rel in $relFiles) {
    $rel = $rel -replace '\\', '/'
    $keep = $true
    foreach ($pat in $EXCLUDES) { if ($rel -match $pat) { $keep = $false; break } }
    if ($keep) { $files += $rel }
}

Write-Host "[PLAN] $PluginSrc -> $Target ($($files.Count) files)" -ForegroundColor Cyan
Write-Host "[PLAN] data root pointer -> configs/data_root.json = $DataRoot" -ForegroundColor Cyan
if (-not $SkipDeps) { Write-Host "[PLAN] pip install -r requirements.txt with $Python" -ForegroundColor Cyan }
if ($DryRun) { Write-Host "[DRY] nothing written" -ForegroundColor Green; exit 0 }

New-Item -ItemType Directory -Force -Path $Target | Out-Null
$copied = 0
foreach ($rel in $files) {
    $src = Join-Path $PluginSrc ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src)) { continue }   # 索引里有、工作树里没有：跳过
    $dst = Join-Path $Target ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $copied++
}
Write-Host "[COPY] $copied files -> $Target" -ForegroundColor Green

# 数据根指针：与内核 plugin_paths.write_pointer / 壳 write_data_pointer 同一份格式
# ConvertTo-Json 负责把路径里的反斜杠转义成 \\，手拼字符串会写出 JSON 解析不了的 \c
$pointer = Join-Path $Target "configs\data_root.json"
New-Item -ItemType Directory -Force -Path (Split-Path $pointer -Parent) | Out-Null
$pointerJson = [ordered]@{ version = 1; data_root = $DataRoot } | ConvertTo-Json
[IO.File]::WriteAllText($pointer, $pointerJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[POINTER] $pointer" -ForegroundColor Green

if (-not $SkipDeps) {
    & $Python -m pip install --no-warn-script-location -r (Join-Path $Target "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "pip 退出码 $LASTEXITCODE" }
    Write-Host "[DEPS] requirements installed" -ForegroundColor Green
}

Write-Host "[DONE] 重启 ComfyUI 生效；卸载只删这个目录，用户数据在 $DataRoot" -ForegroundColor Green
