# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 图片分镜（storyboard）生成
# 用生图技能逐段生成关键帧：mode=t2i 纯文生图（不带参考，默认 Krea2），
# mode=r2i 参考编辑（角色参考，用所选技能不强制切 Qwen），
# 缺省 mode 为旧行为（文生图默认 Krea2，带参考图的段固定切 Qwen Image 2.1）；
# 关键帧直接落配方自己的 assets/storyboard_{recipe}_{seg:02d}.png（配方自包含、导出即带分镜图），
# i2v/fl2v 段没另设首帧时用它作首帧，预览走 /rs_recipes/asset。
# 独立于 h3_video_director（节点运行时），只依赖生图链（image_gen/skill）与配方读取。

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import folder_paths
import nodes as comfy_nodes
import comfy.model_management
import torch
from aiohttp import web
from PIL import Image
from server import PromptServer
from comfy_execution.utils import CurrentNodeContext

from .image_gen import (
    DEFAULT_SETTINGS,
    _SKILL_SETTING_KEYS,
    parse_ratio,
    render_template,
    resolve_dimensions,
    resolve_request,
)
from .image_gen_edit import execute_graph_inprocess
from .recipes import _copy_media_to_input, _find_recipe_dir, _sanitize_name_re
from .skill import get_skill_gen_config, load_skill_workflow

logger = logging.getLogger(__name__)

_STORYBOARD_MAX_REFS = 10  # 参考图总上限（角色 ≤6，前端已限）；Qwen Image 2.1 编辑最多 10 张（第 1 张为编辑目标，其余为参考对象），不再人为收紧
_STORYBOARD_REF_SKILL = "qwen_image_21"   # 带参考图的段固定用它做参考编辑（Krea2 单路模板不支持多参考延续）；纯文生图用所选技能（默认 Krea2）
_GRID_STORYBOARD_SKILL = "nine_grid_storyboard"   # 一键九宫格分镜图：idea → Qwen Image 2.1（模板内置九宫格指令）
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
    """故事里的角色参考图（assets 最终名）复制到 input/，返回 LoadImage 可用的相对名列表。"""
    meta = _storyboard_recipe_meta(name)
    if not meta:
        return []
    story = meta.get("story") or {}
    names = []
    for ref in (story.get("characters") or []):
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


def _grid_storyboard_dims(ratio):
    """九宫格尺寸：2048 基准（每格约 683×384 @16:9，够拆分后当首帧用）；
    无比例（未保存新配方）默认 16:9，不回退 1:1 方图。"""
    value = parse_ratio(ratio) or (16 / 9)
    return resolve_dimensions({"base_resolution": 2048}, ratio=value)


def _tensor_to_pil(image):
    """[H,W,C] float(0-1) 张量 → PIL RGB 图（单通道转灰度）。"""
    arr = (image.detach().cpu() * 255).clamp(0, 255).to(torch.uint8).numpy()
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[:, :, 0]
    return Image.fromarray(arr)


