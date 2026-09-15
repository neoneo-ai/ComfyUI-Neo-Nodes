"""H3 实时预览：用 models/vae_approx/taeh3.safetensors 把 H3 潜空间解成真彩预览图。

核心 latent_preview.get_previewer() 对 H3 只能回退 Latent2RGB —— MiniMaxH3Video 未声明
taesd_decoder_name，且 taeh3 是「96 宽 / 4 次上采样」的扁平 2D TAE，core 的 TAESD.Decoder
建不出来。这里按 checkpoint 的扁平索引重建解码器（同 ComfyUI-KJNodes tiny_vae.py 的做法）。

NeoH3VideoDirector 逐段执行期间临时替换 latent_preview.get_previewer，执行结束（含异常）
立即还原，不影响画布上其他节点的预览行为。
"""

import contextlib
import logging

import torch
import torch.nn as nn
from PIL import Image, ImageOps

import comfy.model_management
import comfy.utils
import folder_paths
import latent_preview
from comfy import latent_formats
from comfy.taesd.taesd import Block, Clamp, conv

TINY_VAE = "taeh3.safetensors"
MAX_SIDE = 1024     # 核心预览上限是 --preview-size（默认 512），这里放宽到 1024

_warned = False


def _build_decoder(sd):
    """按扁平索引重建 TAE 解码器：缺号按位置补 Clamp(0)/ReLU(2)/Upsample，其余由权重形状定。"""
    by_index = {}
    for k, v in sd.items():
        head, _, rest = k.partition(".")
        if not head.isdigit():
            raise ValueError(f"不是扁平的 TAE 解码器权重（键 '{k}' 意外）")
        by_index.setdefault(int(head), {})[rest] = v

    modules = []
    for i in range(max(by_index) + 1):
        entry = by_index.get(i)
        if entry is None:
            modules.append(Clamp() if i == 0 else nn.ReLU() if i == 2 else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in entry:
            modules.append(Block(entry["conv.0.weight"].shape[1], entry["conv.0.weight"].shape[0]))
        else:
            w = entry["weight"]
            modules.append(conv(w.shape[1], w.shape[0], bias="bias" in entry))
    return nn.Sequential(*modules)


class H3TinyVAE:
    """只做解码的 taeh3：输出 [0, 1]，与 TAE 家族约定一致。"""

    def __init__(self, sd):
        first = next(iter(sd))
        head = first.split(".")[0]
        if not head.isdigit():   # 权重可能带 "decoder." 之类公共前缀
            prefix = head + "."
            sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}

        self.device = comfy.model_management.vae_device()
        self.dtype = comfy.model_management.vae_dtype(self.device, [torch.float16, torch.bfloat16])
        self.model = _build_decoder(sd)
        self.model.load_state_dict(sd)
        self.model = self.model.to(device=self.device, dtype=self.dtype).eval()
        self.latent_channels = self.model[1].weight.shape[1]

    def decode_frame(self, latent):
        """[B, C, H, W] -> PIL RGB 图。"""
        out = self.model(latent.to(device=self.device, dtype=self.dtype))
        return latent_preview.preview_to_image(out.to(device=latent.device, dtype=torch.float32)[0].movedim(0, -1), do_scale=False)


def _video_frame(x0, channels):
    """从 H3 的 AV 潜空间里挑出 taeh3 能解的视频帧 [1, C, H, W]；不是视频流则返回 None。

    core 的 prepare_callback 已解开 nested 层（H3 的 tensors[0] 就是视频流 [B, C, T, H, W]），
    这里只按形状与通道数认视频流——音频流是 [B, 32, 2, T]，通道数对不上自然被跳过。
    """
    if x0.ndim == 5:
        x0 = x0[:1, :, 0]
    elif x0.ndim == 4:
        x0 = x0[:1]
    else:
        return None
    return x0 if x0.shape[1] == channels else None


class H3Previewer(latent_preview.LatentPreviewer):
    """H3 段预览：taeh3 真彩、单帧（首帧）、上限 MAX_SIDE。"""

    def __init__(self, vae):
        self.vae = vae

    def decode_latent_to_preview(self, x0):
        frame = _video_frame(x0, self.vae.latent_channels)
        if frame is None:
            return None
        try:
            img = self.vae.decode_frame(frame)
        except Exception as e:
            logging.warning(f"[Neo Nodes] H3 预览解码失败，本步跳过：{e}")
            return None
        if img.width > MAX_SIDE or img.height > MAX_SIDE:
            img = ImageOps.contain(img, (MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        return img

    def decode_latent_to_preview_image(self, preview_format, x0):
        # 返回 (格式, 图, 上限) 让前端按 MAX_SIDE 展示而非核心的 512
        img = self.decode_latent_to_preview(x0)
        return ("JPEG", img, MAX_SIDE) if img is not None else None


def load_h3_tiny_vae():
    """加载 taeh3；不可用时返回 None 并只提示一次（预览退回 Latent2RGB，不影响出片）。"""
    global _warned
    path = folder_paths.get_full_path("vae_approx", TINY_VAE)
    if path is None:
        if not _warned:
            _warned = True
            logging.info(f"[Neo Nodes] 未找到 models/vae_approx/{TINY_VAE}，H3 预览回退核心默认")
        return None
    try:
        return H3TinyVAE(comfy.utils.load_torch_file(path, safe_load=True))
    except Exception as e:
        if not _warned:
            _warned = True
            logging.warning(f"[Neo Nodes] {TINY_VAE} 加载失败（{e}），H3 预览回退核心默认")
        return None


def _is_h3(latent_format):
    return isinstance(latent_format, latent_formats.MiniMaxH3Video)


def _latent2rgb(latent_format):
    """按 latent format 现搭 Latent2RGB：全局预览关闭时也能给出预览图。"""
    if latent_format.latent_rgb_factors is None:
        return None
    return latent_preview.Latent2RGBPreviewer(
        latent_format.latent_rgb_factors,
        getattr(latent_format, "latent_rgb_factors_bias", None),
        getattr(latent_format, "latent_rgb_factors_reshape", None),
    )


@contextlib.contextmanager
def preview_override(enabled, vae):
    """段执行期间接管 H3 预览：关 = 完全不出；开 = taeh3 真彩（缺 taeh3 则 Latent2RGB 兜底）。

    非 H3 的 latent format 一律交还原实现；退出时（含异常）无条件还原。
    """
    original = latent_preview.get_previewer

    def overridden(device, latent_format):
        if not _is_h3(latent_format):
            return original(device, latent_format)
        if not enabled:
            return None
        return H3Previewer(vae) if vae is not None else _latent2rgb(latent_format)

    latent_preview.get_previewer = overridden
    try:
        yield
    finally:
        latent_preview.get_previewer = original