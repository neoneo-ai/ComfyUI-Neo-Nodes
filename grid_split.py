# ComfyUI-Neo-Nodes - 宫格图自动切分
# 导演台「宫格图拆分」的纯像素核心：对带分隔条 / 留白的分镜宫格图做均匀间隙检测
# （只有 1~2px 的细白分隔条靠近白占比识别），剔除无意义细条（整幅宽的标题栏 / 底部文字行 / 边缘窄条），
# 按行优先顺序裁出各格（内容边界在分隔条一侧内缩 1px：交界处那 1px 是白与画面的混色，看着仍是条边）。
# trim_cell 再逐格清理：裁掉四边白框 / 黑框（含框外那 1~2px 接缝）与底部「白底 + 文字」字幕条（其上沿同样内缩 1px），各格可直接作视频首帧。
# 另含元信息提示词解析（metadata_prompts）：宫格图内嵌的 ComfyUI 元信息里「包含的提示词」。
# 不依赖 ComfyUI（PIL，numpy 可用时加速 profile 计算），便于单测。

from __future__ import annotations

import json

try:
    import numpy as _np
except ImportError:
    _np = None

GAP_STD = 8.0            # 间隙判定：中间调行/列 std 低于此值视为均匀
GAP_MIN_PX = 4           # 间隙最小宽度（px）——要求 ≥4px 连续均匀行/列才视为分隔，避免暗色内容区误检
GAP_MEAN_HI = 190.0      # 间隙亮度上限：mean > 此值视为浅色边框（白 / 浅灰分隔条）
GAP_MEAN_LO = 40.0       # 间隙亮度下限：mean < 此值视为深色边框（黑边）；中间调内容不算间隙
LIGHT_FRAC = 0.85        # 细白分隔条回退判定：整行/列近白占比 ≥ 此值（实测条内 0.90~0.95、画面列仅 0.17~0.51）
LIGHT_MIN_PX = 1         # 细白分隔条最小宽度（px）——细白条可能只有 1~2px
LIGHT_EVEN_RATIO = 1.1   # 细白条回退的合理性：分出的格子最大/最小宽（高）≤ 此值才采用（合图按等分格）
MAX_GRID_CELLS = 12      # 单轴格数上限（与 NeoRefGrid 槽位一致，防止噪点误检）
# 元信息里算「提示词」的文本输入键：各工作流命名不一（TextEncodeQwenImage21 用 prompt、
# NeoPromptEncoder 用 text、部分节点用 positive / caption），只认像提示词的键，
# unet_name / lora_name 之类的文件名与参数不取。
PROMPT_TEXT_KEYS = ("text", "text_input", "prompt", "positive", "positive_prompt", "prompt_text", "caption", "text_g", "text_l")
DEGEN_SLIVER_FRACTION = 0.03   # 格子窄于轴长 3% → 无意义细条
DEGEN_NEIGHBOR_RATIO = 0.30    # 格子 ≤ 较大邻格的 30% → 误检分隔（标题栏 / 页脚 / 窄边）
BRIGHT_PX = 210                # 「近白」像素阈值：灰度 > 此值算亮像素（字幕条白底判定用）
CAPTION_BRIGHT_FRAC = 0.6      # 字幕条判定：行内近白像素占比高于此值视为白底行（文字只占行内少数像素）
CAPTION_SEAM_PX = 3            # 字幕条判定容忍的接缝：≤3px 非白底行（画框细线 / 抗锯齿）不打断字幕条
STROKE_PX = 180                # 「深色墨迹」阈值：灰度 < 此值算文字笔画 / 物体暗部（字幕条墨迹形态判定用）
CAPTION_MIN_STROKES = 4        # 字幕条墨迹下限：白底行深色段数中位数 ≥ 此值才算文字（白底照片上的人物 / 物体只有 1~3 段）
MIN_CAPTION_PX = 6             # 字幕条最小厚度（px）——更薄的亮边是分隔条渗色，由四边裁切处理
MAX_CAPTION_FRACTION = 0.30    # 字幕条最大厚度占格高比例——超过则视为亮色内容而非字幕
EDGE_SEAM_PX = 2               # 四边裁切：框（白边 / 黑边）外侧那 1~2px 混色 / 灰线接缝，不算框但可跳过
FRAME_LIGHT = 0.95             # 白框补判：整条近白像素占比 ≥ 此值（白框实测 0.97~1.00，白框内缘线 / 标题字让 std 偏高）
FRAME_MIN_PX = 2               # 跳过接缝后认定的框最小厚度（px）——1px 均匀线是分隔条渗色 / 画面暗线
FRAME_MAX_PX = 16              # 认定的白框最大厚度（px）——一路近白到更厚的是画面里的白底（实测白框 3~14px）


