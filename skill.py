# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Skills (目录式多文件 Markdown 技能)
"""
Skill = 一个目录，内含主文件 skill.md（大小写不敏感：SKILL.md / Skill.md 亦可；YAML frontmatter + 系统提示词正文）+ 可选的其它 *.md 与子目录中的 *.txt 引用文件。

存储布局：
    skills/
      presets/<skill_id>/   预设（随插件发布，只读、不可删）
      tasks/<skill_id>/     任务（内置 LLM 操作，供 llm.LLM_TASKS 使用）
      custom/<skill_id>/    用户自定义

约定：
- skill id = 目录名。
- 元数据只从 skill.md 的 YAML frontmatter 读取（name/tags/inputs/description/
  max_tokens/result_key/multi_result/category/markers/created_at）。
- 系统提示词 = 顶层所有 .md 按文件名升序拼接（子目录与 *.txt 引用文件不并入，
  由代理按需读取）；带 YAML frontmatter 的 .md（含主文件 skill.md，忽略大小写）
  去掉 frontmatter，其余正文原样保留。

本模块是叶子模块：不依赖 prompts / llm，仅依赖标准库 + PyYAML + aiohttp。
prompts.py 与 llm.py 作为消费者从这里导入。
"""

from __future__ import annotations

import os
import re
import io
import json
import shutil
import logging
import tempfile
import datetime
import threading
import zipfile

import yaml
from aiohttp import web
import server
from server import PromptServer

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILLS_DIR = os.path.join(CURRENT_DIR, "skills")
SKILL_PRESETS_DIR = os.path.join(SKILLS_DIR, "presets")
SKILL_CUSTOM_DIR = os.path.join(SKILLS_DIR, "custom")
TASKS_DIR = os.path.join(SKILLS_DIR, "tasks")

for _d in (SKILLS_DIR, SKILL_PRESETS_DIR, SKILL_CUSTOM_DIR, TASKS_DIR):
    if not os.path.exists(_d):
        os.makedirs(_d)

_skills_lock = threading.Lock()

# 仅内部使用的任务（实现细节），不对外展示为可选 skill
_SKILL_INTERNAL = {
    "template_prompt",
    "extract_title",
    "extract_classify",
}

# 内置使命级别的默认输入契约（skill.md 未声明 inputs 时使用）
_SKILL_DEFAULT_INPUTS = {
    "reverse_prompt": ["image", "text"],
    "smart_prompt": ["text"],
    "template_prompt": ["text"],
    "translate_prompt": ["text"],
    "extract_title": ["text"],
    "extract_classify": ["text"],
}

# 输入框 @ 标记 -> skill id 路由表（skill.md 未声明 markers 时的兜底）
_SKILL_MARKERS = {
    "reverse_prompt": ["@图", "@反推", "@图片"],
}

# frontmatter 序列化时的字段顺序（未列出的额外字段追加在末尾）
_META_KEY_ORDER = (
    "name", "tags", "inputs", "description", "max_tokens",
    "result_key", "multi_result", "category", "markers", "created_at",
)

# 技能文件管理器支持的文件扩展名（.md 主/子文档 + .txt 引用文本）。
# 注意：系统提示词拼接仍只取顶层 .md（见 load_skill_content），此集合仅用于文件管理。
_SKILL_FILE_EXTS = (".md", ".txt")


def _skill_category(skill_id: str, data: dict) -> str:
    """推断 skill 分类：vision（含图像输入）/ task（任务）/ style（模板）。"""
    if data.get("category"):
        return data["category"]
    if "image" in (data.get("inputs") or []):
        return "vision"
    return "task"


# ==========================================
# Frontmatter 解析 / 序列化
# ==========================================

