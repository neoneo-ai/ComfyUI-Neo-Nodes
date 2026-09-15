"""Neo H3 Video Director：以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；也可接 NeoPromptAgent 的 BUNDLE 按单段生成。

设计（复用单段 H3 路径）：
- NeoH3VideoDirector 从配方读取 {shared, segments[]}；每段带自己的 skill_id、prompt、时长、首帧参考。
- 逐段复用单段解析/执行链 _run_segment_graph（resolve_video_params + render_template + execute_graph_inprocess）。
- BUNDLE 输入（forceInput）：提供时忽略 recipe，用 bundle 的 skill/提示词/参考图（data URI）跑单个片段。
- Tier A 连续性：上一段尾帧作为下一段 I2V 首帧；丢下段第一帧避免边界重复，并按丢帧数裁音频保 A/V 对齐。
- seed 派生：base_seed + i（i 为段序号），保证可复现且各段不同。
"""

import torch
from fractions import Fraction

import nodes as comfy_nodes
from aiohttp import web
from comfy_api.latest import InputImpl, Types
from server import PromptServer

from .bundles import get_bundle
from .image_gen import render_template
from .krea2_generate import _image_to_data_uri, _model_injection_node, execute_graph_inprocess
from .h3_video_gen import H3_FPS, _gen_video_skills, _resolve_skill_id, _require_vdn_plugin, _seconds_to_frames, resolve_video_params
from .h3_preview import load_h3_tiny_vae, preview_override
from .skill import get_skill_gen_config, load_skill_workflow
from .recipes import list_director_recipes, load_director_spec

# 当前 director 运行进度（进程内单例）。ComfyUI 串行执行 prompt，同一时刻只有一个活动 director。
# segment_index：正在生成的段序号（-1 = 尚未开始/已结束）；total_segments：总段数。
_DIRECTOR_PROGRESS = {"active": False, "segment_index": -1, "total_segments": 0}


def get_director_progress() -> dict:
    return dict(_DIRECTOR_PROGRESS)


@PromptServer.instance.routes.get("/neo_video_gen/director_progress")
async def neo_video_gen_director_progress(request):
    """返回当前 director 运行进度，供节点内时间轴实时显示各段生成状态。"""
    return web.json_response(get_director_progress())


def _concat_segment_audio(audios, frame_rate: int, drops):
    """把各段 AudioInput 拼成一条；每个接缝按 drops[i]（0/1）决定是否裁掉对应采样。

    audios 为每段的 comp.audio（AudioInput {waveform:[B,C,T], sample_rate} 或 None），顺序对应各段。
    drops 与 segments 对齐：drops[i]=1 表示第 i 段被连续性链入、首帧已丢弃，需同步裁掉等量采样保 A/V 对齐。
    返回合并后的 AudioInput；全部无音频时返回 None。
    """
    present = [a for a in audios if a is not None]
    if not present:
        return None
    sample_rate = int(present[0].get("sample_rate") or 1)
    per_frame = max(0, int(round(sample_rate / frame_rate)))   # 每帧对应的采样数
    parts = []
    for i, a in enumerate(audios):
        if a is None:
            continue
        w = a["waveform"]
        d = drops[i] if i < len(drops) else 0
        if i > 0 and d > 0 and per_frame > 0:
            w = w[..., per_frame * d:]
        parts.append(w)
    if not parts:
        return None
    return {"waveform": torch.cat(parts, dim=-1), "sample_rate": sample_rate}


def _run_segment_graph(body, skill_id, model, steps, label="", vae=None, preview=True):
    """单段执行链：解析参数 → 渲染模板 → 模型注入/VDN 校验 → 进程内执行，返回 VIDEO。

    recipe 逐段与 BUNDLE 单段共用；label 仅用于错误消息前缀（如「第 3 段：」）。
    vae/preview 控制采样期间节点内的实时预览（见 h3_preview）。
    """
    real_id = _resolve_skill_id(skill_id or "")
    template = load_skill_workflow(real_id)
    if template is None:
        raise RuntimeError(f"{label}skill '{skill_id}' 缺少 workflow.json，无法生成")
    cfg = get_skill_gen_config(real_id)
    params = resolve_video_params(body, cfg, skip_model=(model is not None))
    if steps is not None and int(steps) > 0:
        params["steps"] = int(steps)
    graph, _warns = render_template(template, params)
    overrides = None
    if model is not None:
        x_id, pruned = _model_injection_node(graph)
        if x_id is None:
            raise RuntimeError(f"{label}无法定位模型注入点（缺少 KSampler/SigmaShift 的 model 输入）")
        for pid in pruned:
            del graph[pid]
        overrides = {x_id: [model]}
    else:
        _require_vdn_plugin(graph)
    with preview_override(preview, vae):
        return execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)


