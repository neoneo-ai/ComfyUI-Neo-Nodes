# SPDX-License-Identifier: Apache-2.0
"""grid_split 宫格图自动切分的离线单测（纯 PIL，不依赖 ComfyUI）。

覆盖：1×N / M×N 均匀间隙检测、无间隙等分回退、纯色图整幅一格、
手动行列覆盖（含分隔条内缩）、行优先裁切顺序。"""

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
