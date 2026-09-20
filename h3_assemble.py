"""Neo H3 段落拼接（P2）：把单段产物接回成片，产出新的完整成片。

两步式（前端也分成两边）：
1. **先单段出**：逐段生成/重生成（h3_segment 的单段流程），片段记进配方 results（带 `segment`）；
2. **确认后拼接**：把 [原成片前 start 段] + [第 start..N-1 段的片段] 拼成新成片——
   - 前缀直接取原成片的对应帧与音频（解码 → 拼接 → 再编码，内容不变）；
   - 每个接缝用 `h3_video_director._blend_seam` 交叉淡化（与整条配方运行时同一套规则，帧数不变）；
   - 音频按各段帧数裁齐后 `_concat_segment_audio` 拼接，A/V 对齐；
   - 新成片写 `output/neo_director_merge/`，记进配方 results 并带上 `layout`（逐段真实帧数），
     这样后续「单段重生成」能按这个成片的真实段边界取锚点帧。

拼接不用模型（纯解码/编码），所以不走执行队列也不需要显存管理：路由 + 后台线程 + 任务快照（进度/取消）。
"""

import datetime
import logging
import pathlib
import threading
import time
import uuid
from fractions import Fraction

import folder_paths
import torch
from aiohttp import web
from comfy_api.latest import InputImpl, Types
from server import PromptServer

from .h3_segment import _film_candidates, _film_entry, _safe_name, _video_frame_count, film_layout
from .h3_video_director import SEAM_BLEND_FRAMES, _blend_seam, _concat_segment_audio
from .h3_video_gen import H3_FPS
from .recipes import add_recipe_results, is_preset_recipe, list_recipe_results, load_director_spec

logger = logging.getLogger(__name__)

MERGE_DIR = "neo_director_merge"     # 拼接成片的输出目录（片段在 neo_director_regen）
MAX_TASKS = 16
TASK_TTL = 3600.0


class _Cancelled(Exception):
    """用户取消了拼接（协作式：在片段/阶段边界生效）。"""


def _clip_entries(recipe: str) -> dict:
    """每段最新的单段产物：{segment_index: entry}（list_recipe_results 新 → 旧，首次命中即最新）。"""
    clips = {}
    for entry in list_recipe_results(recipe):
        index = entry.get("segment")
        if entry.get("kind") == "video" and index is not None and int(index) not in clips:
            clips[int(index)] = entry
    return clips


def segment_status(recipe: str, continuity: bool = True, context_frames: int = 22) -> dict:
    """两端 UI 需要的现状：可选成片（含段边界）、每段已有片段与帧数、段数。"""
    spec = load_director_spec(recipe)
    segments = spec.get("segments") or []
    films = _film_candidates(recipe)
    clips = []
    for index, entry in sorted(_clip_entries(recipe).items()):
        if index < len(segments):
            clips.append({"segment": index, "filename": entry["filename"],
                          "frames": _video_frame_count(entry["path"])})
    film = films[0] if films else None
    film_info = None
    if film is not None:
        film_info = {"filename": film["filename"], "frames": _video_frame_count(film["path"]),
                     "layout": list(film.get("layout") or [])}
        try:
            film_info["segments"] = [{"segment": i, "start": start, "kept": kept} for i, (start, kept)
                                     in enumerate(film_layout(film, spec, continuity, context_frames))]
        except ValueError as e:
            film_info["error"] = str(e)     # 段边界对不上：面板据此提示，别让用户白等一次拼接
    return {"recipe": recipe, "segments": len(segments), "films": [f["filename"] for f in films],
            "film": film_info, "clips": clips}


def _validate(recipe: str, start_index: int) -> tuple:
    """校验起始段与片段齐备，返回 (spec, clips)；不满足抛 ValueError（HTTP 语义由调用方决定）。"""
    if is_preset_recipe(recipe):
        raise ValueError("内置预设配方只读：请先「复制配方」再拼接")
    spec = load_director_spec(recipe)
    segments = spec.get("segments") or []
    if not 0 <= start_index < len(segments):
        raise ValueError(f"起始段越界：第 {start_index + 1} 段（配方共 {len(segments)} 段）")
    clips = _clip_entries(recipe)
    missing = [i + 1 for i in range(start_index, len(segments)) if i not in clips]
    if missing:
        raise ValueError("这些段还没有单段产物，请先逐段生成：" + "、".join(f"第 {i} 段" for i in missing))
    return spec, clips