class NeoH3VideoDirector:
    """以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；连 NeoPromptAgent 的 BUNDLE 时按单片段生成（忽略配方）。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = list_director_recipes()
        return {
            "required": {
                "recipe": (names, {"default": names[0] if names else ""}),
            },
            "optional": {
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**63 - 1}),   # -1 = 用配方 shared.seed
                "width": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用各段 skill config（选中配方时前端自动填首段默认）
                "height": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用各段 skill config（选中配方时前端自动填首段默认）
                "continuity": ("BOOLEAN", {"default": True}),   # Tier A：上段尾帧→下段首帧 + 丢边界帧
                "model": ("MODEL",),  # 外部加速模型；提供时覆盖每段内部主模型链（UNETLoader/LoRA/VDN）
                "steps": ("INT", {"default": -1, "min": -1, "max": 100}),  # -1 = 用 preset/config 值
                "preview": ("BOOLEAN", {"default": True}),   # 节点内实时预览：开 = taeh3 真彩（≤1024），关 = 完全不出
                "bundle": ("STRING", {"forceInput": True}),   # NeoPromptAgent BUNDLE；提供时忽略 recipe，按单段生成
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "多段视频导演：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO。"

    def _run_bundle_segment(self, payload, seed, width, height, model, steps, vae=None, preview=True):
        """BUNDLE 单段生成：skill/提示词/参考都来自 NeoPromptAgent 的 BUNDLE（data URI），忽略 recipe。"""
        sid = payload.get("skill_id") or ""
        if not any(s["id"] == _resolve_skill_id(sid) for s in _gen_video_skills()):
            raise ValueError(f"BUNDLE 指定的视频 skill 无效：'{sid}'（需为含 workflow.json 的视频技能）")
        prompts = payload.get("prompts") or []
        prompt = str(prompts[0]).strip() if prompts else ""
        if not prompt:
            raise ValueError("BUNDLE 缺少提示词，无法生成视频")
        body = {"prompt": prompt}
        if int(seed) >= 0:
            body["seed"] = int(seed)
        in_w = int(width) if int(width) > 0 else 0
        in_h = int(height) if int(height) > 0 else 0
        if in_w > 0:
            body["width"] = in_w
        if in_h > 0:
            body["height"] = in_h
        refs = payload.get("references") or []
        if refs:
            body["references"] = list(refs)
        video = _run_segment_graph(body, sid, model, steps, vae=vae, preview=preview)
        comp = video.get_components()
        return (InputImpl.VideoFromComponents(
            Types.VideoComponents(images=comp.images, audio=comp.audio, frame_rate=Fraction(H3_FPS))
        ),)

    def generate(self, recipe, seed=-1, width=-1, height=-1, continuity=True, model=None, steps=-1, bundle="", preview=True):
        vae = load_h3_tiny_vae() if preview else None   # 预览解码器：一次生成内复用；关闭时不加载
        payload = get_bundle(bundle) if bundle else None
        if payload:
            return self._run_bundle_segment(payload, seed, width, height, model, steps, vae, preview)
        spec = load_director_spec(recipe)
        shared = spec.get("shared") or {}
        segments = spec.get("segments") or []
        if not segments:
            raise ValueError(f"配方 '{recipe}' 没有可执行的段")

        base_seed = int(seed) if int(seed) >= 0 else (int(shared.get("seed", 0)) if shared.get("seed") is not None else 0)
        # width/height：节点入参 > 0 时覆盖全部段；-1 时不写入 body，交由 resolve_video_params 按各段 skill config 默认回退。
        in_w = int(width) if int(width) > 0 else 0
        in_h = int(height) if int(height) > 0 else 0

        _DIRECTOR_PROGRESS.update(active=True, segment_index=-1, total_segments=len(segments))
        all_frames = []
        all_audio = []
        drops = []       # 与 segments 对齐：1 = 该段被连续性链入（丢首帧 + 对应音频）
        prev_tail = None
        try:
            for i, seg in enumerate(segments):
                _DIRECTOR_PROGRESS["segment_index"] = i
                body = {
                    "prompt": seg.get("prompt", ""),
                    "seed": (base_seed + i) % (2**63),
                }
                if in_w > 0:
                    body["width"] = in_w
                if in_h > 0:
                    body["height"] = in_h
                dur = seg.get("duration_sec")
                if dur is not None and float(dur) > 0:
                    body["length"] = _seconds_to_frames(float(dur))

                # 按段模式组装参考（T2V 段不带任何参考）：
                #   i2v/fl2v 首帧（continuity 时链入上段尾帧）+ 该段挂的参考素材
                #   r2v 仅参考素材（图/视频/音频）  fl2v 另带尾帧锁收尾
                mode = seg.get("mode") or "t2v"
                refs = []
                chained = False
                if mode in ("i2v", "fl2v"):
                    primary_input = None
                    if continuity and i > 0 and prev_tail is not None:
                        refs.append({"kind": "data", "data": _image_to_data_uri(prev_tail)})
                        chained = True
                    elif seg.get("ref_input"):
                        primary_input = seg["ref_input"]
                        refs.append({"kind": "input", "value": primary_input})
                elif mode == "r2v":
                    primary_input = None
                if mode in ("i2v", "fl2v", "r2v"):
                    seg_refs = seg.get("refs") or {}
                    for name in (seg_refs.get("images") or []):
                        if name != primary_input:
                            refs.append({"kind": "input", "value": name})
                    for name in (seg_refs.get("videos") or []):
                        refs.append({"kind": "input", "value": name, "media": "video"})
                    for name in (seg_refs.get("audios") or []):
                        refs.append({"kind": "input", "value": name, "media": "audio"})
                if refs:
                    body["references"] = refs
                if mode == "fl2v":
                    if not seg.get("last_input"):
                        raise ValueError(f"第 {i + 1} 段为首尾帧生视频但缺少尾帧：请为该段设置尾帧图")
                    body["last_frame"] = {"kind": "input", "value": seg["last_input"]}
                if mode in ("i2v", "fl2v") and not refs:
                    raise ValueError(
                        f"第 {i + 1} 段为{'首尾帧' if mode == 'fl2v' else '图生视频'}但没有可用首帧：" +
                        ("请为该段设置首帧，或开启「连续性」以上段尾帧链入"
                         if i > 0 else "首段需自带首帧"))
                if mode == "r2v" and not refs:
                    raise ValueError(f"第 {i + 1} 段为全参考生视频但没有参考素材：请挂参考图 / 视频 / 音频")

                video = _run_segment_graph(body, seg.get("skill_id") or "", model, steps, f"第 {i + 1} 段：", vae, preview)
                comp = video.get_components()
                frames = comp.images

                if i == 0:
                    all_frames.append(frames)
                elif chained and frames.shape[0] > 1:
                    all_frames.append(frames[1:])   # 丢与上段重复的边界帧
                else:
                    all_frames.append(frames)
                drops.append(1 if (i > 0 and chained) else 0)
                all_audio.append(comp.audio)
                prev_tail = frames[-1:]

            final_frames = torch.cat(all_frames, dim=0)
            final_audio = _concat_segment_audio(all_audio, H3_FPS, drops)
            return (InputImpl.VideoFromComponents(
                Types.VideoComponents(images=final_frames, audio=final_audio, frame_rate=Fraction(H3_FPS))
            ),)
        finally:
            _DIRECTOR_PROGRESS.update(active=False, segment_index=-1, total_segments=0)


NODE_CLASS_MAPPINGS = {"NeoH3VideoDirector": NeoH3VideoDirector}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3VideoDirector": "Neo H3 Video Director"}