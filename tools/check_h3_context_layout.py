"""真机校验：core 的真实 PackedLayout + 本插件的对齐函数（跑完即弃，不留在仓库里）。

验证三件事：
1) 上下文窗口帧数/步数与 core 的 17k+5 网格公式一致（video_latent_t）；
2) _ref_row_ranges 能把本插件造的两条参考映射到布局真实的 ref_img 行；
3) _align_payload_timeline 把窗口行搬到目标视频开头，且目标行与锚点行一个没动
   （core 的 PackedLayout 已让 refs 先占位、锚点从目标原点起算）。
"""
import importlib.util
import os
import sys
import types

import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))  # tools → 插件 → custom_nodes → ComfyUI 根
PKG_DIR = os.path.join(ROOT, "custom_nodes", "ComfyUI-Neo-Nodes")
sys.path.insert(0, ROOT)

server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), client_id=None, send_sync=lambda *a, **k: None))
sys.modules["server"] = server

import comfy.ldm.minimax.model as h3m  # noqa: E402  （真实 core 代码）
from comfy_extras.nodes_minimax_h3 import video_latent_t  # noqa: E402  （真实 17k+5 网格公式）

pkg = types.ModuleType("_neo_probe")
pkg.__path__ = [PKG_DIR]
sys.modules["_neo_probe"] = pkg
spec = importlib.util.spec_from_file_location("_neo_probe.h3_video_director",
                                              os.path.join(PKG_DIR, "h3_video_director.py"))
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
pkg.h3_video_director = mod
spec.loader.exec_module(mod)

# 1) 网格公式对齐
for frames in (5, 22, 39):
    assert mod._context_latent_t(frames) == video_latent_t(frames), frames
print("[ok] 上下文步数与 core video_latent_t 一致:", {f: video_latent_t(f) for f in (5, 22, 39)})
assert mod._context_latent_t(mod._align_context_frames(22)) == 7
# 窗口步数覆盖的帧数必须正好等于窗口帧数（否则窗口末尾会缺帧或多帧）
for frames in (5, 22, 39):
    steps = mod._context_latent_t(frames)
    assert abs(sum(h3m._video_t_spans(steps)) / h3m.FRAME_RESCALE - frames) < 1e-9, frames
print("[ok] 窗口步数覆盖帧数与窗口帧数一致（5/22/39）")

# 2) 真实布局：141 帧目标（latent_t=42）+ 身份图 + 22 帧上下文窗口
TARGET_FRAMES, WINDOW = 141, 22
target_t = video_latent_t(TARGET_FRAMES)
window_t = mod._context_latent_t(WINDOW)
latent_h, latent_w = 48, 84
refs = [
    {"kind": "image", "latent_h": latent_h, "latent_w": latent_w,
     "latent": torch.zeros(1, 24, 1, latent_h, latent_w)},
    {"kind": "video", "latent_t": window_t, "latent_h": latent_h, "latent_w": latent_w, "ref_audio_t": 0,
     "latent": torch.zeros(1, 24, window_t, latent_h, latent_w), "audio_latent": None,
     mod._CONTEXT_FRAMES_MARK: WINDOW},
]
layout = h3m.PackedLayout(42, target_t, latent_h, latent_w, 70, keyframes=None, refs=refs)
payload = {"refs": refs, "layout": layout}

video_start, video_stop = [seg[:2] for seg in layout.segments if seg[2] == "video"][-1]
frame_rows = (video_stop - video_start) // target_t
assert frame_rows == (latent_h // 2) * (latent_w // 2), frame_rows
rows = mod._ref_row_ranges(layout, refs)
window_start, window_stop = rows[1]["video"]
assert window_stop - window_start == window_t * frame_rows
assert (window_start, window_stop) == [seg[:2] for seg in layout.segments if seg[2] == "ref_img"][-1]
print("[ok] 参考行映射:", {"frame_rows": frame_rows, "identity": rows[0]["video"],
                            "window": rows[1]["video"], "target": (video_start, video_stop)})

target_rows = layout.position_ids[video_start:video_stop].clone()
target_origin = float(layout.position_ids[video_start, 0])
mod._align_payload_timeline(payload)
assert torch.equal(layout.position_ids[window_start:window_stop],
                   target_rows[:window_t * frame_rows]), "窗口行没有对齐到目标开头"
assert torch.equal(layout.position_ids[video_start:video_stop], target_rows), "目标行被改动了"
print("[ok] 窗口行对齐到目标开头；refs 推进量 offset =", target_origin - float(layout.signature[0]),
      "；真实布局 seq_len =", layout.seq_len)

# 3) 锚点行时间轴（keyframe + refs 并存时）：core 已把锚点放在目标原点，_align 不得再动它
layout2 = h3m.PackedLayout(42, target_t, latent_h, latent_w, 70,
                           keyframes=[{"resolved_frame_index": 0, "latent": torch.zeros(1, 24, 1, latent_h, latent_w)}],
                           refs=refs)
cond_seg = [seg[:2] for seg in layout2.segments if seg[2] == "cond"][0]
video2 = [seg[:2] for seg in layout2.segments if seg[2] == "video"][-1]
origin = float(layout2.position_ids[video2[0], 0])
before = float(layout2.position_ids[cond_seg[0], 0])
assert abs(before - origin) < 1e-9, "core 建好时锚点就该在目标原点"
mod._align_payload_timeline({"refs": refs, "layout": layout2})
after = float(layout2.position_ids[cond_seg[0], 0])
assert abs(after - origin) < 1e-9, "锚点行被多平移了 %.4f" % (after - origin)
print("[ok] 锚点行保持在目标原点（core 建好 %.4f / 对齐后 %.4f）" % (before, after))
print("ALL OK")