def assemble_film(recipe: str, start_index: int, film: str = "", blend: int = SEAM_BLEND_FRAMES,
                  continuity: bool = True, context_frames: int = 22, progress=None, should_cancel=None) -> dict:
    """拼成新成片：前缀（原成片第 1..start 段）+ 第 start..N-1 段的单段产物。

    progress(stage, value, total)：stage 为中文阶段描述，value/total 为已拼/总帧数；should_cancel() 返回真则中止。
    """
    notify = progress or (lambda stage, value, total: None)
    start_index = int(start_index)
    blend = max(0, int(blend or 0))
    spec, clips = _validate(recipe, start_index)
    segments = spec.get("segments") or []

    film_entry = None
    layout = []
    prefix_frames = 0
    if start_index > 0:
        film_entry = _film_entry(recipe, film)
        if film_entry is None:
            raise ValueError("起始段不是第 1 段，但该配方还没有可用的成片：前缀没有可取之处")
        layout = film_layout(film_entry, spec, continuity, context_frames)
        prefix_frames = layout[start_index - 1][0] + layout[start_index - 1][1]

    clip_frames = {i: _video_frame_count(clips[i]["path"]) for i in range(start_index, len(segments))}
    total = prefix_frames + sum(clip_frames.values())

    images = None
    audios = []
    offset = 0
    if prefix_frames:
        notify(f"读取成片前缀（{prefix_frames} 帧）", 0, total)
        prefix = InputImpl.VideoFromFile(film_entry["path"], start_time=0,
                                         duration=prefix_frames / H3_FPS).get_components()
        if int(prefix.images.shape[0]) != prefix_frames:
            raise ValueError(f"成片 {film_entry['filename']} 取到的前缀帧数 {int(prefix.images.shape[0])} 与段边界 "
                             f"{prefix_frames} 不一致：请换一个成片，或改成从第 1 段开始拼（不依赖前缀）")
        images = torch.empty((total, *prefix.images.shape[1:]), dtype=prefix.images.dtype)
        images[:prefix_frames] = prefix.images
        audios.append(prefix.audio)
        offset = prefix_frames
        del prefix

    for i in range(start_index, len(segments)):
        if should_cancel and should_cancel():
            raise _Cancelled()
        entry = clips[i]
        notify(f"读取第 {i + 1} 段片段（{clip_frames[i]} 帧）", offset, total)
        comp = InputImpl.VideoFromFile(entry["path"]).get_components()
        frames = comp.images
        if int(frames.shape[0]) != clip_frames[i]:
            raise ValueError(f"第 {i + 1} 段片段 {entry['filename']} 实际帧数 {int(frames.shape[0])} 与元数据 "
                             f"{clip_frames[i]} 不一致：请重新生成该段")
        if images is None:
            images = torch.empty((total, *frames.shape[1:]), dtype=frames.dtype)
        elif tuple(frames.shape[1:]) != tuple(images.shape[1:]):
            raise ValueError(f"第 {i + 1} 段片段 {entry['filename']} 的尺寸 {tuple(frames.shape[2:0:-1])} 与成片 "
                             f"{tuple(images.shape[2:0:-1])} 不一致：拼接要求所有段同分辨率")
        n = clip_frames[i]
        if blend > 0 and offset > 0:
            keep = min(blend, offset, n)
            images[offset - keep:offset] = _blend_seam(images[offset - keep:offset], frames, keep, keep)
        images[offset:offset + n] = frames
        audios.append(comp.audio)
        offset += n
        del comp, frames

    if images is None:
        raise ValueError("没有可拼接的内容：请先逐段生成至少一段")
    if should_cancel and should_cancel():
        raise _Cancelled()

    audio = _concat_segment_audio(audios, H3_FPS, [0] * len(audios))
    warnings = []
    if any(a is None for a in audios):
        warnings.append("有片段没有音频轨：已输出无声成片")
        audio = None

    notify("编码成片", total, total)
    out_dir = pathlib.Path(folder_paths.get_output_directory()) / MERGE_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{_safe_name(recipe)}_merged_{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.mp4"
    video = InputImpl.VideoFromComponents(Types.VideoComponents(
        images=images, audio=audio, frame_rate=Fraction(H3_FPS)))
    video.save_to(str(out_dir / filename), format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)

    merged_layout = [kept for _start, kept in layout[:start_index]]
    merged_layout += [clip_frames[i] for i in range(start_index, len(segments))]
    add_recipe_results(recipe, [{
        "filename": filename, "subfolder": MERGE_DIR, "type": "output", "kind": "video",
        "layout": merged_layout,
    }])
    return {"filename": filename, "subfolder": MERGE_DIR, "frames": int(images.shape[0]),
            "layout": merged_layout, "film": film_entry["filename"] if film_entry is not None else None,
            "prefix_frames": prefix_frames, "warnings": warnings,
            "clips": [{"segment": i, "filename": clips[i]["filename"], "frames": clip_frames[i]}
                      for i in range(start_index, len(segments))]}


# ===========================================================================
# 拼接任务：后台线程 + 快照（进度 / 阶段 / 取消）
# ===========================================================================

_TASKS: dict = {}


def _snapshot(task: dict) -> dict:
    return {key: task[key] for key in (
        "task_id", "status", "recipe", "from", "film", "blend", "filename", "frames",
        "progress", "stage", "clips", "warnings", "error", "created", "updated")}


def _prune_tasks() -> None:
    now = time.time()
    for task in [t for t in _TASKS.values() if t["status"] not in ("queued", "running")]:
        if now - task["updated"] > TASK_TTL:
            _TASKS.pop(task["task_id"], None)
    while len(_TASKS) > MAX_TASKS:
        oldest = min((t for t in _TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            return
        _TASKS.pop(oldest["task_id"], None)


def _run_task(task_id: str) -> None:
    """后台线程：跑拼接并持续写任务快照；取消是协作式的（在片段/阶段边界生效）。"""
    task = _TASKS.get(task_id)
    if task is None:
        return
    task["status"] = "running"
    task["updated"] = time.time()

    def on_progress(stage, value, total):
        task["stage"] = stage
        if total:
            task["progress"] = {"value": int(value), "max": int(total)}
        task["updated"] = time.time()

    try:
        result = assemble_film(task["recipe"], task["from"], film=task["film"], blend=task["blend"],
                               continuity=task["continuity"], context_frames=task["context_frames"],
                               progress=on_progress, should_cancel=lambda: bool(task.get("cancel")))
        task.update({"status": "succeeded", "filename": result["filename"], "frames": result["frames"],
                     "clips": result["clips"], "warnings": result["warnings"],
                     "film": result["film"] or "", "progress": None, "stage": ""})
    except _Cancelled:
        task.update({"status": "cancelled", "error": "已取消", "progress": None, "stage": ""})
    except ValueError as e:
        task.update({"status": "failed", "error": str(e), "progress": None, "stage": ""})
    except Exception as e:
        logger.error(f"[NeoNodes] assemble task {task_id} failed: {e}")
        task.update({"status": "failed", "error": str(e), "progress": None, "stage": ""})
    task["updated"] = time.time()


def _as_bool(value, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    return str(value).strip().lower() not in ("0", "false", "no")


@PromptServer.instance.routes.get("/neo_video_gen/segment_clips")
async def segment_clips_route(request):
    """单段/拼接两端 UI 的现状：可选成片（含段边界）与每段已有片段、帧数。"""
    query = request.rel_url.query
    recipe = str(query.get("recipe") or "").strip()
    if not recipe:
        return web.json_response({"success": False, "error": "缺少配方名"}, status=400)
    try:
        status = segment_status(recipe, _as_bool(query.get("continuity")),
                                int(query.get("context_frames") or 22))
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    return web.json_response({"success": True, **status})


@PromptServer.instance.routes.post("/neo_video_gen/assemble_segments")
async def assemble_segments_route(request):
    """确认后拼接（`{recipe, from, film?, blend?, continuity?, context_frames?}`）：起后台线程拼新成片。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    recipe = str(data.get("recipe") or "").strip()
    if not recipe:
        return web.json_response({"success": False, "error": "缺少配方名"}, status=400)
    start_index = int(data.get("from", 0))
    try:
        _validate(recipe, start_index)
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)

    task_id = str(uuid.uuid4())
    now = time.time()
    _TASKS[task_id] = {
        "task_id": task_id, "status": "queued", "recipe": recipe, "from": start_index,
        "film": str(data.get("film") or "").strip(), "blend": int(data.get("blend", SEAM_BLEND_FRAMES)),
        "continuity": bool(data.get("continuity", True)), "context_frames": int(data.get("context_frames", 22)),
        "filename": None, "frames": 0, "progress": None, "stage": "", "clips": [],
        "warnings": [], "error": "", "cancel": False, "created": now, "updated": now,
    }
    threading.Thread(target=_run_task, args=(task_id,), name=f"neo-assemble-{task_id[:8]}", daemon=True).start()
    _prune_tasks()
    return web.json_response({"success": True, **_snapshot(_TASKS[task_id])})


@PromptServer.instance.routes.get("/neo_video_gen/assemble_segments/{task_id}")
async def assemble_status_route(request):
    """拼接任务快照：status（queued/running/succeeded/failed/cancelled）+ progress + stage + filename。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    return web.json_response({"success": True, **_snapshot(task)})


@PromptServer.instance.routes.post("/neo_video_gen/assemble_segments/{task_id}/cancel")
async def assemble_cancel_route(request):
    """取消拼接（协作式：当前片段处理完后生效）。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    if task["status"] not in ("queued", "running"):
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    task["cancel"] = True
    return web.json_response({"success": True})