def _is_gap_row(profile_item):
    """单行/列是否为间隙候选：std 低且亮度极端（浅色或深色边框），中间调内容不算。"""
    mean, std = profile_item
    if std >= GAP_STD:
        return False
    return mean > GAP_MEAN_HI or mean < GAP_MEAN_LO


def _gap_runs(profile):
    """在行/列 profile（[(mean, std), ...]）里找所有均匀区段（含图边留白）。

    返回 [(start, end)]：连续若干行/列 std < GAP_STD 且亮度极端、宽度 ≥ GAP_MIN_PX。
    """
    runs = []
    i, n = 0, len(profile)
    while i < n:
        if not _is_gap_row(profile[i]):
            i += 1
            continue
        j = i
        while j < n and _is_gap_row(profile[j]):
            j += 1
        if j - i >= GAP_MIN_PX:
            runs.append((i, j))
        i = j
    return runs


def _light_runs(light, size):
    """近白占比 ≥ LIGHT_FRAC 的连续行/列段（细白分隔条），宽度 ≥ LIGHT_MIN_PX。

    细白分隔条两侧都是画面、条内又可能夹着字幕文字，整条 std 偏高不满足「均匀间隙」；
    但整条绝大部分像素近白，故用占比判定。仅在均匀间隙规则找不到分隔时作为回退。
    """
    runs = []
    i = 0
    while i < size:
        if light[i] < LIGHT_FRAC:
            i += 1
            continue
        j = i
        while j < size and light[j] >= LIGHT_FRAC:
            j += 1
        if j - i >= LIGHT_MIN_PX:
            runs.append((i, j))
        i = j
    return runs


def _even_sized(bounds, ratio=LIGHT_EVEN_RATIO):
    """各格宽/高是否接近等分：细白条回退只应切出等分格（宫格合图按等分格拼）。

    只找到部分细白条时会切出大小悬殊的格子，此时宁可不切（保持整幅一格）。
    """
    sizes = [e - s for s, e in bounds]
    return max(sizes) <= ratio * min(sizes)


def _bounds_from_gaps(runs, size):
    """均匀区段（间隙 / 图边）整体作为分隔：前一格止于其左缘、后一格起于右缘。

    区段与画面交界处那 1px 是白（黑）与画面的混色，std 偏高、看着仍是条边，
    故内容边界在区段一侧再内缩 1px（图边一侧没有区段，不缩）。无内容返回 ()（等分回退用）。
    """
    bounds = []
    prev = None
    for a, b in runs:
        start = 0 if prev is None else prev + 1
        if a - 1 > start:
            bounds.append((start, a - 1))
        prev = b
    if prev is None:
        return ()
    if prev + 1 < size:
        bounds.append((prev + 1, size))
    return tuple(bounds)


def _is_degenerate(bounds, i, size):
    """第 i 格是否为无意义细条：窄于轴长 3%，或 ≤ 较大邻格的 30%（误检分隔切出的窄边 / 整幅标题栏 / 页脚行）。"""
    s, e = bounds[i]
    w = e - s
    if w < DEGEN_SLIVER_FRACTION * size:
        return True
    neighbors = []
    if i > 0:
        neighbors.append(bounds[i - 1][1] - bounds[i - 1][0])
    if i + 1 < len(bounds):
        neighbors.append(bounds[i + 1][1] - bounds[i + 1][0])
    return bool(neighbors) and w <= DEGEN_NEIGHBOR_RATIO * max(neighbors)


def _clean_bounds(bounds, size):
    """剔除无意义细条：边缘细条整条丢弃（分隔留在图外）；内部细条并入前一格。循环到稳定。

    字幕条 / 标题栏都贴在上一格内容下方，并入前一格后由 trim_cell 按底边字幕条裁掉；
    并进后一格会变成格顶字幕条（trim_cell 只裁底边），那格就永远带着一条字幕。
    """
    bounds = list(bounds)
    changed = True
    while len(bounds) > 1 and changed:
        changed = False
        for i in range(len(bounds)):
            if not _is_degenerate(bounds, i, size):
                continue
            if i == 0 or i == len(bounds) - 1:
                del bounds[i]
            else:
                bounds[i - 1] = (bounds[i - 1][0], bounds[i][1])
                del bounds[i]
            changed = True   # 边界已变，从头重扫
            break
    return tuple(bounds)