async def _run_storyboard_task(task_id: str, name: str, segments: list, skill_id: str,
                               base_seed, index_offset: int = 0, mode=None):
    """串行生成。index_offset：单段重生成时该段在配方里的真实序号（文件名对齐 storyboard_{recipe}_{n:02d}）。
    mode：t2i=纯文生图（不用角色参考）；r2i=参考编辑（用角色参考）；
    均按所选技能执行、不强制切 Qwen Image 2.1。缺省 None 为旧行为（带参考图的段自动切 Qwen）。"""
    story_refs = [] if mode == "t2i" else await asyncio.to_thread(_storyboard_story_refs, name)
    _assets_cache: dict[str, tuple] = {}

    def _skill_assets(sid):
        """技能 (workflow 模板, 生图设置)；按段在「所选文生图技能 / Qwen Image 2.1 参考编辑」间切换，懒加载并缓存。"""
        assets = _assets_cache.get(sid)
        if assets is None:
            settings = {**DEFAULT_SETTINGS}
            for key, value in (get_skill_gen_config(sid) or {}).items():
                if key in _SKILL_SETTING_KEYS and value not in (None, "", []):
                    settings[key] = value
            assets = (load_skill_workflow(sid), settings)
            _assets_cache[sid] = assets
        return assets

    # 关键帧是配方资产：直接写进 <recipe>/assets/，不进全局 input/（导出配方即自带分镜图）
    out_dir = _find_recipe_dir(name) / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    task = _storyboard_tasks[task_id]
    # 清掉上一次运行/取消残留的全局中断标志，避免新任务一开始就被误判为已取消。
    comfy_nodes.interrupt_processing(False)

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
                         preview_url=f"/rs_recipes/asset?recipe={quote(name)}&file={quote(fname)}&t={int(time.time())}")
            task["processed"] += 1
            continue
        storyboard_prompt = str(seg.get("storyboard_prompt") or "").strip()
        prompt = storyboard_prompt or str(seg.get("prompt") or "").strip()
        # 缺分镜提示词 → 回退视频提示词（旧配方/未拆分快照仍可跑），但要让用户看见：
        # 视频提示词写的是运动过程与时间流，不一定适合当生图提示词
        fallback_warnings = [] if storyboard_prompt else ["该段没有分镜提示词，已回退用视频提示词生图（含运动描述，不一定适合生图）"]
        entry["warnings"] = list(fallback_warnings)
        # 参考图：角色参考（<imageN> 顺序与之一致），总数截断到上限。
        refs = list(story_refs)
        # 旧行为（mode=None）：带参考图 → 固定 Qwen Image 2.1 参考编辑，纯文生图用所选技能（默认 Krea2）；
        # 显式 t2i/r2i 模式一律按所选技能执行（r2i 的参考能力由技能模板自身决定）
        eff_skill = _STORYBOARD_REF_SKILL if (mode is None and refs and skill_id != _STORYBOARD_REF_SKILL) else skill_id
        template, settings = _skill_assets(eff_skill)
        if template is None:
            entry.update(status="failed", error=f"生图技能 {eff_skill} 没有工作流模板")
            task["processed"] += 1
            continue
        body = {
            "prompt": prompt,
            "width": entry["width"], "height": entry["height"],
            "seed": int(base_seed),   # 同一次生成各段共用同一 seed（提示词仍逐段不同），降低段间随机漂移；再次生成换新基
            "references": [{"kind": "input", "value": r} for r in refs[:_STORYBOARD_MAX_REFS]],
            "loras": settings.get("loras") or [],
        }
        try:
            params = resolve_request(body, settings, max_refs=_STORYBOARD_MAX_REFS, auto_quadview=False)
            graph, warns = render_template(template, params)
            entry["warnings"] = fallback_warnings + list(warns) + (["该段带参考图，已切 Qwen Image 2.1 参考编辑"] if eff_skill != skill_id else [])
            # 进程内执行不走 ComfyUI 队列，没有 last_prompt_id；显式给一个执行上下文（prompt_id=task_id），
            # 采样器上报进度时 hook 靠它取 prompt_id/node_id，否则会回退读 server_instance.last_prompt_id → AttributeError。
            with CurrentNodeContext(prompt_id=task_id, node_id=f"storyboard_{name}_{n}"):
                result = await asyncio.to_thread(execute_graph_inprocess, graph)
            img = _tensor_to_pil(result[0])
            await asyncio.to_thread(img.save, out_dir / fname, "PNG")
            entry.update(status="done", filename=fname,
                         preview_url=f"/rs_recipes/asset?recipe={quote(name)}&file={quote(fname)}&t={int(time.time())}")
        except comfy.model_management.InterruptProcessingException:
            # 用户点「取消」：当前段被中断。该异常继承 BaseException，except Exception 接不住，
            # 必须单独捕获并收尾，否则任务异常从未被取回、状态卡在 running（抛出时 ComfyUI 已复位全局标志）。
            task.update(status="cancelled")
            break
        except Exception as e:
            logger.warning(f"[NeoNodes] storyboard seg {i + 1} failed: {e}")
            entry.update(status="failed", error=str(e))
        task["processed"] += 1

    if task["status"] != "cancelled":
        task["status"] = "done"
    task["updated"] = time.time()


