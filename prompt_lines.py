# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Multi-line prompt collections
#
#约定：presets/collections/ 与 custom/collections/ 下的每个 .txt 是一个多行
#提示词集合，一行一条；其余位置的 .txt 仍按整篇处理（见 web 端判定与路由）。

import os
import re
import threading

_CACHE_MAX_ENTRIES = 8
_TITLE_MAX_CHARS = 50

_cache = {}
_cache_lock = threading.Lock()

# 行首人物数量词，循环剥除
_QUANTITY_WORDS = ("一位年轻的", "一名年轻的", "一个年轻的",
                   "一位年轻", "一名年轻", "一个年轻",
                   "一位", "一名", "一个", "那位", "这位")
# 高频泛化修饰词：仅当后面紧跟「的」或主体名词才剔除
_GENERIC_MODIFIERS = ("年轻",)
_SUBJECT_NEXT_CHARS = ("的", "女", "男", "少", "美")

# H3 提示词的字段头（integrated_multimodal_description: / overall_soundscape: 等）与时间戳（00:00.000 - 00:05.000），不进标题
_H3_FIELD_HEAD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*:\s*")
_H3_TIMESTAMP = re.compile(
    r"(?<!\d)\d{2}:\d{2,3}(?:\.\d{1,3})?(?!\d)(?:\s*[-–—~]\s*(?<!\d)\d{2}:\d{2,3}(?:\.\d{1,3})?(?!\d))?"
)
# H3 首行对齐指令（I2VA / FL2VA，中英两种写法），整行不进标题；时长为 S.SS 格式（秒位可 1~2 位）
_H3_ALIGN_LINE = re.compile(
    r"^(?:For the target video, at \d+\.\d+ seconds into the target video"
    r"|对于目标视频，在目标视频第 \d+\.\d+ 秒处"
    r"|How the reference pictures align with the target video"
    r"|参考图与目标视频的对齐方式)"
)


def _read_text(filepath: str) -> str:
    with open(filepath, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("gb18030")


def _extract_title(line: str) -> str:
    if _H3_ALIGN_LINE.match(line):
        return "(未命名)"
    comma_pos = [p for p in (line.find(","), line.find("，")) if p >= 0]
    head = line[:min(comma_pos)] if comma_pos else line
    head = head.strip().strip("「」『』\"'\u201c\u201d\u2018\u2019 ").strip()
    # 去掉 H3 字段头与时间戳（如 integrated_multimodal_description: / 00:00.000 - 00:05.000），只留画面描述
    head = re.sub(r"\s+", " ", _H3_TIMESTAMP.sub(" ", _H3_FIELD_HEAD.sub("", head))).strip()

    changed = True
    while changed:
        changed = False
        for word in _QUANTITY_WORDS:
            if head.startswith(word):
                head = head[len(word):]
                changed = True
                break
    changed = True
    while changed:
        changed = False
        for word in _GENERIC_MODIFIERS:
            pos = head.find(word)
            if pos >= 0 and pos + len(word) < len(head):
                nxt = head[pos + len(word)]
                if nxt in _SUBJECT_NEXT_CHARS:
                    head = head[:pos] + head[pos + len(word):]
                    changed = True

    head = head.strip()
    if not head:
        head = "(未命名)"
    return head[:_TITLE_MAX_CHARS]


def parse_entries(text: str) -> list[tuple[str, str]]:
    """把全文拆成 (title, prompt) 列表：空行跳过，重名标题追加 #NNN 序号。"""
    occurred = {}
    entries = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        title = _extract_title(line)
        n = occurred.get(title, 0) + 1
        occurred[title] = n
        if n > 1:
            title = f"{title} #{n:03d}"
        entries.append((title, line))
    return entries


def load_entries(filepath: str) -> list[tuple[str, str]]:
    """带缓存解析：以 (mtime_ns, size) 为失效依据，每文件只读盘解析一次。"""
    stat = os.stat(filepath)
    key = (stat.st_mtime_ns, stat.st_size)

    with _cache_lock:
        hit = _cache.get(filepath)
        if hit and hit[0] == key:
            return hit[1]

    entries = parse_entries(_read_text(filepath))
    with _cache_lock:
        if filepath not in _cache and len(_cache) >= _CACHE_MAX_ENTRIES:
            _cache.pop(next(iter(_cache)))
        _cache[filepath] = (key, entries)
    return entries