def _even_bounds(count, size):
    """等分 count 格（手动行列与检出格数不一致时的回退）。"""
    step = size / count
    return tuple((int(round(i * step)), int(round((i + 1) * step))) for i in range(count))


def _cell_bounds(runs, size, manual):
    """单轴格边界：手动指定且与检出格数一致 → 用检出边界（不带边）；手动不一致 → 整幅等分；自动 → 检出（已剔细条）或整幅一格。"""
    found = _clean_bounds(_bounds_from_gaps(runs, size), size)
    if manual:
        if len(found) == manual:
            return found
        return _even_bounds(manual, size)
    return found or ((0, size),)


def detect_grid(img, rows=None, cols=None):
    """检测宫格行列并给出每格边界（行优先）。

    返回 {"rows": int, "cols": int, "row_bounds": [(s,e)...], "col_bounds": [(s,e)...]}；
    rows/cols 为手动指定（1~MAX_GRID_CELLS）；缺省由均匀间隙自动判定并剔除无意义细条，
    均匀间隙检不出时再按细白分隔条回退（只接受等分格），仍检不出则整幅一格。
    格子边界贴着分隔条内容一侧再内缩 1px（见 _bounds_from_gaps），手动行列与检出不一致时的等分回退不内缩。
    """
    w, h = img.size
    gray = img.convert("L")

    def profile(axis):   # axis=0 逐行 / axis=1 逐列 → [(mean, std), ...]
        if _np is not None:
            a = _np.frombuffer(gray.tobytes(), dtype=_np.uint8).reshape(h, w)
            return list(zip(a.mean(axis=1 - axis).tolist(), a.std(axis=1 - axis).tolist()))
        buf = gray.tobytes()   # 行优先字节流，逐行/列切片算均值与标准差
        out = []
        for i in range(h if axis == 0 else w):
            vals = buf[i * w:(i + 1) * w] if axis == 0 else buf[i::w]
            mean = sum(vals) / len(vals)
            var = sum((v - mean) ** 2 for v in vals) / len(vals)
            out.append((mean, var ** 0.5))
        return out

    def light(axis):   # axis=0 逐行 / axis=1 逐列 → 每行/列近白像素占比（细白条回退判定用）
        if _np is not None:
            a = _np.frombuffer(gray.tobytes(), dtype=_np.uint8).reshape(h, w)
            return (a > BRIGHT_PX).mean(axis=1 - axis)
        buf = gray.tobytes()
        if axis == 0:
            return [sum(1 for v in buf[y * w:(y + 1) * w] if v > BRIGHT_PX) / w for y in range(h)]
        return [sum(1 for v in buf[x::w] if v > BRIGHT_PX) / h for x in range(w)]

    def cell_bounds(axis, manual):
        """单轴格边界：均匀间隙优先，检不出整幅一格时再按细白分隔条回退（必须切出等分格）。"""
        size = h if axis == 0 else w
        found = _cell_bounds(_gap_runs(profile(axis)), size, manual)
        if manual is not None or len(found) > 1:
            return found
        thin = _cell_bounds(_light_runs(light(axis), size), size, None)
        return thin if len(thin) > 1 and _even_sized(thin) else found

    row_bounds = cell_bounds(0, rows)
    col_bounds = cell_bounds(1, cols)
    return {
        "rows": len(row_bounds),
        "cols": len(col_bounds),
        "row_bounds": row_bounds,
        "col_bounds": col_bounds,
    }


def split_image(img, grid):
    """按 detect_grid 结果裁出各格 PIL 图（行优先阅读顺序）。"""
    cells = []
    for r0, r1 in grid["row_bounds"]:
        for c0, c1 in grid["col_bounds"]:
            cells.append(img.crop((c0, r0, c1, r1)))
    return cells


