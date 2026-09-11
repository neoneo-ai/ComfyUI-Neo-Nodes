# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - H3 提示词确定性格式审计
"""对 MiniMax H3 视频提示词做纯规则的结构审计（不花 token），并构造"窄修复"消息。

供 skill.py 在声明了 `audit: h3` 的技能生成完成后调用：
- audit_h3_prompt(prompt, context) -> {"repair_required": bool, "failures": [str]}
  检查六段/三字段结构、时间戳格式与时长、内部表示术语泄漏、对白说话人 ID、
  以及 <Picture N>/<Video N>/<Audio N> 标签与工作流实际连线的一致性。
- narrow_repair_messages(text, draft, failures) -> messages
  只修列出的违规项、其余内容一律保留的窄修复对话（不带原始系统提示词，控制成本）。
- repair_acceptable(original, repaired, context) -> bool
  修复结果验收：审计通过 + 参考标签集合不变 + 对白逐行不变。
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Ref2VA 六段（顺序敏感）
REFERENCE_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)
# 基础模式（T2VA/I2VA/FL2VA/L2VA）三核心字段（顺序敏感）
BASE_FIELDS = (
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
)

TIMESTAMP_CANDIDATE = re.compile(r"(?<!\d)\d{2}:\d{2,3}(?:\.\d{1,3})?(?!\d)")
VALID_TIMESTAMP = re.compile(r"^(\d{2}):(\d{2})(?:\.(\d{3}))?$")

# 内部表示术语：contact sheet / 抽帧等是"模型输入方式"的描述，不应出现在最终提示词里
INTERNAL_VIDEO_REPRESENTATION = re.compile(
    r"(?i)\b(?:contact sheet|sheet cell(?:s)?|sampled frame(?:s)?|sample frame(?:s)?|\d+(?:\.\d+)?s\s+mark)\b"
)
DIALOGUE_RE = re.compile(r"(?is)<d>.*?</d>")
SPEAKER_ID_RE = re.compile(r"\(S\d+(?:\s*,\s*S\d+)*\)")

REFERENCE_TAG = re.compile(r"<\s*(Picture|Video|Audio)\s+(\d+)\s*>", re.IGNORECASE)


def reference_tags(text: str) -> set[str]:
    """提取文本中全部规范化的 <Picture N>/<Video N>/<Audio N> 标签集合。"""
    return {f"<{kind.title()} {num}>" for kind, num in REFERENCE_TAG.findall(text)}


def dialogue_lines(text: str) -> list[str]:
    return [value.strip() for value in DIALOGUE_RE.findall(text)]


def invalid_timestamps(prompt: str, duration_seconds: Optional[float] = None) -> list[str]:
    """找出格式不合法（须 MM:SS.mmm）或超出视频时长的时间戳。"""
    invalid: list[str] = []
    for value in TIMESTAMP_CANDIDATE.findall(prompt):
        match = VALID_TIMESTAMP.fullmatch(value)
        if not match:
            invalid.append(value)
            continue
        minutes, seconds, millis = (int(part) for part in match.groups())
        total = minutes * 60 + seconds + millis / 1000
        if seconds >= 60 or (duration_seconds is not None and total > duration_seconds + 0.001):
            invalid.append(value)
    return list(dict.fromkeys(invalid))


def context_media_tags(context: Optional[dict]) -> set[str]:
    """从工作流上下文 H3 节点的参考槽收集 <Picture N>/<Video N>/<Audio N> 标签集合。

    编号与 _format_workflow_context 注入给模型的一致：第 N 个该类型参考（1-based，含空槽位）；
    ImageToVideo 的 first/last frame 即 <Picture 1>/<Picture 2>。
    """
    tags: set[str] = set()
    for node in (context or {}).get("h3") or []:
        refs = node.get("refs") or {}
        for key, label in (("pictures", "Picture"), ("videos", "Video"), ("audios", "Audio")):
            files = refs.get(key) or []
            tags.update(f"<{label} {i}>" for i in range(1, len(files) + 1))
        kf = refs.get("keyframes") or {}
        count = sum(1 for key in ("first", "last") if key in kf)
        tags.update(f"<Picture {i}>" for i in range(1, count + 1))
    return tags


def context_duration_seconds(context: Optional[dict]) -> Optional[float]:
    """取第一个可判定时长的 H3 节点（duration_seconds 优先，回退 length/24）。"""
    for node in (context or {}).get("h3") or []:
        d = node.get("duration_seconds")
        if isinstance(d, (int, float)) and not isinstance(d, bool) and d > 0:
            return float(d)
        try:
            length = int(node.get("length"))
        except (TypeError, ValueError):
            continue
        if length > 0:
            return length / 24.0
    return None


def _section_positions(prompt: str, sections: tuple[str, ...]) -> dict[str, re.Match]:
    positions: dict[str, re.Match] = {}
    for section in sections:
        match = re.search(rf"(?im)^\s*{re.escape(section)}\s*:\s*", prompt)
        if match:
            positions[section] = match
    return positions


def audit_h3_prompt(prompt: str, context: Optional[dict] = None) -> dict[str, Any]:
    """确定性审计 H3 提示词结构；repair_required 为 True 时 failures 列出全部违规项。"""
    failures: list[str] = []

    ref_positions = _section_positions(prompt, REFERENCE_SECTIONS)
    base_positions = _section_positions(prompt, BASE_FIELDS)
    # overall_soundscape / non_diegetic_music 与基础模式共用，须靠四个特征段判定 Ref2VA 模式
    is_ref_mode = any(s in ref_positions for s in ("subject_definitions", "summary", "retention_analysis", "detailed_description"))
    if is_ref_mode:
        missing = [s for s in REFERENCE_SECTIONS if s not in ref_positions]
        if missing:
            failures.append("missing required sections: " + ", ".join(missing))
        else:
            order = sorted(ref_positions, key=lambda s: ref_positions[s].start())
            if order != list(REFERENCE_SECTIONS):
                failures.append("section order must be " + ", ".join(REFERENCE_SECTIONS))
        summary_match = ref_positions.get("summary")
        if summary_match and not re.match(r"\s*\[([^\]]+)\]", prompt[summary_match.end():]):
            failures.append("summary must start with a bracketed task label like [reference generation]")
    elif base_positions:
        missing = [f for f in BASE_FIELDS if f not in base_positions]
        if missing:
            failures.append("missing required fields: " + ", ".join(missing))
        else:
            order = sorted(base_positions, key=lambda f: base_positions[f].start())
            if order != list(BASE_FIELDS):
                failures.append("field order must be " + ", ".join(BASE_FIELDS))
    else:
        failures.append(
            "no H3 prompt structure found (expected the six reference sections or the three core fields)"
        )

    detailed = ref_positions.get("detailed_description") if is_ref_mode else None
    if detailed:
        following = [m.start() for m in ref_positions.values() if m.start() > detailed.start()]
        end = min(following) if following else len(prompt)
        body = prompt[detailed.end():end]
        if not re.search(r"(?im)^\s*\[Shot\s+1\]", body):
            failures.append("detailed_description must contain a [Shot 1] marker")

    bad_timestamps = invalid_timestamps(prompt, context_duration_seconds(context))
    if bad_timestamps:
        failures.append(
            "invalid timestamps (need MM:SS.mmm within the video duration): " + ", ".join(bad_timestamps)
        )

    internal_terms = list(dict.fromkeys(m.group(0) for m in INTERNAL_VIDEO_REPRESENTATION.finditer(prompt)))
    if internal_terms:
        failures.append("internal representation terms must not appear in the prompt: " + ", ".join(internal_terms))

    if DIALOGUE_RE.search(prompt) and not SPEAKER_ID_RE.search(prompt):
        failures.append("dialogue <d>...</d> is missing a speaker ID like (S1)")

    allowed = context_media_tags(context)
    if allowed:
        out_tags = reference_tags(prompt)
        unexpected = sorted(out_tags - allowed)
        if unexpected:
            failures.append(
                "unexpected reference tags not connected in the workflow: " + ", ".join(unexpected)
            )
        # 已连线的图片/视频参考都必须在提示词中交代（音频不强制）
        required = {t for t in allowed if not t.startswith("<Audio")}
        missing_tags = sorted(required - out_tags)
        if missing_tags:
            failures.append("connected references are missing from the prompt: " + ", ".join(missing_tags))

    return {"repair_required": bool(failures), "failures": failures}


def narrow_repair_messages(text: str, draft: str, failures: list[str]) -> list[dict[str, str]]:
    """构造窄修复对话：只修列出的违规项，其余事实/标签/对白/镜头一律保留。"""
    return [
        {
            "role": "system",
            "content": (
                "This is a narrow correction pass for a MiniMax H3 video prompt, not a new generation pass. "
                "Correct only the exact violations listed below and preserve every other fact, reference label, "
                "action, dialogue line, shot, and creative choice unchanged. Return the complete corrected prompt "
                "with no commentary.\nViolations:\n- " + "\n- ".join(failures)
            ),
        },
        {
            "role": "user",
            "content": f"ORIGINAL REQUEST:\n{text}\n\nDRAFT TO CORRECT:\n{draft}",
        },
    ]


def repair_acceptable(original: str, repaired: str, context: Optional[dict] = None) -> bool:
    """窄修复验收：非空 + 审计通过 + 参考标签集合不变 + 对白逐行不变。"""
    if not repaired or not repaired.strip():
        return False
    if reference_tags(repaired) != reference_tags(original):
        return False
    if dialogue_lines(repaired) != dialogue_lines(original):
        return False
    return not audit_h3_prompt(repaired, context)["repair_required"]

