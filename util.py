# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — low-level media helpers shared by gallery / lora / recipes.
# Leaf module: depends only on the standard library, so it can be imported
# anywhere without risking an import cycle with the gallery route modules.

from __future__ import annotations

import json
from pathlib import Path

# ---------------------------------------------------------------------------
# Media extensions
# ---------------------------------------------------------------------------
IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS


def _has_media_recursive(directory: Path) -> bool:
    """Return True if any media file exists anywhere under directory.

    Stops as soon as the first media file is found, so deeply nested trees
    are not scanned in full just to derive a count that callers only use
    as a has-content flag.
    """
    for p in directory.rglob("*"):
        if p.is_file() and p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            return True
    return False


def _has_media_in_dir_any(dir_path: Path) -> bool:
    """Check if a directory contains any media files (images OR videos) directly."""
    for p in dir_path.iterdir():
        if p.is_file() and p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            return True
    return False


def _extract_media_metadata(path: Path) -> dict:
    """Read ComfyUI metadata embedded by Civitai example media: PNG tEXt chunks
    and MP4 udta/ilst ©cmt (written by VHS_VideoCombine save_metadata)."""
    try:
        data = path.read_bytes()
    except OSError:
        return {}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        texts = {}
        off = 8
        while off + 12 <= len(data):
            size = int.from_bytes(data[off:off + 4], "big")
            if size <= 0 or off + 12 + size > len(data):
                break
            ctype = data[off + 4:off + 8]
            if ctype == b"tEXt":
                key, _, val = data[off + 8:off + 8 + size].partition(b"\x00")
                texts[key.decode("latin1", "replace")] = val.decode("utf-8", "replace")
            elif ctype == b"IDAT":
                break
            off += 12 + size
        return texts
    if data[4:8] == b"ftyp":
        i = data.find(b"ilst")
        if i > 0:
            seg = data[i + 4:i + 4_000_000]
            pos = 0
            result = {}
            while pos < len(seg) - 8:
                size = int.from_bytes(seg[pos:pos + 4], "big")
                if size < 8 or pos + size > len(seg):
                    break
                body = seg[pos + 8:pos + size]
                d = body.find(b"data")
                if d >= 0:
                    brace = body.find(b"{", d + 8)
                    if brace >= 0:
                        raw = body[brace:]
                        try:
                            parsed = json.loads(raw.decode("utf-8", "replace"))
                        except ValueError:
                            end = raw.rfind(b"}")
                            try:
                                parsed = json.loads(raw[:end + 1].decode("utf-8", "replace"))
                            except ValueError:
                                parsed = None
                        if isinstance(parsed, dict):
                            if "prompt" in parsed or "workflow" in parsed:
                                return parsed
                            if "nodes" in parsed and "links" in parsed:
                                result.setdefault("workflow", parsed)
                            elif parsed and all(
                                isinstance(v, dict) and "class_type" in v for v in parsed.values()
                            ):
                                result.setdefault("prompt", parsed)
                pos += size
            return result
    return {}


def _collect_prompt_texts(prompt: dict) -> dict:
    positive, negative, params = [], [], {}
    for node in (prompt or {}).values():
        if not isinstance(node, dict):
            continue
        for k, v in node.get("inputs", {}).items():
            if isinstance(v, str) and k in (
                "text", "positive_prompt", "negative_prompt", "text_g", "text_l", "caption",
            ):
                (negative if "negative" in k else positive).append(v)
            elif k in ("steps", "cfg", "seed", "width", "height", "length", "num_frames", "frame_rate") \
                    and isinstance(v, (int, float)) and k not in params:
                params[k] = v
    return {"positive": positive, "negative": negative, "params": params}
