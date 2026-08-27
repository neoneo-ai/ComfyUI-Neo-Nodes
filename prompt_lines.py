# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Multi-line prompt collections
#
#约定：presets/collections/ 与 custom/collections/ 下的每个 .txt 是一个多行
#提示词集合，一行一条；其余位置的 .txt 仍按整篇处理（见 web 端判定与路由）。

import os
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


def _read_text(filepath: str) -> str:
    with open(filepath, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("gb18030")


def _extract_title(line: str) -> str:
    comma_pos = [p for p in (line.find(","), line.find("，")) if p >= 0]
    head = line[:min(comma_pos)] if comma_pos else line
    head = head.strip().strip("「」『』\"'\u201c\u201d\u2018\u2019 ").strip()

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