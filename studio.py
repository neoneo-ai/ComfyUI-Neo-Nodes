"""Neo Studio 独立应用后端：导演配方「整片生成」+ 版本信息。

Studio 页面（web/studio/index.html）走 ComfyUI 的 /extensions/ 静态路由提供，前端直接复用
web/ 现有模块；素材、生图、配方、单段、拼接、故事板、LLM 等功能全部复用已有路由，本模块只补
两样东西：

- 整片生成：ComfyUI 里由画布上的 NeoH3VideoDirector 节点跑，Studio 没有画布，这里把
  「NeoH3VideoDirector + SaveVideo」两节点图提交进执行队列（显存/进度/取消都由执行器负责），
  任务跟踪与 h3_segment 同一套做法；导演节点本身不记账，成功后由这里把成片记进配方「结果」区。
- /neo_studio/version：插件 + ComfyUI 版本，供 Studio 首页展示升级信息。
"""

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .h3_preview import clear_latest_preview, get_latest_preview
from .image_gen import _error_from_history, _lookup, _progress_for, submit_graph
from .recipes import add_recipe_results, is_preset_recipe, list_director_recipes, load_director_spec

logger = logging.getLogger(__name__)

TASK_TTL = 3600.0     # 任务记录保留时长（秒）
POLL_INTERVAL = 1.0   # 轮询队列状态的间隔（秒）
STATUS_EVENT = "rs.director.status"

_TASKS: dict = {}
_WATCHERS: dict = {}


def _safe_name(text) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(text).strip()).strip("_") or "recipe"


def _video_from_history(item: dict) -> tuple:
    """从 history 的 outputs 里找 SaveVideo 落盘的视频条目，返回 (filename, subfolder)。"""
    for outs in (item.get("outputs") or {}).values():
        if not isinstance(outs, dict):
            continue
        for entries in outs.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict) and str(entry.get("filename", "")).lower().endswith((".mp4", ".webm")):
                    return entry["filename"], str(entry.get("subfolder") or "")
    return None, ""


def _snapshot(task: dict) -> dict:
    return {key: task[key] for key in (
        "task_id", "prompt_id", "status", "recipe", "seed",
        "filename", "subfolder", "progress", "error", "created", "updated")}


