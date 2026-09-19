"""Neo H3 Video Director：以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；也可接 NeoPromptAgent 的 BUNDLE 按单段生成。

设计（复用单段 H3 路径）：
- NeoH3VideoDirector 从配方读取 {shared, segments[]}；每段带自己的 skill_id、prompt、时长、首帧参考。
- 逐段复用单段解析/执行链 _run_segment_graph（resolve_video_params + render_template + execute_graph_inprocess）。
- BUNDLE 输入（forceInput）：提供时忽略 recipe，用 bundle 的 skill/提示词/参考图（data URI）跑单个片段。
- 跨段上下文窗口（主路径）：上段尾部 window 帧作为本段开头的视频参考注入（NeoH3AddContext），本段重生成
  这 window 帧后丢掉头部 window 帧——接缝不再重复边界帧，且新段带着上段的真实像素开场。
- 身份继承：首段（第一个带参考素材的段）的身份参考图领养到后续段，同走 NeoH3AddContext 的图片参考块。
- Tier A 回退（context_frames=0）：上段尾帧作为下段 i2v/fl2v 首帧；丢下段第一帧避免边界重复。
  两种情况都按丢帧数裁音频保 A/V 对齐。
- seed 派生：base_seed + i（i 为段序号），保证可复现且各段不同。
"""

import math

import torch
from fractions import Fraction

import comfy.utils
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
# step / total_steps：当前段已完成的采样步数 / 总步数（前端据此渲染段内进度条）。
_DIRECTOR_PROGRESS = {"active": False, "segment_index": -1, "total_segments": 0, "step": 0, "total_steps": 0}


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


# H3 的一次模型调用会同时用到两类条件行：keyframe 锚点（PackedLayout 的 cond 行）与 minimax_refs
# （ref 行）。core 在两者并存时会用 refs 的 latent 覆盖 keyframe 的 cond_video_latents
# （comfy/model_base.py），锚点因此被丢掉；PackedLayout 又把 cond/ref 行的 t 一律从 text_len 起算，
# 而目标视频的 t 原点在所有 ref 之后。这两件事都在模型调用前一次性修掉，做法与 H3-Continuum 相同：
# 在 ModelPatcher 上挂一个带命名空间的 APPLY_MODEL wrapper（不改 core、不与其它插件的 extra_conds
# 补丁抢所有权，重复安装只保留一份）。
_CONTINUITY_WRAPPER_KEY = "neo_h3_continuity.apply_model.v1"
_CONTEXT_FRAMES_MARK = "neo_context_frames"       # 上下文窗口 ref 上标记占多少帧（对齐时间轴时据此定位）
_CONTEXT_ALIGNED_ATTR = "_neo_h3_context_aligned"  # 同一 layout 只对齐一次（拷贝本身也是幂等的）


def _merge_cond_latents(payload):
    """把 keyframe 锚点与 refs 的 cond latent 合回一条列表（顺序与 PackedLayout 的 row 布局一致）。"""
    keyframes = payload.get("keyframes") or []
    refs = payload.get("refs") or []
    payload["cond_video_latents"] = (
        [kf["latent"] for kf in keyframes if kf.get("latent") is not None]
        + [r["latent"] for r in refs if r.get("latent") is not None])
    payload["cond_audio_latents"] = (
        [kf["audio_latent"] for kf in keyframes if kf.get("audio_latent") is not None]
        + [r["audio_latent"] for r in refs if r.get("audio_latent") is not None])


def _ref_row_ranges(layout, refs):
    """把 refs 逐个映射到布局里的 ref_img / ref_audio 行区间（消费顺序与 PackedLayout 构建顺序一致）。"""
    avail = [(int(a), int(b)) for a, b, kind in layout.segments if kind in ("ref_img", "ref_audio")]
    cursor = 0

    def take():
        nonlocal cursor
        if cursor >= len(avail):
            raise RuntimeError("[NeoNodes] H3 布局的参考行少于 minimax_refs，无法对齐跨段上下文窗口")
        row_range = avail[cursor]
        cursor += 1
        return row_range

    rows = []
    for ref in refs:
        kind = ref.get("kind")
        with_audio = int(ref.get("ref_audio_t") or 0) > 0
        if kind == "image":
            rows.append({"video": take(), "audio": None})
        elif kind == "audio":
            rows.append({"video": None, "audio": take() if with_audio else None})
        elif kind in ("video", "video_audio"):
            audio = take() if with_audio else None
            rows.append({"video": take(), "audio": audio})
        else:
            raise RuntimeError(f"[NeoNodes] 未知的 H3 参考类型：{kind!r}")
    return rows


