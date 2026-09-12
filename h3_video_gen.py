"""MiniMax H3 视频生成节点：按所选 skill 的 workflow.json 模板同步生成，输出含音频的 VIDEO（可接 SaveVideo）到下游。

设计（复用 Krea2 mini-executor）：
- NeoH3VideoGenerate 在 forward 内渲染 skill 的 workflow.json 模板（占位符替换），
  由进程内 mini-executor (execute_graph_inprocess) 拓扑执行该 graph，返回末端 CreateVideo 的 VIDEO（含音频）。
- H3 条件/采样链含 V3 API 节点（MiniMaxH3*、LTXVSeparateAVLatent、VAEDecodeAudio、CreateVideo），mini-executor 已支持 API 节点分支。
- T2V：无参考图；I2V：首帧 IMAGE → LoadImage → MiniMaxH3ImageToVideo.first_frame。
- 模型/文本编码器/VAE 优先取 skill config.json，回落到独立「生视频模型」设置（video_gen.json / get_video_settings）；尺寸/时长可由节点入参覆盖。
"""

import random

import nodes as comfy_nodes

from .image_gen import _reference_name, _resolve_loras, render_template, resolve_model
from .video_gen import get_video_settings, suggest_audio_vae, suggest_video_model
from .krea2_generate import _image_to_data_uri, execute_graph_inprocess
from .skill import get_skill_gen_config, load_skill_workflow, scan_skills


def _gen_video_skills():
    """带 workflow.json 的视频生成 skill（scan_skills 保证 name 非空，缺省回退 id）。"""
    return [s for s in scan_skills() if s.get("gen_video") and load_skill_workflow(s["id"])]


def _resolve_skill_id(value):
    """skill_id 下拉显示 skill name；反查真实 id，找不到则按 id 直接用（兼容旧工作流存的 id）。"""
    by_name = {s["name"]: s["id"] for s in _gen_video_skills()}
    return by_name.get(value, value)


def _first_nonempty(*vals):
    for v in vals:
        s = str(v or "").strip()
        if s:
            return s
    return ""


H3_FPS = 24


def _seconds_to_frames(seconds):
    """秒 → H3 帧数：按 24fps 取整后向上对齐到模型的 17k+5 网格（官方模板同款公式）。"""
    n = max(5, round(seconds * H3_FPS))
    return n + (5 - (n % 17)) % 17