def _caption_ink(buf, width, start, end, bright):
    """底部近白带（行 start..end-1）是否像「文字」：白底行的深色笔画段数中位数 ≥ CAPTION_MIN_STROKES。

    白底照片（人物 / 白底产品）底边同样大片近白，但暗部是整块（1~3 段）；字幕条是多个字的多段细笔画。
    """
    counts = []
    for y in range(start, end):
        if bright[y] <= CAPTION_BRIGHT_FRAC:
            continue      # 只统计白底行：接缝细线不算墨迹
        n, prev = 0, False
        for v in buf[y * width:(y + 1) * width]:
            dark = v < STROKE_PX
            if dark and not prev:
                n += 1
            prev = dark
        if n:
            counts.append(n)
    if not counts:
        return False
    counts.sort()
    return counts[len(counts) // 2] >= CAPTION_MIN_STROKES


def trim_cell(cell, gap_std=GAP_STD):
    """裁掉格子四周的白框 / 黑框并去除底部白底字幕条。

    用于九宫格拆分后各格作为视频首帧前的清理：
    1. 四边白框（整条近白）/ 黑框（均匀且极暗）连同框外那 1~2px 接缝一起裁掉；框很薄，更厚的近白带算画面；
    2. 底部字幕条（「白底 + 深色文字」的说明条，可含两行）整条裁掉，其上沿与画面交界处那 1px 混色一并削掉。

    返回裁剪后的 PIL Image；若无可裁区域则原样返回。
    """
    w, h = cell.size
    if w < 4 or h < 4:
        return cell

    gray = cell.convert("L")
    if _np is not None:
        a = _np.frombuffer(gray.tobytes(), dtype=_np.uint8).reshape(h, w)
        row_std = a.std(axis=1)
        col_std = a.std(axis=0)
        row_mean = a.mean(axis=1)
        col_mean = a.mean(axis=0)
        row_light = (a > BRIGHT_PX).mean(axis=1)
        col_light = (a > BRIGHT_PX).mean(axis=0)
    else:
        buf = gray.tobytes()
        row_std, row_mean, row_light = [], [], []
        for y in range(h):
            row = buf[y * w:(y + 1) * w]
            m = sum(row) / w
            row_mean.append(m)
            row_std.append((sum((v - m) ** 2 for v in row) / w) ** 0.5)
            row_light.append(sum(1 for v in row if v > BRIGHT_PX) / w)
        col_std, col_mean, col_light = [], [], []
        for x in range(w):
            col = buf[x::w]
            m = sum(col) / h
            col_mean.append(m)
            col_std.append((sum((v - m) ** 2 for v in col) / h) ** 0.5)
            col_light.append(sum(1 for v in col if v > BRIGHT_PX) / h)

    # --- Step 1: 裁掉四边白框 / 黑框（白框外的接缝与框内 1~2px 断口一并削掉）---
    def _is_uniform_frame(idx, stds, means):
        """均匀色框：std 低且亮度极端（黑框 / 纯白框），四边裁切原本的判定。"""
        return stds[idx] < gap_std and (means[idx] > GAP_MEAN_HI or means[idx] < GAP_MEAN_LO)

    def _frame_span(stds, means, light):
        """从一角向内数框的厚度（该角最外一行/列算起），返回要裁掉的像素数（0 = 该角没有框）。

        白框不是一整条连续近白：框外有 1~2px 混色接缝，框内也可能被 1~2px 接缝（抗锯齿 / 框内缘细线）
        断成几段，故按 EDGE_SEAM_PX 容忍接缝、整段一起削（白框自带轻微纹理，框内缘线 / 标题字还会让 std
        明显高于 GAP_STD，故按近白占比认）；但一路近白到 FRAME_MAX_PX 还不停的是画面里的白底 / 亮天空
        （实测白框 3~14px）。均匀色框（黑框 / 纯白框）按连续判定、不限厚度，
        只是跳过接缝后才认出的框至少 FRAME_MIN_PX 厚（1px 均匀线是分隔条渗色 / 画面暗线）。
        """
        end = missed = 0
        for k in range(min(len(stds), FRAME_MAX_PX + 1)):
            if light[k] >= FRAME_LIGHT:
                end, missed = k + 1, 0
            else:
                missed += 1
                if missed > EDGE_SEAM_PX:
                    break
        if end > FRAME_MAX_PX:
            end = 0
        i = 0
        while i < len(stds) and i < EDGE_SEAM_PX and not _is_uniform_frame(i, stds, means):
            i += 1
        j = i
        while j < len(stds) and _is_uniform_frame(j, stds, means):
            j += 1
        if j > i and (i == 0 or j - i >= FRAME_MIN_PX):
            end = max(end, j)
        return end

    top = _frame_span(row_std, row_mean, row_light)
    bottom = _frame_span(row_std[::-1], row_mean[::-1], row_light[::-1])
    left = _frame_span(col_std, col_mean, col_light)
    right = _frame_span(col_std[::-1], col_mean[::-1], col_light[::-1])
    if top + bottom >= h or left + right >= w:
        return cell
    cell = cell.crop((left, top, w - right, h - bottom))

    # --- Step 2: 检测并裁掉底部字幕条（白底 + 深色文字）---
    # 字幕条是「白底 + 深色文字」：文字让行 std 偏高，不能用「低 std」判定，改用「近白像素占比」；
    # 文字只占行内少数像素（实测各行 70%~99% 近白），故多数像素近白即视为字幕条行。
    # 条内 / 条底的 1~3px 深色细线（画框线 / 抗锯齿接缝）不打断判定，由 CAPTION_SEAM_PX 容忍。
    # 白底照片（人物 / 白底产品）底部同样大片近白，再由墨迹形态区分（_caption_ink），避免吃掉画面。
    w2, h2 = cell.size
    if h2 < 30:
        return cell

    gray2 = cell.convert("L")
    buf2 = gray2.tobytes()
    if _np is not None:
        a2 = _np.frombuffer(buf2, dtype=_np.uint8).reshape(h2, w2)
        bright = (a2 > BRIGHT_PX).mean(axis=1)      # 每行近白像素占比
    else:
        bright = [sum(1 for v in buf2[y * w2:(y + 1) * w2] if v > BRIGHT_PX) / w2 for y in range(h2)]

    # 自底向上吃连续字幕条行，允许夹带 ≤CAPTION_SEAM_PX 行非白底行（细线 / 接缝）
    start = h2
    missed = 0
    for y in range(h2 - 1, -1, -1):
        if bright[y] > CAPTION_BRIGHT_FRAC:
            start = y
            missed = 0
        else:
            missed += 1
            if missed > CAPTION_SEAM_PX:
                break
    band_h = h2 - start

    # 合理厚度 + 墨迹像文字才裁：太薄是分隔条渗色（四边裁切已处理），太厚 / 无文字是亮色画面。
    # start - 1：字幕条上沿与画面交界处那 1px 是白底混色，一并削掉。
    if MIN_CAPTION_PX <= band_h <= MAX_CAPTION_FRACTION * h2 and _caption_ink(buf2, w2, start, h2, bright):
        cell = cell.crop((0, 0, w2, start - 1))

    return cell


def _negative_only_node_ids(prompt):
    """只在 negative 输入里被连到的节点 id：这些节点的文本是负向提示词，不算宫格图包含的提示词。

    同一节点既连 positive 又连 negative 时不算（Qwen 的 TextEncodeQwenImage21 一个节点出正负两路，
    节点内另有 negative_prompt 键），否则会把该节点的正向提示词一起丢掉。
    """
    positive, negative = set(), set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        for key, bucket in (("positive", positive), ("negative", negative)):
            link = inputs.get(key)
            if isinstance(link, list) and link:
                bucket.add(str(link[0]))
    return negative - positive


def metadata_prompts(info):
    """宫格图元信息（PIL 读到的 PNG 文本块）里该图包含的正向提示词，按出现顺序去重。

    ComfyUI 保存 PNG 时把 API 格式 prompt 写进元信息，宫格图「包含的提示词」就是它。
    标准工作流里正 / 负两个文本节点的输入键相同（都叫 text），故再按 negative 连线剔掉负向节点。
    无元信息 / JSON 解析失败 / 空文本一律返回 []。
    """
    raw = (info or {}).get("prompt")
    if not isinstance(raw, str):
        return []
    try:
        prompt = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(prompt, dict):
        return []
    negative_ids = _negative_only_node_ids(prompt)
    texts = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or str(node_id) in negative_ids:
            continue
        for key, val in (node.get("inputs") or {}).items():
            if str(key).lower() not in PROMPT_TEXT_KEYS or not isinstance(val, str):
                continue
            val = val.strip()
            if val and val not in texts:
                texts.append(val)
    return texts

