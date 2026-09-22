# ComfyUI-Neo-Nodes - 参考图宫格节点
# 单节点搞定「提示词 + 最多 12 张参考图」：前端宫格槽位持 input/ 文件名（隐藏 refs widget，
# 随工作流持久化；槽位数 1~12 由前端运行时调整，不随工作流保存）。执行时按序解码成
# image_1..image_12（autogrow 输出），同时把提示词 + 参考图打包成运行时 BUNDLE，
# 供 Krea2/H3 下游直接消费。

from __future__ import annotations

import base64
import json

import torch

from .bundle_expand import _reference_to_image
from .bundles import create_bundle
from .prompts import image_tensor_to_png

GRID_MAX = 12   # 宫格槽位上限（前端 −/+ 运行时可调 1~12）


def _parse_grid_files(refs: str) -> list[str]:
    """refs 隐藏 widget 值 = JSON 文件名数组（按宫格槽位顺序）；解析失败/非列表返回空。"""
    if not refs or not isinstance(refs, str):
        return []
    try:
        data = json.loads(refs)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    files = [str(x).strip() for x in data if str(x).strip()]
    return files[:GRID_MAX]


def _tensor_ref(tensor: torch.Tensor) -> dict | None:
    """把帧张量编码成 data URI reference（与 prompts._bundle_references 输出格式一致）。"""
    png = image_tensor_to_png(tensor)
    if not png:
        return None
    return {"kind": "data", "data": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}


class NeoRefGrid:
    """参考图宫格节点：宫格槽位（1~12，运行时可调）→ prompt + BUNDLE + image_1..image_12。

    - refs（隐藏 widget，JSON 文件名数组）：唯一参考图来源，槽位号 = 槽序；坏文件/缺失保留该槽空缺不补位。
    - prompt_text（隐藏 widget）：节点内提示词框内容。
    - 输出 BUNDLE 为运行时包（提示词 + 参考图 data URI），可直连 NeoImageGenEdit / NeoH3VideoDirector，
      或经 NeoBundleExpand 展开对接官方 H3 Ref2V；image_N 也可直接连线到官方节点的 ref_image_N。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "refs": ("STRING", {"default": "", "hidden": True}),                      # 前端宫格槽位（JSON 文件名数组）
                "prompt_text": ("STRING", {"multiline": True, "default": "", "hidden": True}),  # 节点内提示词
            },
        }

    RETURN_TYPES = ("STRING", "STRING") + ("IMAGE",) * GRID_MAX
    RETURN_NAMES = ("prompt", "BUNDLE") + tuple(f"image_{i}" for i in range(1, GRID_MAX + 1))
    OUTPUT_NODE = True
    FUNCTION = "pack"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "参考图宫格节点：宫格槽位（1~12，运行时可调）→ prompt + BUNDLE + image_1..image_12。"

    def pack(self, refs="", prompt_text=""):
        prompt = str(prompt_text or "")

        empty = torch.zeros((0, 1, 1, 3))
        images = [empty] * GRID_MAX
        out_refs = []   # BUNDLE references（扁平列表，坏文件跳过）
        order = []      # 执行来源标签（供节点内展示本次实际用到的参考图顺序）

        # 宫格槽位：按位置还原，坏文件/缺失保留该槽空缺
        for i, name in enumerate(_parse_grid_files(refs)):
            tensor = _reference_to_image({"kind": "input", "value": name})
            if tensor is None:
                continue
            ref = _tensor_ref(tensor)
            if ref is None:
                continue
            images[i] = tensor
            out_refs.append(ref)
            order.append(f"格{i + 1}")

        bundle_id = create_bundle({
            "prompts": [prompt],
            "references": out_refs,
            "gen_type": "",   # 运行时无法确定目标模态（图/视频），留空；消费端按自身类型处理
        })
        return {
            "ui": {"prompt": [prompt], "count": [len(out_refs)], "order": order},
            "result": tuple([prompt, bundle_id] + images),
        }


NODE_CLASS_MAPPINGS = {"NeoRefGrid": NeoRefGrid}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoRefGrid": "Neo Reference Grid (参考图宫格)"}