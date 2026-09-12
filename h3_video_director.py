"""Neo H3 Video Director：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO。

设计（复用单段 H3 路径）：
- NeoH3VideoDirector 从配方读取 {shared, segments[]}；每段带自己的 skill_id、prompt、时长、首帧参考。
- 逐段复用 NeoH3VideoGenerate 的解析/执行链（resolve_video_params + render_template + execute_graph_inprocess）。
- Tier A 连续性：上一段尾帧作为下一段 I2V 首帧；丢下段第一帧避免边界重复，并按丢帧数裁音频保 A/V 对齐。
- seed 派生：base_seed + i（i 为段序号），保证可复现且各段不同。
"""

import torch
from fractions import Fraction

import nodes as comfy_nodes
from comfy_api.latest import InputImpl, Types

from .image_gen import render_template
from .krea2_generate import _image_to_data_uri, execute_graph_inprocess
from .h3_video_gen import H3_FPS, _resolve_skill_id, _seconds_to_frames, resolve_video_params
from .skill import get_skill_gen_config, load_skill_workflow
from .recipes import list_director_recipes, load_director_spec


def _concat_segment_audio(audios, frame_rate: int, drop_per_seam: int):
    """把各段 AudioInput 拼成一条；每段接缝丢 drop_per_seam 帧对应的采样（对齐被丢的边界帧）。

    audios 为每段的 comp.audio（AudioInput {waveform:[B,C,T], sample_rate} 或 None），顺序对应各段。
    返回合并后的 AudioInput；全部无音频时返回 None。
    """
    present = [a for a in audios if a is not None]
    if not present:
        return None
    sample_rate = int(present[0].get("sample_rate") or 1)
    drop = int(round(sample_rate / frame_rate)) * max(0, drop_per_seam)   # 每丢一帧对应的采样数
    parts = []
    for i, a in enumerate(audios):
        if a is None:
            continue
        w = a["waveform"]
        if i > 0 and drop > 0:
            w = w[..., drop:]
        parts.append(w)
    if not parts:
        return None
    return {"waveform": torch.cat(parts, dim=-1), "sample_rate": sample_rate}


class NeoH3VideoDirector:
    """以 video_director 配方为参数：逐段按各自 skill 模板生成，Tier A 连续性拼接，输出单个含音频 VIDEO。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = list_director_recipes()
        return {
            "required": {
                "recipe": (names, {"default": names[0] if names else ""}),
            },
            "optional": {
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**63 - 1}),   # -1 = 用配方 shared.seed
                "width": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用 shared
                "height": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用 shared
                "continuity": ("BOOLEAN", {"default": True}),   # Tier A：上段尾帧→下段首帧 + 丢边界帧
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "多段视频导演：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO。"

    def generate(self, recipe, seed=-1, width=-1, height=-1, continuity=True):
        spec = load_director_spec(recipe)
        shared = spec.get("shared") or {}
        segments = spec.get("segments") or []
        if not segments:
            raise ValueError(f"配方 '{recipe}' 没有可执行的段")

        base_seed = int(seed) if int(seed) >= 0 else (int(shared.get("seed", 0)) if shared.get("seed") is not None else 0)
        out_w = int(width) if int(width) > 0 else int(shared.get("width") or 1344)
        out_h = int(height) if int(height) > 0 else int(shared.get("height") or 768)

        all_frames = []
        all_audio = []
        prev_tail = None
        for i, seg in enumerate(segments):
            body = {
                "prompt": seg.get("prompt", ""),
                "seed": (base_seed + i) % (2**63),
                "width": out_w,
                "height": out_h,
            }
            dur = seg.get("duration_sec")
            if dur is not None and float(dur) > 0:
                body["length"] = _seconds_to_frames(float(dur))

            ref = None
            if continuity and i > 0 and prev_tail is not None:
                ref = {"kind": "data", "data": _image_to_data_uri(prev_tail)}
            elif seg.get("ref_input"):
                ref = {"kind": "input", "value": seg["ref_input"]}
            if ref:
                body["references"] = [ref]

            real_id = _resolve_skill_id(seg.get("skill_id") or "")
            template = load_skill_workflow(real_id)
            if template is None:
                raise RuntimeError(f"第 {i + 1} 段 skill '{seg.get('skill_id')}' 缺少 workflow.json，无法生成")
            cfg = get_skill_gen_config(real_id)
            params = resolve_video_params(body, cfg)
            graph, _warns = render_template(template, params)
            video = execute_graph_inprocess(graph, output_type="VIDEO")
            comp = video.get_components()
            frames = comp.images

            if i == 0:
                all_frames.append(frames)
            elif continuity and frames.shape[0] > 1:
                all_frames.append(frames[1:])   # 丢与上段重复的边界帧
            else:
                all_frames.append(frames)
            all_audio.append(comp.audio)
            prev_tail = frames[-1:]

        final_frames = torch.cat(all_frames, dim=0)
        drop = 1 if continuity else 0
        final_audio = _concat_segment_audio(all_audio, H3_FPS, drop)
        return (InputImpl.VideoFromComponents(
            Types.VideoComponents(images=final_frames, audio=final_audio, frame_rate=Fraction(H3_FPS))
        ),)


NODE_CLASS_MAPPINGS = {"NeoH3VideoDirector": NeoH3VideoDirector}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3VideoDirector": "Neo H3 Video Director"}