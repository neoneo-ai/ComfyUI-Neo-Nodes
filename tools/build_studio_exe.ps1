# build_studio_exe.ps1 - 打包 Neo Studio 桌面壳为单文件 exe
# 构建期依赖 pyinstaller（不进 requirements.txt）；产物 tools/neo-studio.exe，
# frozen 下 base_dirs() 向上找到插件目录，configs / tmp / web 路径与源码运行一致。
# 用法: tools\build_studio_exe.ps1 [-Python <python.exe>]
param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

& $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name Neo-Studio `
    --icon "web/neo-studio.ico" `
    --add-data "web/neo-studio.ico;web" `
    --collect-all webview `
    --collect-all pythonnet `
    --exclude-module tkinter `
    neo_studio_app.py

Copy-Item dist/Neo-Studio.exe tools/neo-studio.exe -Force
Write-Host "[OK] $root\tools\neo-studio.exe"