def split_frontmatter(text: str) -> tuple[dict, str]:
    """把 skill.md 拆成 (metadata dict, body str)。frontmatter 是文件开头的 --- YAML 块。

    闭合分隔符通过 PyYAML 事件流（第一个 DocumentEndEvent）定位，而不是扫描
    字面量 ``---`` 行，这样多行 YAML 值里即使含有 ``---`` 也能正确解析。
    body 按原始 Markdown 返回，从不按 YAML 解析。
    """
    if text.startswith("\ufeff"):
        text = text[1:]
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    end_line = None
    for event in yaml.parse(text, Loader=yaml.SafeLoader):
        if isinstance(event, yaml.DocumentEndEvent):
            end_line = event.end_mark.line
            break
    if end_line is None or end_line < 1:
        return {}, text
    fm_text = "\n".join(lines[1:end_line])
    try:
        meta = yaml.safe_load(fm_text)
    except Exception:
        logger.warning(f"Invalid YAML frontmatter:\n{fm_text[:200]}")
        return {}, text
    if not isinstance(meta, dict):
        meta = {}
    body = "\n".join(lines[end_line + 1:]).lstrip("\n")
    return meta, body


def serialize_frontmatter(meta: dict, body: str) -> str:
    """把 metadata + 正文拼回 skill.md 文本。"""
    ordered = {}
    for key in _META_KEY_ORDER:
        if meta.get(key) is not None:
            ordered[key] = meta[key]
    for k, v in meta.items():
        if k not in ordered and v is not None:
            ordered[k] = v
    fm = yaml.safe_dump(ordered, allow_unicode=True, default_flow_style=False, sort_keys=False)
    return f"---\n{fm}---\n\n{body}"


# ==========================================
# 目录 / 内容读取
# ==========================================

def _skill_dir(skill_id: str) -> str | None:
    """返回 skill id 对应的目录（custom > presets > tasks），不存在则 None。"""
    if not skill_id:
        return None
    for base in (SKILL_CUSTOM_DIR, SKILL_PRESETS_DIR, TASKS_DIR):
        d = os.path.join(base, skill_id)
        if os.path.isdir(d):
            return d
    return None


def _skill_source(skill_dir: str) -> str:
    """skill 目录所在分组名（presets/custom/tasks）。"""
    return os.path.basename(os.path.dirname(skill_dir))


def _main_md_name(skill_dir: str) -> str | None:
    """主文件（skill.md，忽略大小写）在目录内的实际文件名；无则 None。

    兼容 SKILL.md / Skill.md 等写法（Agent Skills 常用大写），并在大小写敏感
    的文件系统上也能正确定位到真实文件名。
    """
    try:
        names = [fn for fn in os.listdir(skill_dir)
                 if fn.lower() == "skill.md" and os.path.isfile(os.path.join(skill_dir, fn))]
    except OSError:
        return None
    return sorted(names)[0] if names else None


def _read_skill_md(skill_dir: str) -> tuple[dict, str]:
    main = _main_md_name(skill_dir)
    if not main:
        return {}, ""
    path = os.path.join(skill_dir, main)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
    except Exception as e:
        logger.warning(f"Error reading {main} in {skill_dir}: {e}")
        return {}, ""
    return split_frontmatter(text)


def _list_skill_files(skill_dir: str) -> list[str]:
    """顶层所有 .md 文件名（升序）。仅用于系统提示词拼接（load_skill_content）。"""
    files = []
    for fn in sorted(os.listdir(skill_dir)):
        if fn.lower().endswith(".md") and os.path.isfile(os.path.join(skill_dir, fn)):
            files.append(fn)
    return files


def _list_all_skill_files(skill_dir: str) -> list[str]:
    """递归列出 skill 目录内所有受支持文件（.md/.txt）的相对路径（/ 分隔）。

    顶层文件在前、其余按路径升序，供前端技能文件管理器展示与编辑。"""
    found = []
    for dirpath, _dirnames, filenames in os.walk(skill_dir):
        for fn in filenames:
            if not fn.lower().endswith(_SKILL_FILE_EXTS):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), skill_dir).replace(os.sep, "/")
            found.append(rel)
    found.sort(key=lambda r: (0 if "/" not in r else 1, r.lower()))
    return found


def load_skill_content(skill_id: str) -> str | None:
    """拼接 skill 目录顶层所有 .md（升序）为系统提示词；带 YAML frontmatter 的
    .md（含主文件 skill.md，忽略大小写）去掉 frontmatter，其余正文原样保留。
    （子目录与 .txt 引用文件不并入提示词，由代理按需读取。）"""
    d = _skill_dir(skill_id)
    if not d:
        return None
    parts = []
    for fn in _list_skill_files(d):
        fp = os.path.join(d, fn)
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                text = f.read()
        except Exception as e:
            logger.warning(f"Error reading {fp}: {e}")
            continue
        if fn.lower() == "skill.md":
            _, body = split_frontmatter(text)
        else:
            meta, stripped = split_frontmatter(text)
            body = stripped if isinstance(meta, dict) and meta else text
        if body.strip():
            parts.append(body.rstrip("\n"))
    content = "\n\n".join(parts)
    return content or None


