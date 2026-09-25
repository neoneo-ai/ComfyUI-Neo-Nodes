# SPDX-License-Identifier: Apache-2.0
"""grid_split 宫格图自动切分的离线单测（纯 PIL，不依赖 ComfyUI）。

覆盖：1×N / M×N 均匀间隙检测、无间隙等分回退、纯色图整幅一格、
手动行列覆盖（含分隔条内缩）、行优先裁切顺序、无意义细条剔除
（整幅标题栏 / 页脚行 / 边缘窄条 / 内部误检分隔）、无 numpy 回退路径、
原宫格图元信息里的提示词提取（正向键 / 负向剔除 / 去重 / 无元信息）。"""

import importlib.util
import json
import os
import unittest

from PIL import Image, ImageDraw

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("neo_grid_split", os.path.join(PLUGIN_DIR, "grid_split.py"))
_gs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gs)


def make_grid(rows, cols, cell=(160, 120), gap=8, bg=(255, 255, 255)):
    """拼一张带均匀白边的宫格图：每格用不同纯色填充（保证行/列 profile 有方差）。"""
    cw, ch = cell
    w = cols * cw + (cols + 1) * gap
    h = rows * ch + (rows + 1) * gap
    img = Image.new("RGB", (w, h), bg)
    draw = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            color = ((r * cols + c) * 37 % 200 + 20, (r * 13 + 40) % 200, (c * 53 + 60) % 200)
            x0 = gap + c * (cw + gap)
            y0 = gap + r * (ch + gap)
            draw.rectangle([x0, y0, x0 + cw - 1, y0 + ch - 1], fill=color)
    return img


def make_grid_with_strips():
    """3×3 宫格 + 顶部整幅标题栏 / 底部页脚行（竖条内容）+ 左缘 2px 非均匀窄条。

    标题栏 / 页脚行的行 profile 有方差（模拟文字内容），会被误检成「一行格子」；
    左缘窄条的列 profile 有方差，会切出 2px 宽的无意义细条。"""
    cw, ch, gap = 160, 120, 8
    sliver_w, left_margin = 2, 16
    top_h, bot_h = 24, 20
    w = sliver_w + left_margin + 3 * cw + 4 * gap   # 530
    h = top_h + gap + 3 * ch + 2 * gap + gap + bot_h   # 436
    img = Image.new("RGB", (w, h), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    x0 = sliver_w + left_margin
    y0 = top_h + gap
    for r in range(3):
        for c in range(3):
            v = 30 + (r * 3 + c) * 25
            draw.rectangle([x0 + c * (cw + gap), y0 + r * (ch + gap),
                            x0 + c * (cw + gap) + cw - 1, y0 + r * (ch + gap) + ch - 1], fill=(v, v, v))
    # 标题栏 / 页脚：每格列区域铺深色块（行 profile 有方差模拟文字内容；间隙 / 留白列保持均匀）
    for y0s, hgt in ((0, top_h), (h - bot_h, bot_h)):
        for c in range(3):
            draw.rectangle([x0 + c * (cw + gap), y0s, x0 + c * (cw + gap) + cw - 1, y0s + hgt - 1], fill=(30, 30, 30))
    for y in range(h):   # 窄条取浅灰渐变：列 profile 有方差，但对白间隙行的 std 影响 < GAP_STD
        v = 200 + (y % 40)
        draw.point((0, y), fill=(v, v, v))
        draw.point((1, y), fill=(239 - (y % 40),) * 3)
    return img


class DetectGridTests(unittest.TestCase):
    def test_detect_2x3(self):
        grid = _gs.detect_grid(make_grid(2, 3))
        self.assertEqual((grid["rows"], grid["cols"]), (2, 3))
        cells = _gs.split_image(make_grid(2, 3), grid)
        self.assertEqual(len(cells), 6)
        for cell in cells:
            self.assertEqual(cell.size, (160, 120))

    def test_detect_1x6(self):
        grid = _gs.detect_grid(make_grid(1, 6))
        self.assertEqual((grid["rows"], grid["cols"]), (1, 6))
        self.assertEqual(len(_gs.split_image(make_grid(1, 6), grid)), 6)

    def test_detect_3x3(self):
        grid = _gs.detect_grid(make_grid(3, 3))
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))

    def test_no_gap_single_cell(self):
        img = Image.new("RGB", (320, 240), (10, 200, 90))
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (1, 1))
        cells = _gs.split_image(img, grid)
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0].size, img.size)

    def test_pure_color_image_single_cell(self):
        img = Image.new("RGB", (320, 240), (255, 255, 255))
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (1, 1))

    def test_manual_override_no_gap(self):
        img = Image.new("RGB", (300, 200), (80, 40, 160))
        grid = _gs.detect_grid(img, rows=2, cols=3)
        self.assertEqual((grid["rows"], grid["cols"]), (2, 3))
        cells = _gs.split_image(img, grid)
        self.assertEqual(len(cells), 6)
        for cell in cells:
            self.assertIn(cell.size[0], (99, 100, 101))   # 300/3 等分（四舍五入）
            self.assertEqual(cell.size[1], 100)

    def test_manual_match_uses_detected_bounds(self):
        img = make_grid(2, 3, gap=8)
        grid = _gs.detect_grid(img, rows=2, cols=3)
        cells = _gs.split_image(img, grid)
        self.assertEqual(len(cells), 6)
        for cell in cells:   # 与检出一致 → 直接用内容边界，格子不带边
            self.assertEqual(cell.size, (160, 120))

    def test_manual_mismatch_even_split(self):
        img = make_grid(2, 3, gap=8)
        grid = _gs.detect_grid(img, rows=4, cols=3)   # 行数与检出（2）不一致 → 行等分、列用检出
        self.assertEqual((grid["rows"], grid["cols"]), (4, 3))
        self.assertEqual(len(_gs.split_image(img, grid)), 12)

    def test_split_row_major_order(self):
        img = make_grid(2, 3, gap=8)
        grid = _gs.detect_grid(img)
        cells = _gs.split_image(img, grid)
        draw_colors = []
        for r in range(2):
            for c in range(3):
                x0 = 8 + c * (160 + 8)
                y0 = 8 + r * (120 + 8)
                draw_colors.append(img.getpixel((x0 + 5, y0 + 5)))
        for i, cell in enumerate(cells):
            self.assertEqual(cell.getpixel((5, 5)), draw_colors[i])


    def test_edge_strips_dropped(self):
        # 顶部标题栏 / 底部页脚行 / 左缘 2px 窄条都是误检 → 剔除后仍是干净的 3×3
        img = make_grid_with_strips()
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))
        cells = _gs.split_image(img, grid)
        self.assertEqual(len(cells), 9)
        for cell in cells:
            self.assertEqual(cell.size, (160, 120))

    def test_manual_match_on_stripped_grid(self):
        # 手动行列与剔除细条后的检出一致 → 用检出边界（不带边）
        img = make_grid_with_strips()
        grid = _gs.detect_grid(img, rows=3, cols=3)
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))
        self.assertEqual(len(_gs.split_image(img, grid)), 9)

    def test_clean_bounds_drops_edge_slivers(self):
        self.assertEqual(_gs._clean_bounds(((0, 24), (32, 152), (160, 280)), 436), ((32, 152), (160, 280)))

    def test_clean_bounds_merges_interior_sliver(self):
        # 内部误检分隔切出的细条 → 并入较大邻格（吸收其间分隔）
        self.assertEqual(_gs._clean_bounds(((0, 200), (210, 230), (240, 500)), 500), ((0, 200), (210, 500)))

    def test_clean_bounds_keeps_even_grid(self):
        self.assertEqual(_gs._clean_bounds(((0, 100), (100, 200), (200, 300)), 300), ((0, 100), (100, 200), (200, 300)))

    def test_fallback_without_numpy(self):
        img = make_grid(2, 3)
        ref = _gs.detect_grid(img)
        saved = _gs._np
        _gs._np = None
        try:
            got = _gs.detect_grid(img)
        finally:
            _gs._np = saved
        self.assertEqual(got, ref)