def _align_payload_timeline(payload):
    """把锚点行与上下文窗口行的时间坐标对齐到目标视频时间轴（就地改 PackedLayout.position_ids）。

    keyframe 锚点是「目标第 N 帧」的锚点，本应与目标同处一条时间轴；上下文窗口则要回到目标视频开头，
    因为本段会重生成上段尾部的那些帧。这里保持 position_ids 张量本体不变（Sol-Attn 的 span 注册认它），
    只改坐标：锚点整体平移 refs 的总推进量，上下文行直接复用目标开头的行（H3-Continuum 的共时对齐同法）。
    """
    layout = payload.get("layout")
    if layout is None or getattr(layout, _CONTEXT_ALIGNED_ATTR, False):
        return
    refs = payload.get("refs") or []
    targets = [(int(a), int(b)) for a, b, kind in layout.segments if kind == "video"]
    if not targets:
        return
    video_start, video_stop = targets[-1]
    target_t = int(layout.signature[1])
    frame_rows = max(1, (video_stop - video_start) // target_t)
    position_ids = layout.position_ids
    offset = float(position_ids[video_start, 0]) - float(layout.signature[0])
    if refs and offset:
        for start, stop, kind in layout.segments:
            if kind == "cond":
                position_ids[start:stop, 0].add_(offset)
    for ref, row in zip(refs, _ref_row_ranges(layout, refs)):
        if _CONTEXT_FRAMES_MARK not in ref:
            continue
        window_t = int(ref.get("latent_t") or 0)
        if window_t > target_t:
            raise RuntimeError(f"[NeoNodes] 跨段上下文窗口 T={window_t} 超过目标视频 T={target_t}")
        if row["video"] is None:
            raise RuntimeError("[NeoNodes] 跨段上下文窗口参考缺少视频行")
        start, stop = row["video"]
        if window_t <= 0 or stop - start != window_t * frame_rows:
            raise RuntimeError(f"[NeoNodes] 跨段上下文窗口行数 {stop - start} 与 latent T={window_t} 不符")
        position_ids[start:stop].copy_(position_ids[video_start:video_start + window_t * frame_rows])
    setattr(layout, _CONTEXT_ALIGNED_ATTR, True)


def _continuity_wrapper(executor, *args, **kwargs):
    """APPLY_MODEL wrapper：模型调用前修好本次调用的 payload（合并 cond 列表 + 对齐连续性行的时间轴）。"""
    payload = kwargs.get("minimax_payload")
    if not isinstance(payload, dict):
        return executor(*args, **kwargs)
    if payload.get("keyframes") and payload.get("refs") is not None:
        payload = dict(payload)
        _merge_cond_latents(payload)
        kwargs["minimax_payload"] = payload
    _align_payload_timeline(payload)
    return executor(*args, **kwargs)


def _install_continuity(model):
    """clone 一个 MODEL 并挂上连续性 wrapper（同一 key 先清再挂，可重复安装）。"""
    from comfy.patcher_extension import WrappersMP
    patched = model.clone()
    patched.remove_wrappers_with_key(WrappersMP.APPLY_MODEL, _CONTINUITY_WRAPPER_KEY)
    patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, _CONTINUITY_WRAPPER_KEY, _continuity_wrapper)
    return patched


