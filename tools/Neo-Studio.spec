# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

# bundled/ 由 tools/build_studio_exe.ps1 从 studio/ 组装：git 已跟踪文件减去只服务开发的条目
datas = [('../studio/web/neo-studio.ico', 'web'),
         ('../build/bundled/comfyui-neo-studio', 'bundled/comfyui-neo-studio'),
         ('coreclr.runtimeconfig.json', 'runtime')]
binaries = []
hiddenimports = []
tmp_ret = collect_all('webview')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('pythonnet')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('aiohttp')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('PIL')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('yaml')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('pypinyin')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['../app/studio_app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# 单文件版：binaries/datas 全打进 exe，启动时解包到 %TEMP%\_MEI*（双击即用，出窗口慢一截）
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Neo-Studio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['../studio/web/neo-studio.ico'],
)

# 目录版：binaries/datas 摊进包里的 _internal，启动不解包（sys._MEIPASS 就是那一层）
exe_dir = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Neo-Studio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['../studio/web/neo-studio.ico'],
)
coll = COLLECT(exe_dir, a.binaries, a.datas, strip=False, upx=True, upx_exclude=[], name='Neo-Studio')
