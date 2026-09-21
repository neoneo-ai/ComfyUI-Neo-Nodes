# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 图片分镜（storyboard）生成
# 用生图技能（默认 Qwen Image 2.1，Krea2 备选）逐段生成关键帧，落在
# input/NeoDirector/storyboard_{recipe}_{seg:02d}.png；i2v/fl2v 段可自动用作首帧。
# 独立于 h3_video_director（节点运行时），只依赖生图链（image_gen/skill）与配方读取。

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from pathlib import Path

import folder_paths
import nodes as comfy_nodes
from aiohttp import web
from server import PromptServer

from .image_gen import (
    DEFAULT_SETTINGS,
    parse_ratio,
    render_template,
    resolve_dimensions,
    resolve_request,
)
from .krea2_generate import execute_graph_inprocess
from .recipes import _copy_media_to_input, _find_recipe_dir
from .skill import get_skill_gen_config, load_skill_workflow

logger = logging.getLogger(__name__)

_STORYBOARD_MAX_REFS = 10  # 参考图总上限（角色/背景 + 链式上一分镜）；Qwen Image 2.1 编辑最多 10 张（第 1 张为编辑目标，其余为参考对象），不再人为收紧
_storyboard_tasks: dict[str, dict] = {}


def _storyboard_recipe_meta(name: str) -> dict | None:
    """读配方 recipe.json；不存在或非法返回 None。"""
    recipe_dir = _find_recipe_dir(name)
    if recipe_dir is None:
        return None
    try:
        meta = json.loads((recipe_dir / "recipe.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    return meta if isinstance(meta, dict) else None


def _storyboard_story_refs(name: str) -> list[str]:
    """故事里的角色/背景参考图（assets 最终名）复制到 input/，返回 LoadImage 可用的相对名列表。"""
    meta = _storyboard_recipe_meta(name)
    if not meta:
        return []
    story = meta.get("director_story") or {}
    names = []
    for ref in (story.get("characters") or []) + (story.get("backgrounds") or []):
        fn = str((ref or {}).get("filename") or "").strip()
        if not fn:
            continue
        src = _find_recipe_dir(name) / "assets" / fn
        if not src.is_file():
            continue
        resolved, _skipped = _copy_media_to_input(src, fn)
        if resolved and resolved not in names:
            names.append(resolved)
    return names


def _storyboard_dims(width, height, ratio):
    """分镜图尺寸：显式宽高 > 配方统一设置的比例（1024 基准）> 默认 1:1 方图（1024）。"""
    settings = {"base_resolution": 1024}
    try:
        w, h = int(width or 0), int(height or 0)
    except (TypeError, ValueError):
        w = h = 0
    if w > 0 and h > 0:
        return resolve_dimensions(settings, width=w, height=h)
    value = parse_ratio(ratio)
    if value:
        return resolve_dimensions(settings, ratio=ratio)
    return resolve_dimensions(settings)


async def _run_storyboard_task(task_id: str, name: str, segments: list, skill_id: str,
                               chain_prev: bool, base_seed, index_offset: int = 0):
    """串行生成。index_offset：单段重生成时该段在配方里的真实序号（文件名对齐 storyboard_{recipe}_{n:02d}）。"""
    template = load_skill_workflow(skill_id)
    settings = {**DEFAULT_SETTINGS}
    for key, value in (get_skill_gen_config(skill_id) or {}).items():
        if key in DEFAULT_SETTINGS and value not in (None, "", []):
            settings[key] = value

    story_refs = await asyncio.to_thread(_storyboard_story_refs, name)
    out_dir = Path(folder_paths.get_input_directory()) / "NeoDirector"
    out_dir.mkdir(parents=True, exist_ok=True)
    task = _storyboard_tasks[task_id]

    for i, seg in enumerate(segments):
        entry = task["details"][i]
        n = index_offset + i + 1   # 该段在配方里的真实序号（1 起，文件名对齐 storyboard_{recipe}_{n:02d}）
        fname = f"storyboard_{name}_{n:02d}.png"
        if not str((seg or {}).get("prompt") or "").strip():
            entry.update(status="skipped", error="该段没有提示词")
            task["processed"] += 1
            continue
        if entry.get("filename") and not seg.get("_force"):
            # 已有产物且非强制重生成：跳过（幂等，重复点「生成分镜」不重复出图）
            entry.update(status="done", filename=entry["filename"],
                         preview_url=f"/input/NeoDirector/{fname}?t={int(time.time())}")
            task["processed"] += 1
            continue
        prompt = str(seg.get("storyboard_prompt") or seg.get("prompt")).strip()
        # 参考图：角色/背景在前，链式最近两张分镜在后（<imageN> 顺序与之一致），总数截断到上限。
        # 单段重生成时链式参考从磁盘取已落盘的分镜（本任务里没有前面各段的记录）。
        refs = list(story_refs)
        if chain_prev:
            for j in range(max(n - 4, -1) + 1, n - 1):
                prev = task["details"][j] if (not index_offset and j < len(task["details"])) else None
                prev_fname = prev.get("filename") if prev and prev.get("status") == "done" else None
                if not prev_fname:
                    candidate = f"storyboard_{name}_{j + 1:02d}.png"
                    if (out_dir / candidate).is_file():
                        prev_fname = candidate
                if prev_fname:
                    refs.append(f"NeoDirector/{prev_fname}")
        body = {
            "prompt": prompt,
            "width": entry["width"], "height": entry["height"],
            "seed": int(base_seed) + n,
            "references": [{"kind": "input", "value": r} for r in refs[:_STORYBOARD_MAX_REFS]],
            "loras": settings.get("loras") or [],
        }
        try:
            params = resolve_request(body, settings, max_refs=_STORYBOARD_MAX_REFS, auto_quadview=False)
            graph, warns = render_template(template, params)
            entry["warnings"] = list(warns)
            result = await asyncio.to_thread(execute_graph_inprocess, graph, task_id)
            img = (result.get("images") or [None])[0]
            if img is None:
                raise ValueError("生图工作流没有输出图片节点")
            await asyncio.to_thread(img.save, out_dir / fname, "PNG")
            entry.update(status="done", filename=fname,
                         preview_url=f"/input/NeoDirector/{fname}?t={int(time.time())}")
        except Exception as e:
            logger.warning(f"[NeoNodes] storyboard seg {i + 1} failed: {e}")
            entry.update(status="failed", error=str(e))
        task["processed"] += 1
        if comfy_nodes.interrupt_processing(task_id):
            task.update(status="cancelled")
            break

    if task["status"] != "cancelled":
        task["status"] = "done"
    task["updated"] = time.time()


routes = PromptServer.instance.routes



@routes.post("/neo_video_gen/storyboard_generate")
async def neo_video_gen_storyboard_generate(request):
    """按段串行生成图片分镜（生图技能默认 qwen_image_21，Krea2 备选）；返回 task_id 轮询进度。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是有效 JSON"}, status=400)
    name = str(data.get("name") or "").strip()
    if not name:
        return web.json_response({"success": False, "error": "请先填写配方名称"}, status=400)
    meta = _storyboard_recipe_meta(name)
    if meta is None:
        return web.json_response({"success": False, "error": f"配方不存在：{name}"}, status=404)

    segments = data.get("segments") or []
    if not isinstance(segments, list) or not segments:
        return web.json_response({"success": False, "error": "请先拆分出分段"}, status=400)
    skill_id = str(data.get("skill_id") or "qwen_image_21").strip()
    if load_skill_workflow(skill_id) is None:
        return web.json_response({"success": False, "error": f"生图技能 {skill_id} 没有工作流模板"}, status=400)

    shared = meta.get("shared") or {}
    try:
        base_seed = int(data.get("seed")) if data.get("seed") not in (None, "") else int(shared.get("seed") or 0)
    except (TypeError, ValueError):
        base_seed = random.randint(0, 2**31 - 1)

    task_id = str(uuid.uuid4())
    out_dir = Path(folder_paths.get_input_directory()) / "NeoDirector"
    try:
        index_offset = int(data.get("index") or 0)
    except (TypeError, ValueError):
        index_offset = 0
    details = []
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            seg = {}
        width, height = _storyboard_dims(data.get("width"), data.get("height"),
                                         data.get("ratio") or shared.get("ratio"))
        fname = f"storyboard_{name}_{index_offset + i + 1:02d}.png"
        details.append({"index": index_offset + i, "status": "pending",
                        "filename": fname if (out_dir / fname).is_file() else None,
                        "error": "", "preview_url": None, "warnings": [],
                        "width": width, "height": height})
        if data.get("force"):
            seg["_force"] = True
    _storyboard_tasks[task_id] = {
        "task_id": task_id, "name": name, "skill_id": skill_id,
        "status": "running", "total": len(details), "processed": 0,
        "created": time.time(), "updated": time.time(), "details": details,
    }
    asyncio.create_task(_run_storyboard_task(task_id, name, segments, skill_id,
                                             bool(data.get("chain_prev", True)), base_seed, index_offset))
    return web.json_response({"success": True, "task_id": task_id, "total": len(details)})


@routes.get("/neo_video_gen/storyboard_status/{task_id}")
async def neo_video_gen_storyboard_status(request):
    """分镜生成任务进度快照（逐段状态 / 产物文件名 / 预览 URL）。"""
    task = _storyboard_tasks.get(request.match_info["task_id"])
    if not task:
        return web.json_response({"success": False, "error": "任务不存在或已过期"}, status=404)
    return web.json_response({
        "success": True,
        "status": task["status"],
        "total": task["total"],
        "processed": task["processed"],
        "details": task["details"],
    })


@routes.post("/neo_video_gen/storyboard_cancel/{task_id}")
async def neo_video_gen_storyboard_cancel(request):
    """停止分镜生成（置全局中断标志，当前段跑完后停）。"""
    task = _storyboard_tasks.get(request.match_info["task_id"])
    if not task:
        return web.json_response({"success": False, "error": "任务不存在或已过期"}, status=404)
    comfy_nodes.interrupt_processing(task["task_id"])
    return web.json_response({"success": True})
