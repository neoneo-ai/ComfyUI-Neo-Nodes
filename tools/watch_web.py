#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""前端热同步：改 studio/web 立刻生效，不用重启 ComfyUI。

轮询 studio/web 的 size + mtime，变了就覆盖进 custom_nodes/comfyui-neo-studio/web。
全量同步归桌面壳启动时的 sync_plugin，这里只跟前端。覆盖完在窗口里 Ctrl+F5
就是新代码 —— aiohttp 的 static 带 ETag，硬刷新必然回源取新文件。
只覆盖同名文件，从不删目标侧的东西，与 sync_plugin 同一套语义。

Usage:
  python watch_web.py                # 根取 data/launcher_config.json，取不到找仓库同级的 ComfyUI
  python watch_web.py <comfyui_root>
"""
import json
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "studio" / "web"
PLUGIN = "comfyui-neo-studio"
CONFIG = REPO / "data" / "launcher_config.json"
SKIP_DIRS = {"__pycache__", ".git", "node_modules", "tmp"}
INTERVAL = 0.4


def comfyui_root() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    try:
        root = Path(json.loads(CONFIG.read_text(encoding="utf-8")).get("root", ""))
        if (root / "custom_nodes" / PLUGIN).is_dir():
            return root
    except (OSError, json.JSONDecodeError):
        pass
    return REPO.parent / "ComfyUI"


def snapshot() -> dict:
    """rel -> (size, mtime_ns)：源侧实况，和上一轮比就是改动。"""
    out = {}
    for path in SRC.rglob("*"):
        if path.is_dir() or any(p in SKIP_DIRS for p in path.parts) or path.name.endswith(".tmp"):
            continue
        st = path.stat()
        out[path.relative_to(SRC)] = (st.st_size, st.st_mtime_ns)
    return out


def main() -> int:
    if not SRC.is_dir():
        print(f"no such dir: {SRC}")
        return 1
    dst = comfyui_root() / "custom_nodes" / PLUGIN / "web"
    if not dst.is_dir():
        print(f"plugin web dir missing, start Neo Studio once first: {dst}")
        return 1
    print(f"watch {SRC}\n   -> {dst}", flush=True)
    seen = None
    while True:
        now = snapshot()
        changed = [rel for rel, sig in now.items() if (seen or {}).get(rel) != sig]
        copied = 0
        for rel in changed:
            target = dst / rel
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(SRC / rel, target)
            except OSError as exc:
                print(f"! {rel}: {exc}", flush=True)
                continue
            copied += 1
            if seen is not None:
                print(f"+ {rel}", flush=True)
        if seen is None:
            print(f"initial sync {copied} files", flush=True)
        seen = now
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
