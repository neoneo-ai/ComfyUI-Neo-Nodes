# ComfyUI-Neo-Nodes - 宫格图自动切分
# 导演台「宫格图拆分」的纯像素核心：对带分隔条 / 留白的分镜宫格图做均匀间隙检测，
# 按行优先顺序裁出各格。不依赖 ComfyUI（PIL only），便于单测。

from __future__ import annotations

GAP_STD = 8.0        # 间隙判定：该行/列像素标准差低于此值视为均匀（白边 / 黑边 / 纯色分隔条）
GAP_MIN_PX = 2       # 间隙最小宽度（px）
MAX_GRID_CELLS = 12  # 单轴格数上限（与 NeoRefGrid 槽位一致，防止噪点误检）


def _gap_runs(profile):
    """在行/列 profile（[(mean, std), ...]）里找所有均匀区段（含图边留白）。

    返回 [(start, end)]：连续若干行/列 std < GAP_STD、宽度 ≥ GAP_MIN_PX。
    """
    runs = []
    i, n = 0, len(profile)
    while i < n:
        if profile[i][1] >= GAP_STD:
            i += 1
            continue
        j = i
        while j < n and profile[j][1] < GAP_STD:
            j += 1
        if j - i >= GAP_MIN_PX:
            runs.append((i, j))
        i = j
    return runs


def _bounds_from_gaps(runs, size):
    """均匀区段（间隙 / 图边）整体作为分隔：前一格止于其左缘、后一格起于右缘 → 格子不带边。无内容返回 ()（等分回退用）。"""
    bounds = []
    prev_end = 0
    for a, b in runs:
        if a > prev_end:
            bounds.append((prev_end, a))
        prev_end = b
    if prev_end < size:
        bounds.append((prev_end, size))
    return tuple(bounds)


def _even_bounds(count, size):
    """等分 count 格（手动行列与检出格数不一致时的回退）。"""
    step = size / count
    return tuple((int(round(i * step)), int(round((i + 1) * step))) for i in range(count))


def _cell_bounds(runs, size, manual):
    """单轴格边界：手动指定且与检出格数一致 → 用检出边界（不带边）；手动不一致 → 整幅等分；自动 → 检出或整幅一格。"""
    found = _bounds_from_gaps(runs, size)
    if manual:
        if len(found) == manual:
            return found
        return _even_bounds(manual, size)
    return found or ((0, size),)


def detect_grid(img, rows=None, cols=None):
    """检测宫格行列并给出每格边界（行优先）。

    返回 {"rows": int, "cols": int, "row_bounds": [(s,e)...], "col_bounds": [(s,e)...]}；
    rows/cols 为手动指定（1~MAX_GRID_CELLS），缺省由均匀间隙自动判定，检不出则整幅一格。
    """
    w, h = img.size
    buf = img.convert("L").tobytes()   # 行优先字节流，逐行/列切片算均值与标准差

    def profile(axis):   # axis=0 逐行 / axis=1 逐列 → [(mean, std), ...]
        out = []
        for i in range(h if axis == 0 else w):
            vals = buf[i * w:(i + 1) * w] if axis == 0 else buf[i::w]
            mean = sum(vals) / len(vals)
            var = sum((v - mean) ** 2 for v in vals) / len(vals)
            out.append((mean, var ** 0.5))
        return out

    h_runs = _gap_runs(profile(0))
    v_runs = _gap_runs(profile(1))
    row_bounds = _cell_bounds(h_runs, h, rows)
    col_bounds = _cell_bounds(v_runs, w, cols)
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