def _skill_meta(skill_id: str) -> dict:
    d = _skill_dir(skill_id)
    if not d:
        return {}
    meta, _ = _read_skill_md(d)
    return meta


def load_skill_max_tokens(skill_id: str):
    """加载 skill 声明的 max_tokens 覆盖（未声明则 None）。"""
    val = _skill_meta(skill_id).get("max_tokens")
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def load_skill_multi_result(skill_id: str):
    """加载 skill 的 multi_result 输出契约（未声明则 None）。"""
    meta = _skill_meta(skill_id)
    return meta.get("multi_result") if meta else None


def load_task_template(task_name: str) -> dict:
    """读取任务 skill（tasks/<task_name>/skill.md）为 llm.LLM_TASKS 条目。"""
    d = os.path.join(TASKS_DIR, task_name)
    if not os.path.isdir(d):
        return {}
    meta, body = _read_skill_md(d)
    return {
        "content": body,
        "max_tokens": meta.get("max_tokens", 500),
        "result_key": meta.get("result_key", "prompt"),
        "description": meta.get("description", ""),
        "multi_result": meta.get("multi_result"),
    }


def scan_skills() -> list:
    """合并 tasks + presets/custom 为统一 skill 元数据列表。

    每个 skill 返回: {id, name, category, source, inputs, needs_image, markers, tags, description}
    """
    skills = []

    # 1) 任务 (tasks/<id>/) -> category=task/vision
    if os.path.isdir(TASKS_DIR):
        for entry in sorted(os.listdir(TASKS_DIR)):
            d = os.path.join(TASKS_DIR, entry)
            if not os.path.isdir(d):
                continue
            skill_id = entry
            if skill_id in _SKILL_INTERNAL:
                continue
            meta, _ = _read_skill_md(d)
            inputs = meta.get("inputs") or _SKILL_DEFAULT_INPUTS.get(skill_id, ["text"])
            skills.append({
                "id": skill_id,
                "name": meta.get("name", skill_id),
                "category": _skill_category(skill_id, {**meta, "inputs": inputs}),
                "source": "tasks",
                "tags": meta.get("tags", []),
                "inputs": inputs,
                "needs_image": "image" in inputs,
                "markers": meta.get("markers") or _SKILL_MARKERS.get(skill_id, []),
                "description": meta.get("description", ""),
            })

    # 2) 预设 + 自定义 (presets/<id>/, custom/<id>/) -> category=style
    with _skills_lock:
        for base, source in ((SKILL_PRESETS_DIR, "presets"), (SKILL_CUSTOM_DIR, "custom")):
            if not os.path.isdir(base):
                continue
            for entry in sorted(os.listdir(base)):
                d = os.path.join(base, entry)
                if not os.path.isdir(d):
                    continue
                skill_id = entry
                meta, _ = _read_skill_md(d)
                inputs = meta.get("inputs") or ["text"]
                skills.append({
                    "id": skill_id,
                    "name": meta.get("name", skill_id),
                    "category": meta.get("category", "style"),
                    "source": source,
                    "tags": meta.get("tags", []),
                    "inputs": inputs,
                    "needs_image": "image" in inputs,
                    "markers": meta.get("markers") or [],
                    "description": meta.get("description", ""),
                })

    return skills


# ==========================================
# 文件管理 / 保存（含路径安全校验）
# ==========================================

def _normalize_skill_id(raw: str) -> str:
    """规范化 skill id：目录名，仅保留 [A-Za-z0-9_-]。"""
    raw = (raw or "").strip()
    raw = raw.replace("\\", "/").split("/")[-1]
    return re.sub(r'[^A-Za-z0-9_-]', '', raw)