async def _run_grid_storyboard_task(task_id: str, name: str, idea: str, base_seed):
    """一键九宫格分镜图：单图任务（details 一条）。已保存配方产物落 assets/ 并拷到 input/；
    未保存的新配方直接落 input/（保存时由前端按资产引用拷进 assets/）。grid_split 都从 input/ 读。"""
    task = _storyboard_tasks[task_id]
    entry = task["details"][0]
    fname = f"grid_storyboard_{name}.png"
    comfy_nodes.interrupt_processing(False)   # 清掉上一次运行/取消残留的全局中断标志
    settings = {**DEFAULT_SETTINGS}
    for key, value in (get_skill_gen_config(_GRID_STORYBOARD_SKILL) or {}).items():
        if key in _SKILL_SETTING_KEYS and value not in (None, "", []):
            settings[key] = value
    template = load_skill_workflow(_GRID_STORYBOARD_SKILL)
    body = {
        "prompt": idea,   # 九宫格指令已内置在技能模板（固定前缀 + {{PROMPT}}），这里只传 idea
        "width": entry["width"], "height": entry["height"],
        "seed": int(base_seed),
        "references": [],
        "loras": settings.get("loras") or [],
    }
    try:
        params = resolve_request(body, settings, max_refs=0, auto_quadview=False)
        graph, warns = render_template(template, params)
        entry["warnings"] = list(warns)
        with CurrentNodeContext(prompt_id=task_id, node_id=f"grid_storyboard_{name}"):
            result = await asyncio.to_thread(execute_graph_inprocess, graph)
        img = _tensor_to_pil(result[0])
        if _find_recipe_dir(name) is not None:
            out_dir = _find_recipe_dir(name) / "assets"
            out_dir.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(img.save, out_dir / fname, "PNG")
            resolved, _skipped = await asyncio.to_thread(_copy_media_to_input, out_dir / fname, fname)
            preview_url = f"/rs_recipes/asset?recipe={quote(name)}&file={quote(resolved or fname)}&t={int(time.time())}"
        else:
            in_dir = Path(folder_paths.input_directory)
            await asyncio.to_thread(img.save, in_dir / fname, "PNG")
            resolved = fname
            preview_url = f"/view?filename={quote(fname)}&subfolder=&type=input"
        entry.update(status="done", filename=resolved, preview_url=preview_url)
    except comfy.model_management.InterruptProcessingException:
        task.update(status="cancelled")
    except Exception as e:
        logger.warning(f"[NeoNodes] grid storyboard failed: {e}")
        entry.update(status="failed", error=str(e))
    task["processed"] += 1
    if task["status"] != "cancelled":
        task["status"] = "done"
    task["updated"] = time.time()


routes = PromptServer.instance.routes



@routes.post("/neo_video_gen/storyboard_generate")
async def neo_video_gen_storyboard_generate(request):
    """按段串行生成图片分镜；返回 task_id 轮询进度。
    mode：t2i=纯文生图（忽略角色参考）；r2i=参考编辑（用所选技能，不强制切 Qwen）；
    缺省为旧行为（文生图默认 Krea2，带参考图的段自动切 Qwen Image 2.1）。
    force=True：已有产物的段也重新生成（未显式钉 seed 时换新随机基，避免同图）。"""
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
    mode = str(data.get("mode") or "").strip().lower()
    if mode not in ("", "t2i", "r2i"):
        return web.json_response({"success": False, "error": f"未知的分镜模式：{mode}"}, status=400)
    skill_id = str(data.get("skill_id") or "image_gen").strip()   # 文生图默认 Krea2；旧行为下带参考图的段在任务内切 Qwen Image 2.1
    if load_skill_workflow(skill_id) is None:
        return web.json_response({"success": False, "error": f"生图技能 {skill_id} 没有工作流模板"}, status=400)

    shared = meta.get("shared") or {}
    force = bool(data.get("force"))
    try:
        base_seed = int(data.get("seed")) if data.get("seed") not in (None, "") else int(shared.get("seed") or 0)
    except (TypeError, ValueError):
        base_seed = random.randint(0, 2**31 - 1)
    if force and data.get("seed") in (None, ""):
        # 强制重生成 = 用户明确要「换图」：未钉种子时换新随机基（否则同 seed → 同图，重生成无意义）
        base_seed = random.randint(0, 2**31 - 1)

    task_id = str(uuid.uuid4())
    # 幂等跳过检查看的是配方 assets/（关键帧就生成在那里）
    out_dir = _find_recipe_dir(name) / "assets"
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
        if force:
            seg["_force"] = True
    _storyboard_tasks[task_id] = {
        "task_id": task_id, "name": name, "skill_id": skill_id,
        "status": "running", "total": len(details), "processed": 0,
        "created": time.time(), "updated": time.time(), "details": details,
    }
    handle = asyncio.create_task(_run_storyboard_task(task_id, name, segments, skill_id,
                                                      base_seed, index_offset, mode or None))

    def _on_done(done_handle, _tid=task_id):
        # fire-and-forget 收尾：取回异常，避免未捕获时打出 "Task exception was never retrieved"。
        # 正常/取消已在任务内收尾（无异常）；这里只兜底 setup 阶段等未预期异常，把卡 running 的任务置 failed。
        exc = done_handle.exception()
        if exc is None:
            return
        logger.warning(f"[NeoNodes] storyboard task {_tid} crashed: {exc}")
        t = _storyboard_tasks.get(_tid)
        if t and t["status"] == "running":
            t.update(status="failed", error=str(exc))

    handle.add_done_callback(_on_done)
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


