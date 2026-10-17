#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""把「3000个漫剧人物+提示词资产汇总」的素材包整理成 Neo Studio 图库预设目录。

图库预设 = 一张图 + 同名 .txt 旁车（gallery.py 读旁车，灯箱按「标签：值」分段，
/neo_gallery/txt 读提示词全文）。产物是扁平目录 <数据根>/gallery/presets/<云端目录>/，
下一步交给 tools/gallery_preprocess.py 预处理、tools/gallery_deploy_oss.py 上传。

素材包里的坑，都在这里处理掉：
  - 图片和提示词都带 `(1)` 副本，武侠目录里还有同名不同图，判重只能按 md5。
  - 提示词按「每 10 人一份」批量存放，靠文件名里的 `_A-B` 或 `第NN份` 对回单人编号。
  - 提示词有三种版式，逐文件自动识别：标签式（「正向提示词：」/「负面提示词（必须添加）：」）、
    块式（【核心主体】分块，无负面段）、裸式（空行分段的整段提示词，只有说明行打头）。
    同一个包里能混着两种，古代乡村就是 1-10 份标签式、11-20 份裸式。
  - 武侠图片文件名是 ChatGPT 时间戳，编号靠生成时间排序，同时间戳的多张再按 `(n)` 序号排。

Usage:
  python tools/build_gallery_presets.py --list
  python tools/build_gallery_presets.py --pkg 古代乡村人物 [--sample 5]
  python tools/build_gallery_presets.py --all [--src <汇总根>] [--out <预设根>]
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC_DEFAULT = r"F:\Work\提示词\提示词更新\3000个漫剧人物+提示词资产汇总"
IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp")

DUP_SUFFIX = re.compile(r"(?:\s*\(\d+\))+$")
TS = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{2}_\d{2}_\d{2})")
INNER = re.compile(r"\((\d+)\)")
POS_LABEL = re.compile(r"(?m)^正向提示词[：:]\s*$")
NEG_LABEL = re.compile(r"(?m)^负面提示词[^：\n]*[：:]\s*$")
# 标签式提示词开头固定三段式：系列风格，角色名，NN岁左右，剧情定位。
# 仙侠那类多一段人设形容（逆命剑胚，孤冷隐忍，看似22岁），用宽松式兜住。
# 裸式同一段落但全程逗号收尾，所以句末标点不作要求，角色段内不许出现句号。
HEAD_STRICT = re.compile(r"(?P<role>[^，。；\n]{2,30})，(?P<name>[^，。；\n]{2,14})，(?P<apparent>看似)?"
                         r"(?P<age>\d{1,3})岁(?:左右)?，(?P<plot>[^，。\n]{2,30})")
HEAD_LOOSE = re.compile(r"(?P<role>[^，。；\n]{2,30})，(?P<name>[^，。；\n]{2,14})，(?P<trait>[^，。；\n]{2,14})，"
                        r"(?P<apparent>看似)?(?P<age>\d{1,3})岁(?:左右)?，(?P<plot>[^，。\n]{2,30})")
# 群像配角那类写作「风格，原创虚构人物，不参考任何真实人物…；清瘦茶农女，25岁左右，茶山支线角色」，
# 名字在分号之后。
HEAD_SEMI = re.compile(r"(?P<role>[^，。；\n]{2,30})，[^；\n]{2,60}；(?P<name>[^，。；\n]{2,14})，"
                       r"(?P<apparent>看似)?(?P<age>\d{1,3})岁(?:左右)?，(?P<plot>[^，。\n]{2,30})")
NOTE_LINE = re.compile(r"^\s*(这是|根据)[^\n]*(提示词|图片)")
ILLEGAL = re.compile(r'[\\/:*?"<>|\s]+')


@dataclass
class Pkg:
    src: str                                  # 汇总根下的素材包目录
    images: list                              # [(包内图片目录, 编号偏移)]
    prompts: str                              # 包内提示词目录
    numbered: bool = True                     # False = 文件名无编号，按生成顺序编号


