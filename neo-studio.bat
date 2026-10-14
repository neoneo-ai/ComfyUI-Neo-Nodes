@echo off
rem Neo Studio 启动器（Windows 双击入口）：逻辑在 neo-studio.ps1
chcp 65001 >nul
setlocal
rem -NoExit：脚本结束后窗口保留，日志/报错可见
powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0neo-studio.ps1" %*
