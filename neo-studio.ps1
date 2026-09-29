# Neo Studio 启动器：ComfyUI 未运行则拉起，就绪后打开 Studio 页面。
param(
    [int]$Port = 8188,
    [string]$Python = "",
    [string]$Root = ""
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
# python 优先取 ComfyUI 同级目录（本工作区布局），再回退 ComfyUI 内部
if (-not $Python) {
    foreach ($cand in @((Join-Path $Root "..\python\python.exe"), (Join-Path $Root "python\python.exe"))) {
        if (Test-Path $cand) { $Python = $cand; break }
    }
}
if (-not $Python -or -not (Test-Path $Python)) {
    Write-Error "未找到 python：请用 -Python <python.exe 路径> 指定"
    exit 1
}
$url = "http://127.0.0.1:$Port/extensions/ComfyUI-Neo-Nodes/studio/index.html"

function Test-Ready([int]$Seconds) {
    # 探 /neo_studio/version：既确认 ComfyUI 在跑，也确认 Neo-Nodes 插件已加载
    for ($i = 0; $i -lt $Seconds; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/neo_studio/version" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return $false
}

if (Test-Ready 2) {
    Write-Host "ComfyUI 已在运行，直接打开 Neo Studio：$url"
} else {
    Write-Host "启动 ComfyUI（端口 $Port）…"
    Start-Process -FilePath $Python -ArgumentList @((Join-Path $Root "main.py"), "--port", "$Port")
    if (-not (Test-Ready 90)) {
        Write-Error "ComfyUI 180 秒内未就绪，请查看控制台日志"
        exit 1
    }
}
Start-Process $url