PACKAGES: dict[str, Pkg] = {
    "古代乡村人物": Pkg("200 个古代乡村人物资料卡+提示词", [("人物资料卡", 0)], "提示词"),
    "古代言情人物": Pkg("200 个古代言情人物三视图+提示词",
                        [("古代人物-男主 50+女主 50", 0), ("古代人物配角100个", 100)], "提示词"),
    "现代都市人物": Pkg("200 个现代都市人物资料卡+提示词", [("人物资料卡", 0)], "提示词"),
    "现代乡村人物": Pkg("200 个现代乡村人物资料卡+提示词", [("人物资料卡", 0)], "提示词"),
    "明朝人物": Pkg("古代明朝人物", [("人物资产卡", 0)], "明朝小说人设200个_20份"),
    "武侠人物": Pkg("武侠人物资产", [("三视图", 0)], "200人提示词_每10人一份", numbered=False),
    "现代西方人物": Pkg("现代西方人物", [("三视图", 0)], "提示词"),
    "中世纪-国王贵族骑士": Pkg("中世纪欧洲人物/国王贵族骑士", [("三视图", 0)], "提示词"),
    "中世纪-平民": Pkg("中世纪欧洲人物/平民", [("三视图", 0)], "提示词"),
}


def data_root() -> Path:
    """数据根只认 plugin_paths 的三档解析。按文件加载这个叶子模块，插件入口不执行、节点不注册。"""
    spec = importlib.util.spec_from_file_location("neo_plugin_paths", REPO / "studio" / "plugin_paths.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return Path(str(mod.DATA_ROOT))


def dedupe_files(files: list[Path]):
    """去掉逐字节相同的 `(1)` 副本。武侠目录里同名不同图，判重只能按内容。"""
    by_size = collections.defaultdict(list)
    for p in files:
        by_size[p.stat().st_size].append(p)
    uniq, dropped = [], 0
    for group in by_size.values():
        seen = set()
        for p in group:
            if len(group) == 1:
                uniq.append(p)
                continue
            digest = hashlib.md5(p.read_bytes()).hexdigest()
            if digest in seen:
                dropped += 1
                continue
            seen.add(digest)
            uniq.append(p)
    return sorted(uniq), dropped


def order_key(p: Path):
    """ChatGPT 导出名里的时间戳就是生成顺序；同时间戳的多张按 `(n)` 序号排；无时间戳排最后。"""
    m = TS.search(p.name)
    if not m:
        return (1, 0, 0, 0, "", (), p.name)
    return (0, int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4),
            tuple(int(n) for n in INNER.findall(p.stem)), p.name)


def collect_images(pkg: Pkg, src_root: Path, note):
    d = src_root / pkg.src
    numbered: dict[int, Path] = {}
    ordered: list[Path] = []
    dropped = 0
    for sub, offset in pkg.images:
        folder = d / sub
        if not folder.is_dir():
            note(f"  图片目录不存在：{folder}")
            continue
        files = sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXTS)
        uniq, cut = dedupe_files(files)
        dropped += cut
        if not pkg.numbered:
            ordered += sorted(uniq, key=order_key)
            continue
        for p in uniq:
            m = re.search(r"\d+", DUP_SUFFIX.sub("", p.stem))
            if not m:
                note(f"  文件名无编号，跳过：{p.name}")
                continue
            num = offset + int(m.group())
            if num in numbered:
                note(f"  编号 {num} 撞车，保留 {numbered[num].name}，丢弃 {p.name}")
                continue
            numbered[num] = p
    for i, p in enumerate(ordered, 1):
        numbered[i] = p
    return numbered, dropped


def batch_start(stem: str) -> int:
    """批量提示词文件对应的首个编号：优先文件名里的 `A-B`，否则按 `第NN份` 每 10 人推。"""
    m = re.search(r"(\d+)\s*-\s*(\d+)", stem)
    if m:
        return int(m.group(1))
    m = re.search(r"第\s*(\d+)\s*份", stem)
    if m:
        return (int(m.group(1)) - 1) * 10 + 1
    return 0


