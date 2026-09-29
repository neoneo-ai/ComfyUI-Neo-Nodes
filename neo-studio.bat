@echo off
rem Neo Studio 启动器（Windows 双击入口）：逻辑在 neo-studio.ps1
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0neo-studio.ps1" %*
