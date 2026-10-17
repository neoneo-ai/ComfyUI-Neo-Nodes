#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""相册首页 / 目录卡 / 封面缩略图的服务端耗时剖面（离线开发脚本，不进插件包）。

直接调用 studio/gallery.py 里的扫描与缩略图函数，不走 HTTP：首页慢的那段就是这些
函数在网络盘上的目录往返，中间件与网络传输不在测量范围里。数字与机器、与挂载的
NAS 强相关，只用来比较改动前后，不当绝对值看。

Usage:
  python tools/profile_gallery.py             # 目录卡 + 封面 + 封面缩略图
  python tools/profile_gallery.py --repeat=5  # 每段重复次数（默认 3）
  python tools/profile_gallery.py <comfyui_root>
"""
from __future__ import annotations

import importlib.machinery
import json
import os
import statistics
import sys
import time
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = "comfyui-neo-studio"
POINTER = REPO / "studio" / "configs" / "data_root.json"
LAUNCHER = REPO / "data" / "launcher_config.json"
THUMB_SIZE = 320


def data_root() -> Path:
    """数据根按 plugin_paths 的同一套顺序解析：环境变量，指针文件，插件目录。"""
    env = os.environ.get("NEO_STUDIO_DATA", "").strip()
    if env:
        return Path(env)
    try:
        return Path(str(json.loads(POINTER.read_text(encoding="utf-8-sig"))["data_root"]))
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return REPO / "studio"


def comfyui_root(argv: list[str]) -> Path:
    for arg in argv[1:]:
        if not arg.startswith("-"):
            return Path(arg)
    try:
        root = Path(str(json.loads(LAUNCHER.read_text(encoding="utf-8")).get("root", "")))
        if (root / "custom_nodes" / PLUGIN).is_dir():
            return root
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        pass
    return REPO.parent / "ComfyUI"


def load_gallery(root: Path):
    """按 conftest 的同一套办法导入 gallery：占位包顶住 studio 这个名字，
    插件入口不执行，节点与路由不注册。"""
    os.environ["NEO_STUDIO_DATA"] = str(data_root())
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(REPO))
    if "studio" not in sys.modules:
        pkg = types.ModuleType("studio")
        pkg.__path__ = [str(REPO / "studio")]
        pkg.__spec__ = importlib.machinery.ModuleSpec("studio", None, is_package=True)
        sys.modules["studio"] = pkg
    import studio.gallery as g
    return g


def timeit(fn, *args, **kw):
    t0 = time.perf_counter()
    out = fn(*args, **kw)
    return (time.perf_counter() - t0) * 1000.0, out


def span(values: list[float]) -> str:
    return f"min {min(values):6.1f}  med {statistics.median(values):6.1f}  max {max(values):6.1f} ms"


def home_entries(g, dirs: list[Path], hidden: set) -> list[tuple[Path, str, bool]]:
    """The directories a home list request scans: system dirs then custom dirs."""
    entries = [(info["path"], info["name"], True) for info in g._get_system_dirs()
               if not g._is_home_entry_hidden(info["name"], hidden)]
    entries += [(p, p.name if p.name else str(p), False) for p in dirs]
    return entries



def main(argv: list[str]) -> int:
    repeat = 3
    for arg in argv[1:]:
        if arg.startswith("--repeat="):
            repeat = int(arg.split("=", 1)[1])
    root = comfyui_root(argv)
    g = load_gallery(root)
    print(f"comfyui {root}")
    print(f"gallery {g.GALLERY_DIR}\n")

    first, dirs = timeit(g._get_user_custom_dirs)
    print(f"custom dirs  first {first:6.1f} ms  ({len(dirs)} dirs)")
    print(f"custom dirs  warm  {span([timeit(g._get_user_custom_dirs)[0] for _ in range(repeat)])}")

    hidden = g._get_hidden_entries()
    entries = home_entries(g, dirs, hidden)

    home_scans: dict[str, tuple[list, list]] = {}
    card_total = 0.0
    print(f"\nhome dir cards ({len(entries)} dirs, fields=dirs,covers)")
    for path, name, read_only in entries:
        runs = [timeit(g._process_home_directory, path, name, read_only, True, False, False)
                for _ in range(repeat)]
        card_total += statistics.median([t for t, _ in runs])
        files, subdirs = runs[0][1][1]
        home_scans[name] = (files, subdirs)
        print(f"  {name:28} {span([t for t, _ in runs])}  files={len(files):4} dirs={len(subdirs):3}")
    print(f"  cards total (median sum) {card_total:7.1f} ms")

    covers: dict[str, list[dict]] = {}
    cover_runs = [timeit(g._collect_home_covers, covers, dirs, hidden, g.LORA_CACHE_DIR.exists(), None, home_scans)
                  for _ in range(repeat)]
    print(f"\nhome covers  {span([t for t, _ in cover_runs])}  "
          f"({sum(len(v) for v in covers.values())} cover entries)")

    print("\ncover thumbnails (source resolve + payload)")
    miss, thumb_total = 0, 0.0
    for dir_name, cov_list in sorted(covers.items()):
        for cov in cov_list:
            t_find, src = timeit(g._find_source_media, cov["filename"], cov["subfolder"])
            if src is None:
                miss += 1
                print(f"  {dir_name:22} {cov['filename'][:34]:36} 404       resolve {t_find:6.1f} ms")
                continue
            runs = [timeit(g._thumbnail_payload, THUMB_SIZE, src) for _ in range(repeat)]
            body = runs[0][1]
            thumb_total += statistics.median([t for t, _ in runs])
            kind = "none" if body is None else f"{len(body[0]) // 1024}K"
            print(f"  {dir_name:22} {cov['filename'][:34]:36} resolve {t_find:6.1f}  "
                  f"payload {span([t for t, _ in runs])}  {kind}")
    print(f"\n{miss} cover(s) with no resolvable source; payload median sum {thumb_total:7.1f} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