def split_label(text: str):
    """标签式：独立成行的「正向提示词：」切块。说明行里的「正向提示词和负向提示词」不算标签。"""
    blocks = []
    for chunk in POS_LABEL.split(text)[1:]:
        parts = NEG_LABEL.split(chunk)
        blocks.append((parts[0].strip(), parts[1].strip() if len(parts) > 1 else ""))
    return blocks


def split_block(text: str):
    """块式：空行分段，每块以【核心主体】开头，整块即正向提示词，无负面段。"""
    return [(b.strip(), "") for b in re.split(r"\n\s*\n", text) if "【核心主体】" in b]


def split_plain(text: str):
    """裸式：空行分段，只认写了 8K 画质要求的段。说明行可能独占一段，也可能和第一条粘在一段里。"""
    blocks = []
    for chunk in re.split(r"\n\s*\n", text):
        body = "\n".join(l for l in chunk.strip().splitlines() if not NOTE_LINE.match(l)).strip()
        if "8K" in body:
            blocks.append((body, ""))
    return blocks


def detect_kind(text: str) -> str:
    """版式逐文件识别：同一个包能混着标签式和裸式，不能按包定死。"""
    if "【核心主体】" in text:
        return "block"
    return "label" if POS_LABEL.search(text) else "plain"


def collect_prompts(pkg: Pkg, src_root: Path, note):
    folder = src_root / pkg.src / pkg.prompts
    if not folder.is_dir():
        note(f"  提示词目录不存在：{folder}")
        return {}, 0
    files = sorted(p for p in folder.rglob("*.txt") if p.is_file())
    uniq, dropped = dedupe_files(files)
    prompts: dict[int, tuple[str, str, str]] = {}
    for p in uniq:
        start = batch_start(p.stem)
        if not start:
            note(f"  文件名定位不到编号，跳过：{p.name}")
            continue
        text = p.read_text(encoding="utf-8-sig")
        kind = detect_kind(text)
        blocks = split_label(text) if kind == "label" else (split_block(text) if kind == "block" else split_plain(text))
        if len(blocks) != 10:
            note(f"  {p.name} 按 {kind} 解析出 {len(blocks)} 段（期望 10 段）")
        for i, (pos, neg) in enumerate(blocks):
            prompts[start + i] = (pos, neg, kind)
    return prompts, dropped


def meta_label(pos: str):
    """从正向提示词开头取角色名与「风格，年龄，剧情」元信息。

    所有包都以同一句画质要求打头，先切掉它，角色段才不会被句尾的「无塑料假人感」占位。
    """
    head = pos.split("无塑料假人感。")[-1]
    m = HEAD_STRICT.search(head) or HEAD_LOOSE.search(head) or HEAD_SEMI.search(head)
    if not m:
        return "", ""
    g = m.groupdict()
    age = f"看似{g['age']}岁" if g["apparent"] else f"{g['age']}岁"
    meta = f"{g['role']}，{g['trait']}，{age}，{g['plot']}" if g.get("trait") else f"{g['role']}，{age}，{g['plot']}"
    return g["name"], meta


def meta_block(block: str):
    """块式取【核心主体】里的身份名：`身份是…中的调查记者` 取末尾，否则取第二个逗号段。

    国王贵族骑士那份把【核心主体】单独占一行，正文在下一行，取标记后的非空行。
    """
    lines = block.splitlines()
    lead = ""
    for i, line in enumerate(lines):
        if "【核心主体】" in line:
            lead = line.split("】", 1)[1].strip() or (lines[i + 1].strip() if i + 1 < len(lines) else "")
            break
    segs = [s.strip() for s in lead.split("，")]
    age = re.search(r"\d{1,3}岁", lead)
    age = age.group(0) if age else ""
    for seg in segs[1:]:
        if seg.startswith("身份是"):
            tail = seg[len("身份是"):]
            return (tail.split("中的")[-1] if "中的" in tail else tail), age
    return (segs[1] if len(segs) > 1 else ""), age