def _prune_tasks() -> None:
    """清掉过期或超额的历史任务记录（运行中的不动）。"""
    now = time.time()
    for task in [t for t in _TASKS.values() if t["status"] not in ("queued", "running")]:
        if now - task["updated"] > TASK_TTL:
            _TASKS.pop(task["task_id"], None)
    while len(_TASKS) > 32:
        oldest = min((t for t in _TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            return
        _TASKS.pop(oldest["task_id"], None)


def _notify(task: dict) -> None:
    """任务快照有变化时经 WebSocket 推给所有客户端（前端按 task_id 过滤）。"""
    PromptServer.instance.send_sync(STATUS_EVENT, _snapshot(task))


async def _watch(task_id: str) -> None:
    """轮询队列状态直到结束：更新进度、收产物名与错误，成功后把成片记进配方结果。"""
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = _TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        state, item = _lookup(task["prompt_id"])
        if state == "done":
            error, cancelled = _error_from_history(item)
            filename, subfolder = (None, "")
            if not error and not cancelled:
                filename, subfolder = _video_from_history(item)
                if filename:
                    try:
                        add_recipe_results(task["recipe"], [{
                            "filename": filename, "subfolder": subfolder, "type": "output",
                            "kind": "video", "seed": task["seed"],
                        }])
                    except Exception as e:
                        logger.warning(f"[NeoNodes] studio: record result failed: {e}")
            task["status"] = "cancelled" if cancelled else ("failed" if error else "succeeded")
            task["filename"] = filename
            task["subfolder"] = subfolder
            task["error"] = error
            task["progress"] = None
            task["updated"] = time.time()
            _WATCHERS.pop(task_id, None)
            clear_latest_preview(task_id)   # 终态后轮询兜底不再需要最新帧
            if error and not cancelled:
                logger.warning(f"[NeoNodes] studio director task {task_id} failed: {error}")
            _notify(task)
            return
        if state == "running":
            changed = task["status"] != "running"
            task["status"] = "running"
            progress = _progress_for(task["prompt_id"])
            if progress is not None and task.get("progress") != progress:
                task["progress"] = progress
                changed = True
            task["updated"] = time.time()
            if changed:
                _notify(task)


def _run_prompt(data: dict, unique_id: str) -> dict:
    """校验请求并组装「NeoH3VideoDirector + SaveVideo」两节点图（真正执行交给队列）。"""
    recipe = str(data.get("recipe") or "").strip()
    if not recipe:
        raise ValueError("缺少配方名")
    if is_preset_recipe(recipe):
        raise ValueError("内置预设配方只读：请先「复制配方」再生成整片")
    spec = load_director_spec(recipe)
    if not (spec.get("segments") or []):
        raise ValueError(f"配方 '{recipe}' 没有可执行的段")
    return {
        "recipe": recipe,
        "seed": int(data.get("seed", -1)),
        # 节点 key = task_id：执行器注入 UNIQUE_ID 时自然等于 task_id，
        # 预览广播载荷的 node_id 与 Studio 前端过滤条件一致。
        "graph": {
            unique_id: {"class_type": "NeoH3VideoDirector", "inputs": {
                "recipe": recipe,
                "seed": int(data.get("seed", -1)),
                "width": int(data.get("width", -1)),
                "height": int(data.get("height", -1)),
                "continuity": bool(data.get("continuity", True)),
                "context_frames": int(data.get("context_frames", 22)),
                "steps": int(data.get("steps", -1)),
                "preview": True,
            }},
            "2": {"class_type": "SaveVideo", "inputs": {
                "video": [unique_id, 0],
                "filename_prefix": f"NeoDirector/{_safe_name(recipe)}",
                "format": "auto",   # 新版核心 SaveVideo 必填（无默认值）
            }},
        },
    }


@PromptServer.instance.routes.post("/neo_studio/director/generate")
async def director_generate_route(request):
    """把整条导演配方提交到 ComfyUI 执行队列，返回任务快照。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    task_id = str(uuid.uuid4())   # 先建：作为 unique_id 写进图，预览载荷按它路由回 Studio 页面
    try:
        payload = _run_prompt(data, task_id)
        prompt_id = await submit_graph(payload["graph"])
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"[NeoNodes] studio director generate failed: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

    now = time.time()
    _TASKS[task_id] = {
        "task_id": task_id, "prompt_id": prompt_id, "status": "queued",
        "recipe": payload["recipe"], "seed": payload["seed"],
        "filename": None, "subfolder": None, "progress": None, "error": "",
        "created": now, "updated": now,
    }
    _WATCHERS[task_id] = asyncio.create_task(_watch(task_id))
    _prune_tasks()
    return web.json_response({"success": True, **_snapshot(_TASKS[task_id])})


@PromptServer.instance.routes.get("/neo_studio/director/{task_id}")
async def director_status_route(request):
    """整片任务快照：status（queued/running/succeeded/failed/cancelled）+ progress + filename + error。
    运行中附带 latest_preview（最新采样步帧载荷，前端轮询取预览帧的兜底通道）。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    snap = _snapshot(task)
    latest = get_latest_preview(task["task_id"])
    if latest is not None:
        snap["latest_preview"] = latest
    return web.json_response({"success": True, **snap})


@PromptServer.instance.routes.post("/neo_studio/director/{task_id}/cancel")
async def director_cancel_route(request):
    """取消整片任务：未执行则出队，执行中则中断（与单段/生图任务同一套做法）。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    queue = PromptServer.instance.prompt_queue
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == task["prompt_id"])
    interrupted = queue.interrupt_if_running(task["prompt_id"])
    if not dequeued and not interrupted:
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    return web.json_response({"success": True, "dequeued": dequeued, "interrupted": interrupted})


def _plugin_version() -> str:
    pyproject = Path(__file__).parent / "pyproject.toml"
    try:
        m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "unknown"


@PromptServer.instance.routes.get("/neo_studio/version")
async def studio_version_route(request):
    """插件与 ComfyUI 版本：Studio 首页展示，升级检查用。"""
    comfy_version = "unknown"
    try:
        import comfyui_version
        comfy_version = getattr(comfyui_version, "__version__", "unknown")
    except ImportError:
        pass
    return web.json_response({
        "success": True,
        "plugin": "ComfyUI-Neo-Nodes",
        "plugin_version": _plugin_version(),
        "comfyui_version": comfy_version,
        "recipes": list_director_recipes(),
    })