@routes.post("/neo_video_gen/grid_storyboard_generate")
async def neo_video_gen_grid_storyboard_generate(request):
    """一键九宫格分镜图：idea → Qwen Image 2.1 出 3×3 宫格（nine_grid_storyboard 技能，模板内置九宫格指令）。
    允许未保存的新配方（产物直接落 input/）；已保存配方落 assets/ 并拷到 input/。
    details[0].filename 为 input/ 名，可直接作宫格拆分源图；返回 task_id，进度复用 /neo_video_gen/storyboard_status/{task_id} 轮询。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是有效 JSON"}, status=400)
    name = str(data.get("name") or "").strip()
    if not name:
        return web.json_response({"success": False, "error": "请先填写配方名称"}, status=400)
    # 与配方保存同一套清洗：未保存的新配方先生成产物，落盘名不能随保存时清洗漂移
    name = _sanitize_name_re.sub("", name).strip().replace(" ", "-")
    if not name:
        return web.json_response({"success": False, "error": "请先填写配方名称"}, status=400)
    idea = str(data.get("idea") or "").strip()
    if not idea:
        return web.json_response({"success": False, "error": "请先填写故事主题 / 想法"}, status=400)
    meta = _storyboard_recipe_meta(name)   # 未保存的新配方为 None：默认宽高比，产物直接落 input/
    if load_skill_workflow(_GRID_STORYBOARD_SKILL) is None:
        return web.json_response({"success": False, "error": f"生图技能 {_GRID_STORYBOARD_SKILL} 没有工作流模板"}, status=400)

    shared = (meta or {}).get("shared") or {}
    try:
        base_seed = int(data.get("seed")) if data.get("seed") not in (None, "") else int(shared.get("seed") or 0)
    except (TypeError, ValueError):
        base_seed = random.randint(0, 2**31 - 1)
    if data.get("seed") in (None, ""):
        # 一键生成 = 每次都要新图：未钉种子时换新随机基（否则同 seed → 同图，重生成无意义）
        base_seed = random.randint(0, 2**31 - 1)

    task_id = str(uuid.uuid4())
    width, height = _grid_storyboard_dims(shared.get("ratio"))
    _storyboard_tasks[task_id] = {
        "task_id": task_id, "name": name, "skill_id": _GRID_STORYBOARD_SKILL,
        "status": "running", "total": 1, "processed": 0,
        "created": time.time(), "updated": time.time(),
        "details": [{"index": 0, "status": "pending", "filename": None,
                     "error": "", "preview_url": None, "warnings": [],
                     "width": width, "height": height}],
    }
    handle = asyncio.create_task(_run_grid_storyboard_task(task_id, name, idea, base_seed))

    def _on_done(done_handle, _tid=task_id):
        # 兜底 setup 阶段等未预期异常：把卡 running 的任务置 failed（正常/取消已在任务内收尾）
        exc = done_handle.exception()
        if exc is None:
            return
        logger.warning(f"[NeoNodes] grid storyboard task {_tid} crashed: {exc}")
        t = _storyboard_tasks.get(_tid)
        if t and t["status"] == "running":
            t.update(status="failed", error=str(exc))

    handle.add_done_callback(_on_done)
    return web.json_response({"success": True, "task_id": task_id, "total": 1})