class NeoH3AddKeyframe:
    """手动/画布用：把图像作为首帧 keyframe 锚点注入 H3 conditioning（与 minimax_refs 共存）。

    NeoH3VideoDirector 已改用 NeoH3AddContext（跨段上下文窗口）；本节点保留给手动搭图与旧画布工作流。
    接收已编码的参考 conditioning + VAE + 图像，将图像编码为 latent 后以 resolved_frame_index=0 写入
    minimax_keyframes；同时返回挂了连续性 wrapper 的 MODEL，使 refs 与 keyframes 同时生效、时间轴对齐。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "image": ("IMAGE",),
                "frame_count": ("INT", {"default": 124, "min": 5, "max": 3600}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("model", "conditioning")
    FUNCTION = "add_keyframe"
    CATEGORY = "Neo-Nodes"

    def add_keyframe(self, model, conditioning, vae, image, frame_count):
        import node_helpers
        img = image[:1]  # [1, H, W, C]
        latent = vae.encode(img)
        keyframes = [{"resolved_frame_index": 0, "latent": latent}]
        cond = node_helpers.conditioning_set_values(conditioning, {
            "minimax_keyframes": keyframes,
            "minimax_frame_count": int(frame_count),
        })
        return (_install_continuity(model), cond)


_H3_COND_NODES = ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo")
_H3_SAMPLER_NODES = ("KSampler", "KSamplerAdvanced")
_CANVAS_MULTIPLE = 32   # 参考块的像素对齐（官方 H3 节点同款；latent 侧即 16 分频后的偶数）


def _canvas_size(value):
    """模板里的 width/height 输入：整数才当画布用（链接 / 占位符 / 缺省都返回 0 = 不缩放）。"""
    return int(value) if isinstance(value, int) else 0


def _free_node_id(graph):
    """模板图里没被占用的节点 id（注入节点用它，避免与模板 id 撞号）。"""
    nid = 9000
    while str(nid) in graph:
        nid += 1
    return str(nid)


def _inject_continuity_nodes(graph, context_tail, context_frames, identity_names=()):
    """在渲染后的模板图里注入 NeoH3AddContext（先身份参考、后上下文窗口），返回 (graph, overrides)。

    定位消费 H3 conditioning 的采样器，把采样器的 model / positive / negative 改指到注入节点——模型输出
    带连续性 wrapper，refs 与 keyframe 锚点才会同时生效、时间轴才对齐。context_tail 通过 override 注入虚拟
    LoadImage（不写临时文件）；身份参考图直接用 input 目录里的真实 LoadImage（与 r2v 模板同一条加载路径）。
    """
    if context_tail is None and not identity_names:
        return graph, None
    sampler_id = cond_id = None
    for nid, node in graph.items():
        if node.get("class_type") not in _H3_SAMPLER_NODES:
            continue
        for key in ("positive", "negative"):
            src = (node.get("inputs") or {}).get(key)
            if not (isinstance(src, (list, tuple)) and len(src) == 2):
                continue
            cond_node = graph.get(src[0])
            if cond_node is not None and cond_node.get("class_type") in _H3_COND_NODES:
                sampler_id, cond_id = nid, src[0]
                break
        if sampler_id is not None:
            break
    if sampler_id is None:
        raise RuntimeError("[NeoNodes] 未找到消费 H3 conditioning 的 KSampler，无法注入跨段连续性")
    sampler_inputs = graph[sampler_id]["inputs"]
    cond_inputs = graph[cond_id]["inputs"]
    model_src = sampler_inputs.get("model")
    vae_src = cond_inputs.get("vae")
    if not (isinstance(model_src, (list, tuple)) and len(model_src) == 2):
        raise RuntimeError("[NeoNodes] H3 采样器没有 model 来源，无法把连续性 wrapper 交给采样")
    if not (isinstance(vae_src, (list, tuple)) and len(vae_src) == 2):
        raise RuntimeError("[NeoNodes] H3 conditioning 节点没有 vae 来源，无法编码上下文窗口")

    width = _canvas_size(cond_inputs.get("width"))
    height = _canvas_size(cond_inputs.get("height"))
    overrides = {}
    model_ref, cond_ref = [model_src[0], model_src[1]], [cond_id, 0]

    def add_node(image_key, image_id, **extra):
        """插一个 NeoH3AddContext：接在上一棒后面，下一棒的 model / conditioning 指到它。"""
        nonlocal model_ref, cond_ref
        node_id = _free_node_id(graph)
        graph[node_id] = {"class_type": "NeoH3AddContext", "inputs": {
            "model": model_ref, "conditioning": cond_ref, "vae": [vae_src[0], vae_src[1]],
            "width": width, "height": height, image_key: [image_id, 0], **extra}}
        model_ref, cond_ref = [node_id, 0], [node_id, 1]

    for name in identity_names:
        image_id = _free_node_id(graph)
        graph[image_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        add_node("identity_image", image_id)
    if context_tail is not None:
        image_id = _free_node_id(graph)
        graph[image_id] = {"class_type": "LoadImage", "inputs": {"image": "__neo_context_tail__"}}
        add_node("context_image", image_id, context_frames=int(context_frames))
        overrides[image_id] = [context_tail]

    sampler_inputs["model"] = model_ref
    for key in ("positive", "negative"):
        src = sampler_inputs.get(key)
        if isinstance(src, (list, tuple)) and len(src) == 2 and src[0] == cond_id:
            sampler_inputs[key] = cond_ref
    return graph, overrides


class NeoH3AddContext:
    """跨段连续性：把上段尾部若干帧当作 H3 视频参考注入 conditioning，并可附带身份参考图。

    context_image 取尾部 context_frames 帧编成一条参考视频块（帧数就近对齐到模型要求的 17k+5 网格），
    identity_image 的每张图各编成一条参考图片块（按画布面积等比缩放，与官方 r2v 的参考图同规格）。
    返回的 MODEL 挂了连续性 wrapper：keyframes 与 refs 并存时合回一条 cond 列表，并把上下文行与锚点行的
    时间坐标对齐到目标视频时间轴（wrapper 按命名空间安装，链式多段调用也只会保留一份）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 1344, "min": 0, "max": comfy_nodes.MAX_RESOLUTION}),
                "height": ("INT", {"default": 768, "min": 0, "max": comfy_nodes.MAX_RESOLUTION}),
            },
            "optional": {
                "context_image": ("IMAGE",),   # 上段尾部 window 帧
                "identity_image": ("IMAGE",),  # 身份参考图（可批量，逐张成块）
                "context_frames": ("INT", {"default": 22, "min": 0, "max": 362}),   # 0 = 不注入上下文窗口
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("model", "conditioning")
    FUNCTION = "add_context"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "跨段上下文窗口：上段尾部若干帧作为 H3 视频参考（+可选身份参考图）注入 conditioning。"

    def add_context(self, model, conditioning, vae, width, height,
                    context_image=None, identity_image=None, context_frames=22):
        import node_helpers
        canvas = _ref_canvas(width, height)
        images = identity_image if identity_image is not None else []
        refs = [_identity_ref(vae, image.unsqueeze(0), canvas) for image in images]
        window = _align_context_frames(context_frames) if int(context_frames or 0) > 0 else 0
        if context_image is not None and window > 0:
            refs.append(_context_ref(vae, context_image, window, canvas))
        if not refs:
            return (model, conditioning)
        cond = node_helpers.conditioning_set_values(conditioning, {"minimax_refs": refs}, append=True)
        return (_install_continuity(model), cond)


def _ref_canvas(width, height):
    """参考块要用的画布像素尺寸（按 32 对齐）；非法尺寸返回 None（= 用图像自身尺寸）。"""
    if int(width) <= 0 or int(height) <= 0:
        return None
    return (max(_CANVAS_MULTIPLE, round(int(width) / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE),
            max(_CANVAS_MULTIPLE, round(int(height) / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE))


def _ref_pixels(width, height, canvas):
    """参考图/视频要编码的像素尺寸：给了画布就按画布面积等比缩到不超过画布（官方 r2v 的 match 同法）。

    两种来源都按 32 对齐——patchify 要求 latent 侧每轴为偶数，非画布来源的尺寸先对齐再送 VAE。
    """
    if canvas is not None:
        scale = min(1.0, math.sqrt((canvas[0] * canvas[1]) / float(width * height)))
        width, height = width * scale, height * scale
    return (max(_CANVAS_MULTIPLE, round(width / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE),
            max(_CANVAS_MULTIPLE, round(height / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE))


def _resize_frames(frames, width, height):
    """[B,H,W,C] 拉到目标像素尺寸（官方参考图/参考视频用的同一套 lanczos 拉抻，裁剪关闭）。"""
    if frames.shape[1] == height and frames.shape[2] == width:
        return frames
    samples = frames[..., :3].movedim(-1, 1)
    return comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)


def _identity_ref(vae, image, canvas):
    """一张身份参考图 → 布局的图片参考块（与官方 r2v 的 ref_image 同规格）。"""
    width, height = _ref_pixels(image.shape[2], image.shape[1], canvas)
    latent = vae.encode(_resize_frames(image[:1], width, height))
    return {"kind": "image", "latent_h": height // 16, "latent_w": width // 16, "latent": latent}


def _context_ref(vae, frames, window, canvas):
    """尾部 window 帧 → 布局的视频参考块（无音轨，ref_audio_t=0）。"""
    width, height = _ref_pixels(frames.shape[2], frames.shape[1], canvas)
    latent = vae.encode(_resize_frames(frames[-window:], width, height))
    latent_t = int(latent.shape[2])
    expect = _context_latent_t(window)
    if latent_t != expect:
        raise ValueError(
            f"上下文窗口 {window} 帧编码后得到 latent T={latent_t}，与 H3 的 17k+5 网格（T={expect}）不符："
            "请确认 vae 是 MiniMax H3 视频 VAE")
    return {"kind": "video", "latent_t": latent_t, "latent_h": height // 16, "latent_w": width // 16,
            "ref_audio_t": 0, "latent": latent, "audio_latent": None, _CONTEXT_FRAMES_MARK: int(window)}


def _align_context_frames(n):
    """上下文窗口帧数就近对齐到 H3 的 17k+5 网格（不低于 5）：落在网格上，末尾的 latent 步才正好覆盖这些帧。"""
    n = int(n)
    if n <= 5:
        return 5
    return 5 + 17 * int(round((n - 5) / 17.0))


def _context_latent_t(window):
    """window 帧上下文在 latent 时间轴上占的步数（每 17 帧 5 步、首步只含 1 帧）。"""
    return 2 + 5 * ((int(window) - 5) // 17)


def _inherited_identity_names(segments):
    """身份继承的参考图：第一个带参考素材的段的参考图（上限 4 张）。"""
    for seg in segments:
        names = (seg.get("refs") or {}).get("images") or []
        if names:
            return list(names)[:4]
    return []


def _align_frame_count(n):
    """向上对齐到 H3 的 17k+5 帧网格。"""
    n = max(5, int(n))
    while n % 17 != 5:
        n += 1
    return n


def _align_frame_count_nearest(n, minimum=5):
    """就近对齐到 17k+5 帧网格（不低于 minimum）：总时长含上下文窗口时用它，避免向上对齐多出半个窗口。"""
    n = max(int(n), int(minimum))
    up = _align_frame_count(n)
    down = up - 17
    if down >= max(5, int(minimum)) and n - down < up - n:
        return down
    return up


def _run_segment_graph(body, skill_id, model, steps, label="", vae=None, preview=True, node_id=None,
                       context_tail=None, context_frames=0, identity_names=(), on_step=None):
    """单段执行链：解析参数 → 渲染模板 → 模型注入/VDN 校验 → 连续性注入 → 进程内执行，返回 VIDEO。

    recipe 逐段与 BUNDLE 单段共用；label 仅用于错误消息前缀（如「第 3 段：」）。
    vae/preview/node_id 控制采样期间节点内的实时预览（见 h3_preview）。
    on_step：每采样步回调（step_number），供 director 更新进度。
    context_tail：本段开头的重生成窗口（上段尾部 context_frames 帧，[F,H,W,C]）——给了它就把目标时长
    加 window 帧并就近对齐到 17k+5 网格，那段帧由调用方在拼接时丢掉。
    identity_names：继承到本段的身份参考图文件名（用 input 目录里的真实 LoadImage 加载）。
    """
    real_id = _resolve_skill_id(skill_id or "")
    template = load_skill_workflow(real_id)
    if template is None:
        raise RuntimeError(f"{label}skill '{skill_id}' 缺少 workflow.json，无法生成")
    cfg = get_skill_gen_config(real_id)
    params = resolve_video_params(body, cfg, skip_model=(model is not None))
    if steps is not None and int(steps) > 0:
        params["steps"] = int(steps)
    window = int(context_frames or 0) if context_tail is not None else 0
    if window > 0:
        params["length"] = _align_frame_count_nearest(int(params.get("length") or 124) + window,
                                                     minimum=window + 5)
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
    graph, c_overrides = _inject_continuity_nodes(graph, context_tail, window, identity_names)
    if c_overrides:
        overrides = {**(overrides or {}), **c_overrides}
    with preview_override(preview, vae, node_id, on_step=on_step):
        return execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)


class NeoH3VideoDirector:
    """以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；连 NeoPromptAgent 的 BUNDLE 时按单片段生成（忽略配方）。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = list_director_recipes()
        vskills = _gen_video_skills()
        return {
            "required": {
                "recipe": (names, {"default": names[0] if names else ""}),
            },
            "optional": {
                "skill_id": ([s["name"] for s in vskills], {"default": vskills[0]["name"] if vskills else ""}),  # BUNDLE 单段用的视频 skill；recipe 多段模式忽略（各段自带）
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**63 - 1}),   # -1 = 用配方 shared.seed
                "width": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用各段 skill config（选中配方时前端自动填首段默认）
                "height": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用各段 skill config（选中配方时前端自动填首段默认）
                "continuity": ("BOOLEAN", {"default": True}),   # 跨段连续性总开关：开 = 上下文窗口 + 身份继承
                "context_frames": ("INT", {"default": 22, "min": 0, "max": 362}),  # 上下文窗口帧数；0 = 退回 Tier A 尾帧链入
                "model": ("MODEL",),  # 外部加速模型；提供时覆盖每段内部主模型链（UNETLoader/LoRA/VDN）
                "steps": ("INT", {"default": -1, "min": -1, "max": 100}),  # -1 = 用 preset/config 值
                "preview": ("BOOLEAN", {"default": True}),   # 节点内实时预览：开 = taeh3 真彩动作预览，关 = 完全不出
                # 仅 BUNDLE 单段模式用（配方多段时各段自带 duration_sec）：秒 → 帧（24fps，向上对齐 17k+5 网格）
                # 默认 5 秒 = 内置 H3 skill config 的 length（124 帧）；前端选中 skill 后按该 skill 的 length 自动填秒数
                "duration_sec": ("INT", {"default": 5, "min": 1, "max": 150,
                                         "tooltip": "BUNDLE 单段时长（秒）：按 24fps 换算成 H3 帧数并对齐 17k+5 网格（5 秒 → 124 帧）；切换视频 skill 时按该 skill config 的 length 自动填"}),
                "bundle": ("STRING", {"forceInput": True}),   # NeoPromptAgent BUNDLE；提供时忽略 recipe，按单段生成
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",   # 预览事件按节点 id 路由回节点内的动画面板
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "多段视频导演：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO（跨段上下文窗口保连续性）。"

    def _run_bundle_segment(self, payload, skill_id, seed, width, height, model, steps, vae=None, preview=True, node_id=None,
                           duration_sec=5):
        """BUNDLE 单段生成：提示词/参考来自 NeoPromptAgent 的 BUNDLE（data URI），视频 skill / 时长（秒）用节点入参，忽略 recipe。"""
        sid = _resolve_skill_id(skill_id)
        if not any(s["id"] == sid for s in _gen_video_skills()):
            raise ValueError(f"未选择有效的视频 skill：'{skill_id}'（需为含 workflow.json 的视频技能）")
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
        body["length"] = _seconds_to_frames(int(duration_sec))
        refs = payload.get("references") or []
        if refs:
            body["references"] = list(refs)
        video = _run_segment_graph(body, sid, model, steps, vae=vae, preview=preview, node_id=node_id)
        comp = video.get_components()
        return (InputImpl.VideoFromComponents(
            Types.VideoComponents(images=comp.images, audio=comp.audio, frame_rate=Fraction(H3_FPS))
        ),)

    def generate(self, recipe, skill_id="", seed=-1, width=-1, height=-1, continuity=True, context_frames=22, model=None, steps=-1, duration_sec=5, bundle="", preview=True, unique_id=None):
        vae = load_h3_tiny_vae() if preview else None   # 预览解码器：一次生成内复用；关闭时不加载
        payload = get_bundle(bundle) if bundle else None
        if payload:
            return self._run_bundle_segment(payload, skill_id, seed, width, height, model, steps, vae, preview, unique_id,
                                            duration_sec=duration_sec)
        spec = load_director_spec(recipe)
        shared = spec.get("shared") or {}
        segments = spec.get("segments") or []
        if not segments:
            raise ValueError(f"配方 '{recipe}' 没有可执行的段")

        base_seed = int(seed) if int(seed) >= 0 else (int(shared.get("seed", 0)) if shared.get("seed") is not None else 0)
        # width/height：节点入参 > 0 时覆盖全部段；-1 时不写入 body，交由 resolve_video_params 按各段 skill config 默认回退。
        in_w = int(width) if int(width) > 0 else 0
        in_h = int(height) if int(height) > 0 else 0

        # 跨段上下文窗口：上段尾部 window 帧作为下段开头的重生成窗口（0 = 退回 Tier A 的尾帧链入）
        window = _align_context_frames(context_frames) if continuity and int(context_frames or 0) > 0 else 0
        identity_names = _inherited_identity_names(segments) if continuity else []

        _DIRECTOR_PROGRESS.update(active=True, segment_index=-1, total_segments=len(segments), step=0,
                                  total_steps=max(1, int(steps)) if int(steps) > 0 else 0)
        all_frames = []
        all_audio = []
        drops = []       # 与 segments 对齐：该段丢掉的头部帧数（上下文窗口帧数 / Tier A 的 1 帧 / 0）
        prev_tail = None
        try:
            for i, seg in enumerate(segments):
                _DIRECTOR_PROGRESS["segment_index"] = i
                _DIRECTOR_PROGRESS["step"] = 0
                prompt = seg.get("prompt", "")
                body = {
                    "prompt": prompt,
                    "seed": (base_seed + i) % (2**63),
                }
                if in_w > 0:
                    body["width"] = in_w
                if in_h > 0:
                    body["height"] = in_h
                dur = seg.get("duration_sec")
                if dur is not None and float(dur) > 0:
                    body["length"] = _seconds_to_frames(float(dur))

                # 跨段上下文窗口：上段尾部 window 帧作为本段开头的重生成窗口（上段得够长）
                context_tail = None
                if window > 0 and prev_tail is not None and prev_tail.shape[0] >= window:
                    context_tail = prev_tail

                # 按段模式组装参考（T2V 段不带任何参考）：
                #   i2v/fl2v 首帧（Tier A：continuity 时链入上段尾帧；有上下文窗口时窗口自己承担开头的引导）
                #   r2v 仅参考素材（图/视频/音频）
                #   v2v/rv2v 源视频（自动作为 ref_videos[0]，提示词自动加 <Video 1>）
                #   fl2v 另带尾帧锁收尾
                mode = seg.get("mode") or "t2v"
                refs = []
                chained = False
                
                # v2v/rv2v: 源视频作为第一个参考视频
                source_video = seg.get("source_video")
                if source_video and mode in ("v2v", "rv2v"):
                    refs.append({"kind": "input", "value": source_video, "media": "video"})
                    # 提示词自动加 <Video 1> 标签（如果没有的话）
                    if "<Video 1>" not in prompt:
                        body["prompt"] = f"<Video 1> {prompt}"
                
                if mode in ("i2v", "fl2v"):
                    primary_input = None
                    if context_tail is not None:
                        # 窗口的第 0 帧就是目标第 0 帧：拿它当首帧（与窗口行同内容，锚点时间轴由 wrapper 修正）
                        refs.append({"kind": "data", "data": _image_to_data_uri(context_tail[:1])})
                        chained = True
                    elif continuity and i > 0 and prev_tail is not None:
                        refs.append({"kind": "data", "data": _image_to_data_uri(prev_tail[-1:])})
                        chained = True
                    elif seg.get("ref_input"):
                        primary_input = seg["ref_input"]
                        refs.append({"kind": "input", "value": primary_input})
                elif mode == "r2v":
                    primary_input = None
                    chained = context_tail is not None
                if mode in ("i2v", "fl2v", "r2v"):
                    seg_refs = seg.get("refs") or {}
                    for name in (seg_refs.get("images") or []):
                        if name != primary_input:
                            refs.append({"kind": "input", "value": name})
                    for name in (seg_refs.get("videos") or []):
                        refs.append({"kind": "input", "value": name, "media": "video"})
                    for name in (seg_refs.get("audios") or []):
                        refs.append({"kind": "input", "value": name, "media": "audio"})
                # 身份继承：首段的身份参考图领养到后续段（本段已经送出的那些不再重复注入）
                sent = {r["value"] for r in refs if r.get("kind") == "input"}
                inherited = [n for n in identity_names if n not in sent] if i > 0 else []
                if refs:
                    body["references"] = refs
                if mode == "fl2v":
                    if not seg.get("last_input"):
                        raise ValueError(f"第 {i + 1} 段为首尾帧生视频但缺少尾帧：请为该段设置尾帧图")
                    body["last_frame"] = {"kind": "input", "value": seg["last_input"]}
                if mode in ("i2v", "fl2v") and not refs and context_tail is None:
                    raise ValueError(
                        f"第 {i + 1} 段为{'首尾帧' if mode == 'fl2v' else '图生视频'}但没有可用首帧：" +
                        ("请为该段设置首帧，或开启「连续性」以上段尾帧 / 上下文窗口链入"
                         if i > 0 else "首段需自带首帧"))
                if mode == "r2v" and not refs and not inherited and context_tail is None:
                    raise ValueError(f"第 {i + 1} 段为全参考生视频但没有参考素材：请挂参考图 / 视频 / 音频")
                if mode in ("v2v", "rv2v") and not source_video:
                    raise ValueError(f"第 {i + 1} 段为{'视频编辑' if mode == 'v2v' else '视频+参考图编辑'}但缺少源视频：请为该段设置 source_video")

                video = _run_segment_graph(body, seg.get("skill_id") or "", model, steps, f"第 {i + 1} 段：",
                                           vae, preview, unique_id, context_tail=context_tail,
                                           context_frames=window, identity_names=inherited,
                                           on_step=lambda s: _DIRECTOR_PROGRESS.__setitem__("step", s))
                comp = video.get_components()
                frames = comp.images

                # 丢掉头部：上下文窗口重生成的 window 帧；Tier A 则丢与上段重复的那一帧
                drop = window if context_tail is not None else (1 if (i > 0 and chained) else 0)
                all_frames.append(frames[drop:] if drop and frames.shape[0] > drop else frames)
                drops.append(drop)
                all_audio.append(comp.audio)
                prev_tail = frames[-window:] if window > 0 else frames[-1:]

            final_frames = torch.cat(all_frames, dim=0)
            final_audio = _concat_segment_audio(all_audio, H3_FPS, drops)
            return (InputImpl.VideoFromComponents(
                Types.VideoComponents(images=final_frames, audio=final_audio, frame_rate=Fraction(H3_FPS))
            ),)
        finally:
            _DIRECTOR_PROGRESS.update(active=False, segment_index=-1, total_segments=0, step=0, total_steps=0)


NODE_CLASS_MAPPINGS = {"NeoH3VideoDirector": NeoH3VideoDirector, "NeoH3AddKeyframe": NeoH3AddKeyframe,
                       "NeoH3AddContext": NeoH3AddContext}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3VideoDirector": "Neo H3 Video Director",
                              "NeoH3AddKeyframe": "Neo H3 Add Keyframe (Hybrid)",
                              "NeoH3AddContext": "Neo H3 Add Context (Cross-segment)"}