def resolve_video_params(body: dict, cfg: dict) -> dict:
    """把一次视频生成请求解析成模板参数；非法时抛 ValueError（消息可直接回前端）。

    cfg 为 skill 的 config.json：model/text_encoder/vae 优先取 cfg，缺省回落到独立「生视频模型」
    设置（video_gen.json / get_video_settings），仍空则按 H3 名称线索自动挑选；width/height/length 缺省用 H3 默认。
    """
    prompt_text = str(body.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("提示词为空")

    # H3 模型/文本编码器/VAE：skill config.json 优先，回落到独立「生视频模型」设置（video_gen.json），
    # 仍空则按 H3 名称线索自动挑选（与生图 suggest_model 一致）；都拿不到才报错
    vs = get_video_settings()
    model = _first_nonempty(cfg.get("model"), vs.get("video_model")) or suggest_video_model("diffusion_models")
    if not model:
        raise ValueError("未找到 H3 视频模型：diffusion_models 里没有 h3 模型，且未在设置或 skill config.json 指定")
    encoder = _first_nonempty(cfg.get("text_encoder"), vs.get("video_text_encoder")) or suggest_video_model("text_encoders")
    if not encoder:
        raise ValueError("未找到 H3 视频 Text Encoder：text_encoders 里没有 h3 模型，且未在设置或 skill config.json 指定")
    vae = _first_nonempty(cfg.get("vae"), vs.get("video_vae")) or suggest_video_model("vae")
    if not vae:
        raise ValueError("未找到 H3 视频 VAE：vae 里没有 h3_video 模型，且未在设置或 skill config.json 指定")
    model, err = resolve_model("diffusion_models", model)
    if err:
        raise ValueError(err)
    encoder, err = resolve_model("text_encoders", encoder)
    if err:
        raise ValueError(err)
    vae, err = resolve_model("vae", vae)
    if err:
        raise ValueError(err)
    # H3 音频是独立 VAE（MiniMaxH3AudioVAE），必须单独加载；VAEDecodeAudio 不能复用视频 VAE
    audio_vae = _first_nonempty(cfg.get("audio_vae"), vs.get("video_audio_vae")) or suggest_audio_vae()
    if not audio_vae:
        raise ValueError("未找到 H3 音频 VAE：vae 里没有 h3 audio 模型，且未在 skill config.json 指定")
    audio_vae, err = resolve_model("vae", audio_vae)
    if err:
        raise ValueError(err)
    # LoRA：复用生图解析（校验存在性 + 强度裁剪）；视频无「依赖参考图」概念，配置的全部无条件加载
    loras, _lora_warns = _resolve_loras(cfg)

    # 参考图（I2V 首帧）：取第一张，落盘成 LoadImage 可用名
    refs = body.get("references")
    refs = refs if isinstance(refs, list) else ([refs] if refs else [])
    ref_name = None
    for src in refs:
        name = _reference_name(src)
        if name and ref_name is None:
            ref_name = name

    width = int(body.get("width") or cfg.get("width") or 1344)
    height = int(body.get("height") or cfg.get("height") or 768)
    length = int(body.get("length") or cfg.get("length") or 124)

    seed = body.get("seed")
    seed = random.randint(0, 2**63 - 1) if seed is None else max(0, int(seed))

    return {
        "prompt": prompt_text,
        "model": model,
        "text_encoder": encoder,
        "vae": vae,
        "audio_vae": audio_vae,
        "loras": loras,
        "width": width,
        "height": height,
        "length": length,
        "seed": seed,
        "ref_name": ref_name,
    }


class NeoH3VideoGenerate:
    """按所选 skill 的 workflow.json 模板同步生成 MiniMax H3 视频，输出含音频的 VIDEO（可接 SaveVideo）。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = [s["name"] for s in _gen_video_skills()]
        return {
            "required": {
                "skill_id": (names, {"default": names[0] if names else ""}),
            },
            "optional": {
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "image": ("IMAGE",),  # I2V 首帧；T2V 忽略
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**63 - 1}),  # 默认固定，随机走「生成后控制」
                "duration": ("INT", {"default": 5, "min": -1, "max": 3600}),     # 秒；-1 = 用 config/默认(约5s)
                "width": ("INT", {"default": 1344, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),   # -1 = 用 config/默认
                "height": ("INT", {"default": 768, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),    # -1 = 用 config/默认
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "MiniMax H3 视频生成节点：按所选 skill 的 workflow.json 模板同步生成，输出含音频的 VIDEO（可接 SaveVideo）。"

    def generate(self, skill_id, prompt="", image=None, seed=-1, duration=-1, width=-1, height=-1):
        real_id = _resolve_skill_id(skill_id)
        template = load_skill_workflow(real_id)
        if template is None:
            raise RuntimeError(f"[NeoNodes] H3 视频 skill '{skill_id}' 缺少 workflow.json，无法生成")
        cfg = get_skill_gen_config(real_id)
        body = {"prompt": prompt}
        if seed is not None and int(seed) >= 0:
            body["seed"] = int(seed)
        if duration is not None and int(duration) > 0:
            body["length"] = _seconds_to_frames(int(duration))
        if width is not None and int(width) > 0:
            body["width"] = int(width)
        if height is not None and int(height) > 0:
            body["height"] = int(height)
        if image is not None:
            body["references"] = [{"kind": "data", "data": _image_to_data_uri(image)}]
        params = resolve_video_params(body, cfg)
        graph, _render_warnings = render_template(template, params)
        return (execute_graph_inprocess(graph, output_type="VIDEO"),)


NODE_CLASS_MAPPINGS = {"NeoH3VideoGenerate": NeoH3VideoGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3VideoGenerate": "Neo H3 Video Generate"}