@echo off
rem Neo Studio 桌面壳调试入口（带控制台）：双击无黑窗请用 neo-studio-app.vbs
chcp 65001 >nul
setlocal
rem 整合包布局：python 与 ComfyUI 同级；再回退 ComfyUI 内部
set "PY=%~dp0..\python\python.exe"
if not exist "%PY%" set "PY=%~dp0ComfyUI\python\python.exe"
if not exist "%PY%" (
  echo 未找到 python：请用 "neo-studio-app.bat -Python <python.exe>" 指定
  pause
  exit /b 1
)
"%PY%" "%~dp0app\studio_app.py" %*