def _safe_skill_file_path(skill_dir: str, filename: str) -> str | None:
    """校验并返回 skill 目录内受支持文件（.md/.txt，可含子目录）的绝对路径；
    非法/越界/非受支持类型返回 None。"""
    fn = (filename or "").replace("\\", "/").strip()
    if not fn or fn.startswith("/"):
        return None
    parts = [p for p in fn.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    if not parts[-1].lower().endswith(_SKILL_FILE_EXTS):
        return None
    target = os.path.realpath(os.path.join(skill_dir, *parts))
    base = os.path.realpath(skill_dir)
    if os.path.commonpath([target, base]) != base:
        return None
    return target


def save_skill_main(skill_id: str, name: str, content: str, tags=None, source: str = "custom") -> bool:
    """保存 skill 的主文件 skill.md（frontmatter + 正文），保留未编辑的既有字段。"""
    sid = _normalize_skill_id(skill_id)
    if not sid:
        return False
    base = SKILL_PRESETS_DIR if source == "presets" else SKILL_CUSTOM_DIR
    d = os.path.join(base, sid)
    with _skills_lock:
        os.makedirs(d, exist_ok=True)
        meta, _body = _read_skill_md(d)
        new_meta = {
            "name": (name or "").strip() or sid,
            "tags": list(tags or []),
            "description": meta.get("description", ""),
            "inputs": meta.get("inputs"),
            "max_tokens": meta.get("max_tokens"),
            "result_key": meta.get("result_key"),
            "multi_result": meta.get("multi_result"),
            "category": meta.get("category"),
            "markers": meta.get("markers"),
            "created_at": meta.get("created_at") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        new_meta = {k: v for k, v in new_meta.items() if v is not None}
        text = serialize_frontmatter(new_meta, content or "")
        main = _main_md_name(d) or "skill.md"
        with open(os.path.join(d, main), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    return True


def save_skill_file(skill_id: str, filename: str, content: str) -> bool:
    """保存 skill 目录内的某个 .md 文件。"""
    d = _skill_dir(skill_id)
    if not d:
        return False
    target = _safe_skill_file_path(d, filename)
    if not target:
        return False
    with _skills_lock:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'w', encoding='utf-8', newline='\n') as f:
                f.write(content or "")
        except Exception as e:
            logger.error(f"Error saving skill file {target}: {e}")
            return False
    return True


def delete_skill_file(skill_id: str, filename: str) -> bool:
    """删除 skill 目录内某个 .md 文件（不允许删 skill.md）。"""
    d = _skill_dir(skill_id)
    if not d:
        return False
    fn = (filename or "").replace("\\", "/")
    if fn.lower() == "skill.md":
        return False
    target = _safe_skill_file_path(d, fn)
    if not target or not os.path.isfile(target):
        return False
    with _skills_lock:
        os.remove(target)
    return True


def delete_skill(skill_id: str) -> tuple[bool, str]:
    """删除整个 skill 目录。预设不可删。返回 (success, message)。"""
    sid = _normalize_skill_id(skill_id)
    if not sid:
        return False, "Invalid skill id"
    with _skills_lock:
        for base in (SKILL_CUSTOM_DIR, SKILL_PRESETS_DIR):
            d = os.path.join(base, sid)
            if os.path.isdir(d):
                if os.path.basename(base) == "presets":
                    return False, "Cannot delete preset skill"
                shutil.rmtree(d)
                return True, "deleted"
    return False, "Skill not found"


# ==========================================
# 上传（zip / 目录清单）
# ==========================================

def _write_skill_files(target_dir: str, rel_paths: list[str], blobs: list[bytes]) -> bool:
    """把 (相对路径, 内容) 写入 target_dir，仅保留受支持文件（.md/.txt）并校验安全；缺 skill.md 时自动创建。"""
    os.makedirs(target_dir, exist_ok=True)
    base = os.path.realpath(target_dir)
    wrote_skill_md = False
    for rel, blob in zip(rel_paths, blobs):
        parts = [p for p in (rel or "").replace("\\", "/").split("/") if p not in ("", ".")]
        if not parts or any(p == ".." for p in parts):
            logger.warning(f"Reject unsafe skill file path: {rel}")
            continue
        if not parts[-1].lower().endswith(_SKILL_FILE_EXTS):
            continue
        target = os.path.realpath(os.path.join(base, *parts))
        if os.path.commonpath([target, base]) != base:
            logger.warning(f"Reject out-of-bounds skill file path: {rel}")
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(blob or b"")
        if parts[-1].lower() == "skill.md":
            wrote_skill_md = True
    if not wrote_skill_md:
        # 自动创建 skill.md（带最小 frontmatter），保证目录是合法 skill
        with open(os.path.join(base, "skill.md"), 'w', encoding='utf-8', newline='\n') as f:
            f.write(serialize_frontmatter({"name": os.path.basename(base)}, ""))
    return True


def _collect_skill_files(root: str) -> tuple[list[str], list[bytes]]:
    """收集 root 下所有受支持文件（.md/.txt）的 (相对路径, 字节)。"""
    rel_paths = []
    blobs = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in sorted(filenames):
            if not fn.lower().endswith(_SKILL_FILE_EXTS):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            with open(full, "rb") as f:
                blobs.append(f.read())
            rel_paths.append(rel)
    return rel_paths, blobs


def _upload_from_zip(zip_bytes: bytes, skill_id_field: str) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="skill_zip_")
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                parts = [p for p in name.split("/") if p not in ("", ".")]
                if os.path.isabs(name) or any(p == ".." for p in parts):
                    return {"success": False, "status": 400, "message": f"Unsafe path in zip: {name}"}
            zf.extractall(tmpdir)

        entries = [e for e in os.listdir(tmpdir) if not e.startswith("__MACOSX") and not e.startswith(".")]
        root = tmpdir
        wrapper_id = ""
        if len(entries) == 1 and os.path.isdir(os.path.join(tmpdir, entries[0])):
            root = os.path.join(tmpdir, entries[0])
            wrapper_id = entries[0]

        sid = _normalize_skill_id(skill_id_field or wrapper_id)
        if not sid:
            return {"success": False, "status": 400, "message": "skill_id required (no wrapper folder in zip)"}

        rel_paths, blobs = _collect_skill_files(root)
        _write_skill_files(os.path.join(SKILL_CUSTOM_DIR, sid), rel_paths, blobs)
        return {"success": True, "id": sid}
    except Exception as e:
        logger.error(f"Error extracting skill zip: {e}")
        return {"success": False, "status": 500, "message": str(e)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _upload_from_manifest(rel_paths: list[str], file_parts: list[tuple[str, bytes]], skill_id_field: str) -> dict:
    if not rel_paths:
        return {"success": False, "status": 400, "message": "Empty manifest"}
    norm = [p.replace("\\", "/") for p in rel_paths]
    # 若所有路径共享同一顶层目录，视为选中的 skill 根文件夹（webkitRelativePath 首段）
    tops = {n.split("/", 1)[0] for n in norm if "/" in n}
    strip_top = len(tops) == 1 and all("/" in n for n in norm)
    inner = [n.split("/", 1)[1] if strip_top else n for n in norm]
    sid = _normalize_skill_id(skill_id_field or (list(tops)[0] if strip_top else ""))
    if not sid:
        return {"success": False, "status": 400, "message": "skill_id required"}

    paths = []
    blobs = []
    for rel, (_fname, blob) in zip(inner, file_parts):
        if rel.lower().endswith(_SKILL_FILE_EXTS):
            paths.append(rel)
            blobs.append(blob)
    _write_skill_files(os.path.join(SKILL_CUSTOM_DIR, sid), paths, blobs)
    return {"success": True, "id": sid}


# ==========================================
# API Routes (skill 管理)
# ==========================================

@server.PromptServer.instance.routes.get("/rs_prompts/skills")
async def rs_prompts_list_skills(request):
    """列出所有 skill（任务 + 预设/自定义统一元数据）。"""
    try:
        return web.json_response(scan_skills())
    except Exception as e:
        logger.error(f"Error listing skills: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/load_skill")
async def rs_prompts_load_skill(request):
    """加载单个 skill 完整数据（元数据 + 拼接内容 + 文件列表）。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        d = _skill_dir(skill_id) if skill_id else None
        if not d:
            return web.Response(status=404, text="Skill not found")
        meta, _ = _read_skill_md(d)
        files = []
        for fn in _list_all_skill_files(d):
            fp = os.path.join(d, fn)
            files.append({"name": fn, "size": os.path.getsize(fp)})
        return web.json_response({
            "id": skill_id,
            "name": meta.get("name", skill_id),
            "source": _skill_source(d),
            "tags": meta.get("tags", []),
            "description": meta.get("description", ""),
            "inputs": meta.get("inputs") or ["text"],
            "category": meta.get("category", "style"),
            "content": load_skill_content(skill_id) or "",
            "files": files,
            "max_tokens": meta.get("max_tokens"),
            "multi_result": meta.get("multi_result"),
            "result_key": meta.get("result_key"),
        })
    except Exception as e:
        logger.error(f"Error loading skill: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/save_skill")
async def rs_prompts_save_skill(request):
    """保存/更新 skill 主文件（skill.md）。预设只读。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        if not skill_id:
            return web.Response(status=400, text="Skill id required")
        source = data.get("source", "custom")
        existing_dir = _skill_dir(skill_id)
        if existing_dir and _skill_source(existing_dir) == "presets" and source != "presets":
            return web.Response(status=403, text="Cannot modify preset skill")
        ok = save_skill_main(
            skill_id,
            data.get("name", ""),
            data.get("content", ""),
            data.get("tags", []),
            source,
        )
        if not ok:
            return web.Response(status=500, text="Failed to save skill")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error saving skill: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/delete_skill")
async def rs_prompts_delete_skill(request):
    """删除整个 skill 目录（预设不可删）。"""
    try:
        data = await request.json()
        ok, msg = delete_skill(_normalize_skill_id(data.get("id", "")))
        if not ok and "preset" in msg.lower():
            return web.Response(status=403, text=msg)
        if not ok:
            return web.Response(status=404, text=msg)
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error deleting skill: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/upload_skill")
async def rs_prompts_upload_skill(request):
    """上传 skill：.zip（file 字段）或目录清单（manifest + 有序 files 字段）。"""
    try:
        reader = await request.multipart()
        skill_id_field = ""
        manifest_raw = None
        zip_bytes = None
        file_parts = []
        async for part in reader:
            if part.name == "skill_id":
                skill_id_field = (await part.read()).decode("utf-8").strip()
            elif part.name == "manifest":
                manifest_raw = (await part.read()).decode("utf-8")
            elif part.name == "file" and part.filename:
                zip_bytes = await part.read()
            elif part.name == "files":
                file_parts.append((part.filename, await part.read()))

        with _skills_lock:
            if zip_bytes is not None:
                result = _upload_from_zip(zip_bytes, skill_id_field)
            elif manifest_raw is not None:
                try:
                    rel_paths = json.loads(manifest_raw)
                except Exception:
                    return web.Response(status=400, text="Invalid manifest JSON")
                result = _upload_from_manifest(rel_paths, file_parts, skill_id_field)
            else:
                return web.Response(status=400, text="No upload payload")

        if not result.get("success"):
            status = result.get("status", 500)
            return web.Response(status=status, text=result.get("message", "Upload failed"))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"Error uploading skill: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/load_skill_file")
async def rs_prompts_load_skill_file(request):
    """加载 skill 目录内某个 .md 文件内容。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        filename = data.get("file", "")
        d = _skill_dir(skill_id) if skill_id else None
        if not d:
            return web.Response(status=404, text="Skill not found")
        target = _safe_skill_file_path(d, filename)
        if not target or not os.path.isfile(target):
            return web.Response(status=404, text="File not found")
        with open(target, 'r', encoding='utf-8') as f:
            content = f.read()
        return web.json_response({"name": filename, "content": content})
    except Exception as e:
        logger.error(f"Error loading skill file: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/save_skill_file")
async def rs_prompts_save_skill_file(request):
    """保存 skill 目录内某个 .md 文件。"""
    try:
        data = await request.json()
        ok = save_skill_file(
            _normalize_skill_id(data.get("id", "")),
            data.get("file", ""),
            data.get("content", ""),
        )
        if not ok:
            return web.Response(status=400, text="Failed to save skill file")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error saving skill file: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/delete_skill_file")
async def rs_prompts_delete_skill_file(request):
    """删除 skill 目录内某个 .md 文件（skill.md 不可删）。"""
    try:
        data = await request.json()
        ok = delete_skill_file(
            _normalize_skill_id(data.get("id", "")),
            data.get("file", ""),
        )
        if not ok:
            return web.Response(status=400, text="Failed to delete skill file")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error deleting skill file: {e}")
        return web.Response(status=500, text=str(e))