# SPDX-License-Identifier: Apache-2.0
"""grid_split 宫格图自动切分的离线单测（纯 PIL，不依赖 ComfyUI）。

覆盖：1×N / M×N 均匀间隙检测、无间隙等分回退、纯色图整幅一格、
手动行列覆盖（含分隔条内缩）、行优先裁切顺序、无意义细条剔除
（整幅标题栏 / 页脚行 / 边缘窄条 / 内部误检分隔 / 夹在白行中的字幕条）、无 numpy 回退路径、
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


def make_caption_band_grid():
    """两行宫格：每行图下方一条「白底 + 文字」字幕条，条上下各留 6px 纯白行。

    纯白行自身满足均匀间隙判定，于是字幕文字行被切成独立一格；两行图像高度不等（下一行更高），
    「并入较大邻格」会把这条字幕并给下一行，下一行首帧顶部就带一条上一行的字幕。
    """
    cw, gap, cap_white, cap_text = 160, 8, 6, 20
    rh = (120, 140)
    w = 2 * cw + 3 * gap
    h = gap + sum(rh) + 2 * (2 * cap_white + cap_text) + gap
    img = Image.new("RGB", (w, h), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    y = gap
    for r in range(2):
        for c in range(2):
            x0 = gap + c * (cw + gap)
            v = 40 + (r * 2 + c) * 30
            draw.rectangle([x0, y, x0 + cw - 1, y + rh[r] - 1], fill=(v, v, v))
        y += rh[r]
        ty = y + cap_white   # 白行之后是文字：深色笔画只占行内少数像素，整行仍近白
        for x in range(gap + 10, w - gap - 10, 24):
            draw.rectangle([x, ty, x + 5, ty + cap_text - 5], fill=(0, 0, 0))
        y += 2 * cap_white + cap_text
    return img


def make_thin_separator_grid(rows, cols, cell=(60, 50), sep=2, speck=12):
    """宫格图的另一种形态：分隔条只有 sep px 白条，且条上散布深色墨点（模拟字幕文字压到条上）。

    这种条整列/行 std 偏高（不满足「均匀间隙」），只能靠近白占比识别（细白条回退）。
    """
    import random
    cw, ch = cell
    w = cols * cw + (cols - 1) * sep
    h = rows * ch + (rows - 1) * sep
    img = Image.new("RGB", (w, h), (255, 255, 255))
    rng = random.Random(5)
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * (cw + sep), r * (ch + sep)
            for y in range(y0, y0 + ch):
                for x in range(x0, x0 + cw):
                    v = rng.randint(20, 120)
                    img.putpixel((x, y), (v, v, v))
    for c in range(1, cols):   # 竖条上的墨点
        for x in range(c * cw + (c - 1) * sep, c * cw + c * sep):
            for y in range(0, h, speck):
                img.putpixel((x, y), (0, 0, 0))
    for r in range(1, rows):   # 横条上的墨点
        for y in range(r * ch + (r - 1) * sep, r * ch + r * sep):
            for x in range(0, w, speck):
                img.putpixel((x, y), (0, 0, 0))
    return img


def make_mixed_sep_grid(rows, cols, cell=(160, 120), wide=8, odd_px=3, odd_color=(255, 255, 255)):
    """贴边宫格图：横分隔条都是 wide px 白条；竖分隔条第一条特殊（odd_px 宽 / odd_color 色）。

    odd_px < GAP_MIN_PX 的细白竖条会被均匀间隙规则漏检（只能靠近白占比回退）；
    odd_color 取中间灰时两条规则都漏检，触发「以最小格为单位等分」的最终一致性兜底。
    """
    cw, ch = cell
    seps_x = [odd_px] + [wide] * (cols - 2)
    w = cols * cw + sum(seps_x)
    h = rows * ch + (rows - 1) * wide
    img = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            x0 = sum(seps_x[:c]) + c * cw
            y0 = r * (ch + wide)
            for dy in range(ch):   # 纵向渐变填充：列 / 行 profile 方差足够，不会被误判为间隙
                v = 40 + (dy * 3 + c * 17) % 180
                draw.line([(x0, y0 + dy), (x0 + cw - 1, y0 + dy)], fill=(v, v, v))
    x = cw
    draw.rectangle([x, 0, x + odd_px - 1, h - 1], fill=odd_color)   # 特殊竖条
    for c in range(2, cols):
        x = c * cw + sum(seps_x[:c]) - wide
        draw.rectangle([x, 0, x + wide - 1, h - 1], fill=(255, 255, 255))
    for r in range(1, rows):   # 横分隔条
        draw.rectangle([0, r * ch + (r - 1) * wide, w - 1, r * ch + r * wide - 1], fill=(255, 255, 255))
    return img


class DetectGridTests(unittest.TestCase):
    def test_detect_2x3(self):
        grid = _gs.detect_grid(make_grid(2, 3))
        self.assertEqual((grid["rows"], grid["cols"]), (2, 3))
        cells = _gs.split_image(make_grid(2, 3), grid)
        self.assertEqual(len(cells), 6)
        for cell in cells:   # 分隔条两侧各内缩 1px（交界处的混色像素）
            self.assertEqual(cell.size, (158, 118))

    def test_detect_1x6(self):
        grid = _gs.detect_grid(make_grid(1, 6))
        self.assertEqual((grid["rows"], grid["cols"]), (1, 6))
        self.assertEqual(len(_gs.split_image(make_grid(1, 6), grid)), 6)

    def test_detect_3x3(self):
        grid = _gs.detect_grid(make_grid(3, 3))
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))

    def test_detect_thin_white_separators(self):
        """分隔条只有 2px 白条、条上带墨点时按近白占比找出等分宫格（细白条回退）。"""
        img = make_thin_separator_grid(3, 3)
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))
        sizes = [cell.size for cell in _gs.split_image(img, grid)]
        # 60x50 的内容：两侧贴分隔条的格子各内缩 1px，贴图边的少 1px
        self.assertEqual(sorted({w for w, _ in sizes}), [58, 59])
        self.assertEqual(sorted({h for _, h in sizes}), [48, 49])

    def test_missed_thin_separator_recovered_by_light_fallback(self):
        """一条竖分隔条只有 3px（低于 GAP_MIN_PX）被均匀间隙漏检 → 大小悬殊不采用，细白条回退切出等分格。"""
        img = make_mixed_sep_grid(1, 3, odd_px=3)
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (1, 3))
        widths = [c.width for c in _gs.split_image(img, grid)]
        self.assertLessEqual(max(widths) - min(widths), 4)   # 各列宽接近等分，无合并格

    def test_undetected_separator_final_even_split_fallback(self):
        """竖分隔条是中间细灰条（间隙 / 近白两条规则都漏检）→ 最终大小一致性校验按最小格等分。"""
        img = make_mixed_sep_grid(1, 3, odd_px=6, odd_color=(150, 150, 150))
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (1, 3))
        widths = [c.width for c in _gs.split_image(img, grid)]
        self.assertLessEqual(max(widths) - min(widths), 2)   # 整幅三等分


    def test_thin_bright_bar_in_content_not_split(self):
        """画面内一条 2px 亮竖线切出的格子大小悬殊 → 不当作分隔条，保持整幅一格。"""
        img = make_thin_separator_grid(1, 1, cell=(120, 100))
        draw = ImageDraw.Draw(img)
        for y in range(100):
            draw.line([(40, y), (41, y)], fill=(255, 255, 255))   # 全高亮竖线（近白占比高）
        for y in range(0, 100, 8):
            draw.line([(40, y), (41, y)], fill=(0, 0, 0))         # 墨点：整列 std 偏高
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (1, 1))

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
        for cell in cells:   # 与检出一致 → 直接用内容边界（分隔条旁各内缩 1px）
            self.assertEqual(cell.size, (158, 118))

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
            self.assertEqual(cell.size, (158, 118))

    def test_manual_match_on_stripped_grid(self):
        # 手动行列与剔除细条后的检出一致 → 用检出边界（不带边）
        img = make_grid_with_strips()
        grid = _gs.detect_grid(img, rows=3, cols=3)
        self.assertEqual((grid["rows"], grid["cols"]), (3, 3))
        self.assertEqual(len(_gs.split_image(img, grid)), 9)

    def test_caption_band_between_rows_joins_previous(self):
        """字幕条上下各有纯白行（文字行自成「一格」）→ 并给上一行，下一行首帧不从字幕条起。"""
        img = make_caption_band_grid()
        grid = _gs.detect_grid(img)
        self.assertEqual((grid["rows"], grid["cols"]), (2, 2))
        self.assertEqual(grid["row_bounds"], ((9, 149), (161, 299)))   # 第二行起于画面而非字幕条
        cells = [_gs.trim_cell(c) for c in _gs.split_image(img, grid)]
        # 每格只剩画面：上一行的字幕条随上一行被 trim_cell 裁掉，末行底部的字幕条整条丢弃
        self.assertEqual([cell.size for cell in cells], [(158, 118)] * 2 + [(158, 138)] * 2)

    def test_clean_bounds_drops_edge_slivers(self):
        self.assertEqual(_gs._clean_bounds(((0, 24), (32, 152), (160, 280)), 436), ((32, 152), (160, 280)))

    def test_clean_bounds_merges_interior_sliver(self):
        # 内部误检分隔切出的细条 → 并入前一格（字幕条 / 标题栏都贴在上一格内容下方）
        self.assertEqual(_gs._clean_bounds(((0, 200), (210, 230), (240, 500)), 500), ((0, 230), (240, 500)))

    def test_clean_bounds_keeps_even_grid(self):
        self.assertEqual(_gs._clean_bounds(((0, 100), (100, 200), (200, 300)), 300), ((0, 100), (100, 200), (200, 300)))

    def test_bounds_inset_by_separator(self):
        # 分隔条两侧各内缩 1px（交界处那 1px 是白与画面的混色）；图边一侧没有分隔条 → 不缩
        self.assertEqual(_gs._bounds_from_gaps(((0, 8), (168, 176), (336, 344), (504, 512)), 512),
                         ((9, 167), (177, 335), (345, 503)))
        self.assertEqual(_gs._bounds_from_gaps(((917, 945),), 1000), ((0, 916), (946, 1000)))

    def test_bounds_from_gaps_empty(self):
        self.assertEqual(_gs._bounds_from_gaps((), 500), ())
        self.assertEqual(_gs._bounds_from_gaps(((0, 500),), 500), ())

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


class TrimCellTests(unittest.TestCase):
    """trim_cell 格子边框 / 底部字幕条裁切。"""

    def _noisy_rect(self, w, h, seed=42):
        """生成高方差噪声图（模拟真实照片内容）。"""
        import random
        rng = random.Random(seed)
        img = Image.new("RGB", (w, h))
        for y in range(h):
            for x in range(w):
                img.putpixel((x, y), (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)))
        return img

    def test_trims_white_borders(self):
        """四边均匀白边被裁掉。"""
        cw, ch, border = 100, 80, 10
        content = self._noisy_rect(cw, ch)
        img = Image.new("RGB", (cw + 2 * border, ch + 2 * border), (255, 255, 255))
        img.paste(content, (border, border))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (cw, ch))

    def test_trims_black_borders(self):
        """黑边也能裁掉。"""
        cw, ch, border = 60, 50, 8
        content = self._noisy_rect(cw, ch, seed=7)
        img = Image.new("RGB", (cw + 2 * border, ch + 2 * border), (0, 0, 0))
        img.paste(content, (border, border))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (cw, ch))

    def _framed_cell(self, cw, ch, frame, seed=41):
        """画面 + 四边白框：框外 1px 混色接缝（框与画面外沿的接缝），左框内藏一小块深色（模拟标题字）。"""
        img = Image.new("RGB", (cw + 2 * frame + 2, ch + 2 * frame + 2), (250, 250, 250))
        img.paste(self._noisy_rect(cw, ch, seed=seed), (frame + 1, frame + 1))
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, img.width - 1, 0], fill=(105, 105, 105))
        draw.rectangle([0, img.height - 1, img.width - 1, img.height - 1], fill=(105, 105, 105))
        draw.rectangle([0, 0, 0, img.height - 1], fill=(105, 105, 105))
        draw.rectangle([img.width - 1, 0, img.width - 1, img.height - 1], fill=(105, 105, 105))
        draw.rectangle([2, frame + 2, 5, frame + 5], fill=(20, 20, 20))
        return img

    def test_trims_white_frame_behind_outer_seam(self):
        """白框外有 1px 混色接缝、框内还有标题字（让框列 std 高于 GAP_STD）时仍整段裁掉。"""
        cw, ch, frame = 240, 160, 6
        trimmed = _gs.trim_cell(self._framed_cell(cw, ch, frame))
        self.assertEqual(trimmed.size, (cw, ch))

    def test_uniform_line_behind_seam_not_trimmed(self):
        """混色接缝之后只有 1px 均匀暗线（分隔条渗色 / 画面暗线）→ 不裁。"""
        cw, ch = 120, 90
        img = Image.new("RGB", (cw, ch + 2), (105, 105, 105))
        img.paste(self._noisy_rect(cw, ch, seed=61), (0, 2))
        ImageDraw.Draw(img).rectangle([0, 1, cw - 1, 1], fill=(20, 20, 20))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (cw, ch + 2))

    def test_thick_bright_side_band_not_trimmed(self):
        """一侧直到 FRAME_MAX_PX 仍是近白（有纹理）的厚亮带是画面白底（不是框）→ 不裁。"""
        import random
        cw, ch, band = 140, 90, _gs.FRAME_MAX_PX + 4
        rng = random.Random(3)
        img = Image.new("RGB", (cw + band, ch))
        for y in range(ch):
            for x in range(band):          # 左：近白但有纹理（亮色画面）
                img.putpixel((x, y), (rng.randint(215, 255),) * 3)
            for x in range(band, cw + band):
                img.putpixel((x, y), (rng.randint(0, 255),) * 3)
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (cw + band, ch))

    def test_trims_bottom_caption(self):
        """底部白底字幕条（含文字）被裁掉：文字让行 std 偏高，仍按近白像素占比识别。"""
        cw, ch, cap_h = 120, 140, 30
        content = self._noisy_rect(cw, ch, seed=99)
        img = Image.new("RGB", (cw, ch + cap_h), (255, 255, 255))
        img.paste(content, (0, 0))
        # 字幕条：白底 + 深色文字（文字约占行宽 20%，真实字幕条 ≥70% 近白）
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for x in range(10, cw - 10, 20):
            draw.rectangle([x, ch + 12, x + 4, ch + cap_h - 5], fill=(0, 0, 0))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size[0], cw)
        # 字幕条被裁掉：高度回到内容高（±1px）
        self.assertLessEqual(trimmed.size[1], ch + 1)

    def test_caption_with_dense_text(self):
        """字幕条文字较密（行 std 明显高于均匀白底）仍按近白占比裁掉。"""
        cw, ch, cap_h = 160, 120, 34
        content = self._noisy_rect(cw, ch, seed=7)
        img = Image.new("RGB", (cw, ch + cap_h), (255, 255, 255))
        img.paste(content, (0, 0))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        # 较密文字：占行宽约 28%（近白占比 72%，与真实九宫格图最密的一行相当）
        for x in range(6, cw - 6, 10):
            draw.rectangle([x, ch + 14, x + 2, ch + cap_h - 6], fill=(0, 0, 0))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size[0], cw)
        self.assertLessEqual(trimmed.size[1], ch + 2)

    def test_trims_caption_with_bottom_seam_line(self):
        """字幕条下方有 2px 深色细线（画框线）时仍整条裁掉——真实九宫格图的实际形态。"""
        cw, ch, cap_h, seam = 140, 130, 40, 2
        content = self._noisy_rect(cw, ch, seed=11)
        img = Image.new("RGB", (cw, ch + cap_h), (255, 255, 255))
        img.paste(content, (0, 0))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for x in range(14, cw - 14, 22):
            draw.rectangle([x, ch + 16, x + 4, ch + cap_h - 16], fill=(0, 0, 0))
        for y in range(ch + cap_h - seam, ch + cap_h):
            draw.line([(0, y), (cw - 1, y)], fill=(120, 120, 120))
        trimmed = _gs.trim_cell(img)
        self.assertLessEqual(trimmed.size[1], ch + 1)

    def test_trims_caption_with_inner_seam_line(self):
        """字幕条内部夹 2px 深色细线不打断判定（细线上下都是文字 / 白底）。"""
        cw, ch, cap_h = 140, 130, 44
        content = self._noisy_rect(cw, ch, seed=13)
        img = Image.new("RGB", (cw, ch + cap_h), (255, 255, 255))
        img.paste(content, (0, 0))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for x in range(14, cw - 14, 22):
            draw.rectangle([x, ch + 8, x + 4, ch + cap_h - 20], fill=(0, 0, 0))
            draw.rectangle([x, ch + cap_h - 16, x + 4, ch + cap_h - 6], fill=(0, 0, 0))
        for y in range(ch + cap_h - 19, ch + cap_h - 17):
            draw.line([(0, y), (cw - 1, y)], fill=(120, 120, 120))
        trimmed = _gs.trim_cell(img)
        self.assertLessEqual(trimmed.size[1], ch + 1)

    def test_bottom_seam_without_caption_not_trimmed(self):
        """内容底部只有 2px 深色细线、其上无字幕条 → 不裁（接缝容忍不得吃掉画面）。"""
        cw, ch = 100, 100
        img = self._noisy_rect(cw, ch, seed=17)
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for y in (ch - 2, ch - 1):
            draw.line([(0, y), (cw - 1, y)], fill=(120, 120, 120))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (cw, ch))

    def test_bright_content_bottom_not_overtrimmed(self):
        """底部大片亮色内容（近白但有纹理、厚度超字幕条上限）→ 不当作字幕裁掉。"""
        import random
        cw, ch = 80, 160
        rng = random.Random(3)
        canvas = Image.new("RGB", (cw, ch))
        for y in range(ch // 2):   # 上部：普通噪声内容
            for x in range(cw):
                canvas.putpixel((x, y), (rng.randint(0, 255),) * 3)
        for y in range(ch // 2, ch):   # 下部（> MAX_CAPTION_FRACTION）：近白但有纹理（std > GAP_STD）
            for x in range(cw):
                canvas.putpixel((x, y), (rng.randint(215, 255),) * 3)
        trimmed = _gs.trim_cell(canvas)
        self.assertGreaterEqual(trimmed.size[1], ch - 8)   # 亮色内容区未被当字幕裁掉

    def test_white_background_subject_bottom_not_trimmed(self):
        """白底照片（人物 / 白底产品）底部的大片近白不是字幕条：墨迹是整块暗部而非多段文字笔画。"""
        cw, ch = 160, 200
        img = Image.new("RGB", (cw, ch), (255, 255, 255))
        img.paste(self._noisy_rect(cw, 150, seed=23), (0, 0))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for x0 in (45, 95):      # 两条腿：各 25px 宽的整块暗部，白底占比仍 > CAPTION_BRIGHT_FRAC
            draw.rectangle([x0, 150, x0 + 24, ch - 10], fill=(30, 30, 30))
        trimmed = _gs.trim_cell(img)
        # 只可能被 Step 1 裁掉底部纯白行；整块带（50px）绝不能被当字幕裁掉
        self.assertGreaterEqual(trimmed.size[1], ch - 10)

    def test_caption_top_edge_inset(self):
        """字幕条上沿与画面交界处那 1px 混色随字幕条一并削掉（画面本身不动）。"""
        cw, ch, cap_h = 120, 130, 30
        img = Image.new("RGB", (cw, ch + 1 + cap_h), (255, 255, 255))
        img.paste(self._noisy_rect(cw, ch, seed=5), (0, 0))
        for x in range(cw):         # 字幕条上方的混色行
            r, g, b = img.getpixel((x, ch - 1))
            img.putpixel((x, ch), tuple(round(0.65 * 255 + 0.35 * c) for c in (r, g, b)))
        for x in range(10, cw - 10, 20):
            for y in range(ch + 8, ch + 1 + cap_h - 6):
                img.putpixel((x, y), (0, 0, 0))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size[1], ch)     # 字幕条与混色行都裁掉
        self.assertEqual(trimmed.crop((0, ch - 1, cw, ch)).tobytes(),
                         img.crop((0, ch - 1, cw, ch)).tobytes())   # 底部是画面而非混色行

    def test_caption_trim_without_numpy(self):
        """无 numpy 时（纯 Python 近白占比回退）给出同样结果。"""
        cw, ch, cap_h = 120, 140, 30
        img = Image.new("RGB", (cw, ch + cap_h), (255, 255, 255))
        img.paste(self._noisy_rect(cw, ch, seed=31), (0, 0))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        for x in range(10, cw - 10, 20):
            draw.rectangle([x, ch + 12, x + 4, ch + cap_h - 5], fill=(0, 0, 0))
        ref = _gs.trim_cell(img)
        saved = _gs._np
        _gs._np = None
        try:
            got = _gs.trim_cell(img)
        finally:
            _gs._np = saved
        self.assertEqual(got.size, ref.size)

    def test_no_trim_on_pure_content(self):
        """整格高方差内容（无边框、无字幕条）→ 原样返回。"""
        img = self._noisy_rect(80, 60, seed=99)
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (80, 60))

    def test_uniform_image_unchanged(self):
        """纯色图（无内容）→ 原样返回不报错。"""
        img = Image.new("RGB", (50, 40), (200, 200, 200))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (50, 40))

    def test_small_image_unchanged(self):
        """极小图（<4px）→ 原样返回。"""
        img = Image.new("RGB", (3, 3), (128, 128, 128))
        trimmed = _gs.trim_cell(img)
        self.assertEqual(trimmed.size, (3, 3))

    def test_mid_tone_border_not_trimmed(self):
        """中间调均匀区域（mean 40~190）不当作边框裁掉。"""
        # 模拟暗色场景：四周是 mean=80 的均匀灰（不是白边也不是黑边）
        cw, ch, border = 60, 50, 10
        content = self._noisy_rect(cw, ch, seed=5)
        img = Image.new("RGB", (cw + 2 * border, ch + 2 * border), (80, 80, 80))
        img.paste(content, (border, border))
        trimmed = _gs.trim_cell(img)
        # mean=80 不在极端范围（>190 或 <40）→ 不应被裁
        self.assertEqual(trimmed.size, (cw + 2 * border, ch + 2 * border))


class DarkSceneFalsePositiveTests(unittest.TestCase):
    """验证暗色内容区不被误检为间隙（S03 特写场景）。"""

    def test_dark_uniform_band_not_split(self):
        """大面积均匀暗色区域（mean<40, std<8）但中间调过渡带不触发误切。

        模拟：顶部有变化内容 → 中间一大块纯黑 → 底部白字幕条。
        旧逻辑会把纯黑区当间隙切成多行；新逻辑因 GAP_MIN_PX=4 + mean filter，
        纯黑区（mean<40）仍会被识别为间隙，但实际照片中暗区有噪声(std>8)不会触发。
        这里验证：带少量噪声的暗色区域（std略高于阈值）不被误切。"""
        import random
        w, h = 400, 600
        img = Image.new("RGB", (w, h), (20, 20, 25))
        rng = random.Random(42)
        # 上部：有变化的内容（人脸/背景）
        for y in range(0, 200):
            for x in range(w):
                v = rng.randint(40, 180)
                img.putpixel((x, y), (v, v - 5, v - 10))
        # 中部：暗色但有噪声（模拟真实照片的暗区，std ~10-15 > GAP_STD=8）
        for y in range(200, 450):
            for x in range(w):
                v = rng.randint(10, 50)   # std ≈ 11.5 > 8 → 不算间隙
                img.putpixel((x, y), (v, v, v + 2))
        # 底部：白字幕条
        for y in range(550, 600):
            for x in range(w):
                img.putpixel((x, y), (255, 255, 255))
        for x in range(20, 200, 8):
            for y in range(560, 590):
                img.putpixel((x, y), (0, 0, 0))

        grid = _gs.detect_grid(img)
        # 不应被切成多行（暗色噪声区 std>8 不算间隙）
        self.assertEqual(grid["rows"], 1, f"Expected 1 row, got {grid['rows']}")


if __name__ == "__main__":
    unittest.main()
