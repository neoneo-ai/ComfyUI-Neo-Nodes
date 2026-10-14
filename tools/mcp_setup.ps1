# mcp_setup.ps1 - 把 Neo Studio 的 MCP 服务器接进 MCP 客户端：打印 / 写入配置片段
# 服务器是 kernel-plugin\mcp_server.py（stdio 子进程，由 MCP 客户端启动，不随 ComfyUI 启动）。
# 用法: tools\mcp_setup.ps1 [-Python <python.exe>] [-ComfyUrl <地址>] [-Tools a,b,c]
#                           [-Claude] [-Cursor] [-Write]
param(
    [string]$Python = "",
    [string]$ComfyUrl = "http://127.0.0.1:8188",
    [string]$Tools = "",
    [switch]$Claude,
    [switch]$Cursor,
    [switch]$Write
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Server = Join-Path $RepoRoot "kernel-plugin\mcp_server.py"
if (-not (Test-Path $Server)) { throw "找不到 MCP 服务器：$Server" }

if (-not $Python) {
    $Workspace = Split-Path $RepoRoot -Parent
    $Python = Join-Path $Workspace "python\python.exe"
    if (-not (Test-Path $Python)) { $Python = "python" }
}

# 自检：确认这份 python 跑得起服务器，顺便打印启用的工具
& $Python $Server --selftest
if ($LASTEXITCODE -ne 0) { throw "MCP 服务器自检失败：$Python $Server --selftest" }

$EnvMap = [ordered]@{ NEO_MCP_COMFY_URL = $ComfyUrl }
if ($Tools) { $EnvMap["NEO_MCP_TOOLS"] = $Tools }
$Entry = [ordered]@{ command = $Python; args = @($Server); env = $EnvMap }
$Snippet = [ordered]@{ mcpServers = [ordered]@{ "neo-studio" = $Entry } }

$ClaudePath = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
$CursorPath = Join-Path $RepoRoot ".cursor\mcp.json"
if (-not $Claude -and -not $Cursor) { $Claude = $true; $Cursor = $true }

# 写入 = 只往 mcpServers 里加 / 覆盖 neo-studio 这一项，其余配置原样保留
function Merge-Config([string]$Path) {
    $data = $null
    if (Test-Path $Path) {
        try { $data = Get-Content $Path -Raw | ConvertFrom-Json } catch { throw "$Path 不是有效 JSON" }
    }
    if (-not $data) { $data = [ordered]@{ mcpServers = [ordered]@{} } }
    if (-not $data.mcpServers) { $data | Add-Member mcpServers ([ordered]@{}) -Force }
    $data.mcpServers | Add-Member -MemberType NoteProperty -Name "neo-studio" -Value $Entry -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    $data | ConvertTo-Json -Depth 8 | Set-Content $Path -Encoding utf8
    "已写入 $Path"
}

if ($Claude) {
    "`n== Claude Desktop（$ClaudePath，改完重启 Claude）=="
    $Snippet | ConvertTo-Json -Depth 8
    if ($Write) { Merge-Config $ClaudePath }
}
if ($Cursor) {
    "`n== Cursor（$CursorPath，项目级配置）=="
    $Snippet | ConvertTo-Json -Depth 8
    if ($Write) { Merge-Config $CursorPath }
}

"`n桌面壳换了 ComfyUI 端口就改 NEO_MCP_TOOLS 旁边的 NEO_MCP_COMFY_URL；" +
"只想开放部分工具就设 NEO_MCP_TOOLS（逗号分隔，留空 = 全部）。"