class MetadataPromptsTests(unittest.TestCase):
    """原宫格图元信息里的提示词提取（宫格图「包含的提示词」）。"""

    def test_collects_positive_text_keys(self):
        # 文本输入的键随工作流不同：TextEncodeQwenImage21 用 prompt、NeoPromptEncoder 用 text
        info = {"prompt": json.dumps({
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "Qwen\\qwen_image_2.1_int8.safetensors"}},
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "一张 3×3 九宫格分镜故事板"}},
            "7": {"class_type": "NeoPromptEncoder", "inputs": {"text": "美女跳起中国舞"}},
            "9": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b.safetensors"}},
        })}
        self.assertEqual(_gs.metadata_prompts(info), ["一张 3×3 九宫格分镜故事板", "美女跳起中国舞"])

    def test_negative_node_excluded(self):
        # 正负两个文本节点键名相同（都叫 text）→ 按 negative 连线剔掉负向节点
        info = {"prompt": json.dumps({
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "模糊、低质量"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "海边白色连衣裙"}},
            "5": {"class_type": "KSampler", "inputs": {"positive": ["4", 0], "negative": ["3", 0], "steps": 20}},
        })}
        self.assertEqual(_gs.metadata_prompts(info), ["海边白色连衣裙"])

    def test_shared_node_keeps_positive(self):
        # Qwen 的 TextEncodeQwenImage21：同一节点出正负两路（negative 也连它）→ 正向提示词不能被误剔
        info = {"prompt": json.dumps({
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "九宫格分镜", "negative_prompt": "低质量"}},
            "6": {"class_type": "KSampler", "inputs": {"positive": ["4", 0], "negative": ["4", 1]}},
        })}
        self.assertEqual(_gs.metadata_prompts(info), ["九宫格分镜"])

    def test_dedupes_and_strips(self):
        info = {"prompt": json.dumps({
            "1": {"class_type": "A", "inputs": {"prompt": "  同一句话  "}},
            "2": {"class_type": "B", "inputs": {"text": "同一句话"}},
            "3": {"class_type": "C", "inputs": {"prompt": "   "}},
        })}
        self.assertEqual(_gs.metadata_prompts(info), ["同一句话"])

    def test_missing_or_broken_metadata(self):
        self.assertEqual(_gs.metadata_prompts({}), [])
        self.assertEqual(_gs.metadata_prompts(None), [])
        self.assertEqual(_gs.metadata_prompts({"prompt": "not-json"}), [])
        self.assertEqual(_gs.metadata_prompts({"prompt": json.dumps(["list-not-dict"])}), [])
        self.assertEqual(_gs.metadata_prompts({"workflow": json.dumps({"nodes": []})}), [])


if __name__ == "__main__":
    unittest.main()