def build(name: str, pkg: Pkg, src_root: Path, out_root: Path, sample: int = 0):
    def note(msg: str) -> None:
        print(msg)

    imgs, img_dupes = collect_images(pkg, src_root, note)
    prompts, txt_dupes = collect_prompts(pkg, src_root, note)
    out = out_root / name
    if out.exists():
        shutil.rmtree(out)      # 本次构建的产物目录，重建前清掉自己写的旧文件
    out.mkdir(parents=True)
    index, no_img, no_txt, shown = [], [], [], 0
    for num in sorted(set(imgs) | set(prompts)):
        pos, neg, kind = prompts.get(num, ("", "", ""))
        if not pos:
            no_txt.append(num)
            continue            # 无提示词的图不产出：灯箱和复制提示词会是空的
        img = imgs.get(num)
        if not img:
            no_img.append(num)
        cname, meta = meta_block(pos) if kind == "block" else meta_label(pos)
        cname = ILLEGAL.sub("", cname) or f"人物{num:03d}"
        stem = f"{num:03d}_{cname}"
        if img:
            shutil.copy2(img, out / (stem + img.suffix.lower()))
        lines = [f"角色：{cname}（{meta}）" if meta else f"角色：{cname}", f"正向提示词：{pos}"]
        if neg:
            lines.append(f"负面提示词：{neg}")
        (out / (stem + ".txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
        index.append(f"{num:03d}\t{cname}\t{meta}")
        if shown < sample:
            shown += 1
            print(f"  {stem}: {pos[:70]}")
    (out / "角色索引.txt").write_text("\n".join(index) + "\n", encoding="utf-8")
    size_mb = sum(f.stat().st_size for f in out.iterdir()) / 1048576
    print(f"{name}: 产出 {len(index)} 对，图 {len(imgs)} 提示词 {len(prompts)}，"
          f"去重副本 图{img_dupes}/文{txt_dupes}，无提示词 {len(no_txt)}，无图 {len(no_img)}，"
          f"{size_mb:.1f} MB -> {out}")
    if no_img:
        print(f"  缺图编号：{no_img[:12]}{' ...' if len(no_img) > 12 else ''}")
    if no_txt:
        print(f"  缺提示词编号：{no_txt[:12]}{' ...' if len(no_txt) > 12 else ''}")
    return len(index)


def main() -> int:
    ap = argparse.ArgumentParser(description="整理素材包为 Neo Studio 图库预设目录")
    ap.add_argument("--pkg", help="只构建一个云端目录名（见 --list）")
    ap.add_argument("--all", action="store_true", help="构建全部素材包")
    ap.add_argument("--src", default=SRC_DEFAULT, help="素材汇总根")
    ap.add_argument("--out", default="", help="预设输出根，默认 <数据根>/gallery/presets")
    ap.add_argument("--sample", type=int, default=0, help="打印前 N 条角色名与提示词开头")
    ap.add_argument("--list", action="store_true", help="列出素材包配置")
    args = ap.parse_args()
    if args.list:
        for name, pkg in PACKAGES.items():
            print(f"{name}\t{pkg.src}\t{'编号' if pkg.numbered else '顺序'}")
        return 0
    names = list(PACKAGES) if args.all else ([args.pkg] if args.pkg else [])
    if not names:
        print("用 --pkg <云端目录名> 或 --all，见 --list")
        return 1
    unknown = [n for n in names if n not in PACKAGES]
    if unknown:
        print(f"未配置的素材包：{unknown}")
        return 1
    src_root = Path(args.src)
    if not src_root.is_dir():
        print(f"汇总根不存在：{src_root}")
        return 1
    out_root = Path(args.out) if args.out else data_root() / "gallery" / "presets"
    out_root.mkdir(parents=True, exist_ok=True)
    total = 0
    for name in names:
        total += build(name, PACKAGES[name], src_root, out_root, args.sample)
    print(f"合计 {total} 对 -> {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


