/**
 * Gallery 素材卡片「一键生成」：角色图（多视图）与九宫格分镜图的请求体、弹窗 UI 与生成流程。
 * 从 gallery-card.js 拆出，固定走 Qwen Image 2.1 预设；输出分别落 Output/CharacterSheet 与 Output/StoryBoard。
 */

import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { getImageHeight, getThumbnailSrc, isImageFile } from "./gallery-utils.js";
import { DIRECTOR_ASPECTS } from "./director.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, listSkills, populateSkillOptions } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, createModelConfigSection, listGenModels, getSkillGenConfig } from "./image-gen.js";
import { invokePromptStream, createStreamOutputHandlers, randomPrompts, listPrompts, loadPrompt } from "./prompt-service.js";
import { createQuickInputHistory } from "./quick-input-history.js";
import { openGallerySidebar } from "./media-transfer.js";

// 一键角色图 / 九宫格分镜图都固定走 Qwen Image 2.1 预设（多路参考槽位、不走 Krea2 编辑链）。
const QWEN_IMAGE_SKILL_ID = "qwen_image_21";
// 「生成素材」弹窗默认技能：Krea2 文生图（纯提示词出图，产物落 Output/NeoAgent/<日期>）
const KREA2_T2I_SKILL_ID = "image_gen";
// 「生成素材」弹窗上次选中的技能（localStorage，关窗不清除）
const GM_LAST_SKILL_KEY = "neo.gallery.gen_material.skill";
// 「生成素材」弹窗上次选中的「增强 skill」（localStorage，关窗不清除；空 = 默认自动路由）
const GM_ENHANCE_SKILL_KEY = "neo.gallery.gen_material.enhance_skill";
// 用所选人像作参考图生成四视图角色设定图，供拖入导演配方的 👤 角色参考图。
const CHARACTER_SHEET_PROMPT = "角色设定多视图：根据参考图中的人物，在一张横版画面中生成四个视图横向并排的角色设定图：第一格为大头特写（肩部以上，突出五官脸型），第二格为正面全身站立，第三格为侧面全身站立，第四格为背面全身站立。严格保持与参考图一致的五官脸型、发型发色、服装配饰和体型比例；全身视图中人物自然站立，双臂下垂，纯白背景，均匀柔光，写实摄影风格，高清细节，画面内不出现文字标注。";
// 角色图输出目录：保存路径的日期段会变成文件名前缀，成品直接落在 Output/CharacterSheet 下。
const CHARACTER_SHEET_DIR = "CharacterSheet";

/** 一键角色图的生图请求体（/neo_image_gen/generate）：固定 Qwen Image 2.1 + 头特写/正/侧/背提示词 + 1920×1080 请求（输出尺寸按 16 对齐）；输出走独立 character 目录 */
export function buildCharacterSheetRequest(refName) {
    return {
        skill_id: QWEN_IMAGE_SKILL_ID,
        prompt: CHARACTER_SHEET_PROMPT,
        width: 1920,
        height: 1080,
        references: [{ kind: "input", value: refName }],
        loras: [],          // 不带全局 LoRA（避免把 Krea2 风格 LoRA 灌进 Qwen 模型）
        skip_enhance: true, // 固定提示词，不走 LLM 增强
        output_prefix: CHARACTER_SHEET_DIR, // 独立输出目录（覆盖全局 output_prefix）
    };
}

// 一键宫格分镜图：原图当参考 + 宫格指令出 N 格故事板，供导演编辑器「🧩 宫格分镜图拆分」切成视频关键帧。
// 每格保持约 16:9（够拆完当视频首帧），按布局调整体宽高；默认 6 宫格（2×3）。
const STORYBOARD_DIR = "StoryBoard";
const STORYBOARD_GRID_OPTIONS = [4, 6, 9];
const STORYBOARD_DEFAULT_GRIDS = 6;
// 各宫格数对应的布局与画布尺寸（每格约 16:9）：4=2列×2行、6=3列×2行、9=3列×3行。
const STORYBOARD_LAYOUTS = {
    4: { rows: 2, cols: 2, width: 2048, height: 1152 },   // 每格约 1024×576
    6: { rows: 2, cols: 3, width: 2048, height: 768 },    // 每格约 683×384
    9: { rows: 3, cols: 3, width: 2048, height: 1152 },   // 每格约 683×384
};
const STORYBOARD_GRID_LABELS = { 4: "2列×2行 四宫格", 6: "3列×2行 六宫格", 9: "3列×3行 九宫格" };
// 小窗里的参考图预览尺寸（px，走 /neo_gallery/thumbnail 缓存，不为预览另存大图）
const STORYBOARD_PREVIEW_SIZE = 480;
// 参考图细节提取任务（skills/tasks/storyboard_ref_detail）：受限视觉调用，把参考图里的人物外形 + 服装
// 提取成一两句文字注入生图提示词做文字锚定（只写 "<image1> 指代" 时模型拿不到具体细节）。
const STORYBOARD_REF_DETAIL_SKILL_ID = "storyboard_ref_detail";

function _normalizeGrids(count) {
    return STORYBOARD_GRID_OPTIONS.includes(Number(count)) ? Number(count) : STORYBOARD_DEFAULT_GRIDS;
}

/** 从 skill id（如 storyboard_grid_9）提取宫格数；无法识别时回退默认值 */
function _gridCountFromSkillId(skillId) {
    const m = /storyboard_grid_(\d+)/.exec(skillId || "");
    return m ? _normalizeGrids(Number(m[1])) : STORYBOARD_DEFAULT_GRIDS;
}

const _gridTemplateCache = {};

async function _loadGridTemplate(skillId) {
    if (_gridTemplateCache[skillId]) return _gridTemplateCache[skillId];
    try {
        const res = await fetch("/rs_prompts/load_skill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: skillId }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const content = (data.content || "").trim();
        if (content) _gridTemplateCache[skillId] = content;
        return content || null;
    } catch {
        return null;
    }
}

// 技能正文里 <!-- @story-writer -->…<!-- @end --> 是给 LLM 的编剧说明，进生图提示词前剔除
const STORY_WRITER_SECTION_RE = /<!--\s*@story-writer\s*-->[\s\S]*?<!--\s*@end\s*-->/g;

/** 故事 → 宫格指令：从 skill（storyboard_grid_N）加载模板（去掉编剧区块）后替换 {story} 占位符。
 * refDetail 是参考图人物与服装的文字细节（可空）：有则写在故事开头做文字锚定，模型才知道 <image1> 是谁、穿什么。
 * qwen_image21 分词器会为每张参考图插字面量 <imageN>，所以提示词里可以直接写 <image1>。 */
export async function buildStoryboardGridPrompt(story, count = STORYBOARD_DEFAULT_GRIDS, skillId, refDetail = "") {
    const n = _normalizeGrids(count);
    const layout = STORYBOARD_LAYOUTS[n];
    const sid = skillId || `storyboard_grid_${n}`;
    const raw = await _loadGridTemplate(sid);
    const tpl = raw ? raw.replace(STORY_WRITER_SECTION_RE, "").trim() : raw;
    const body = refDetail ? `【参考图人物与服装细节】${refDetail}\n\n${story}` : story;
    if (tpl && tpl.includes("{story}")) {
        return tpl.replace(/\{story\}/g, () => body);
    }
    // Fallback: 模板未加载成功时使用内联默认
    return `一张 ${STORYBOARD_GRID_LABELS[n]}分镜故事板（${n}-panel storyboard sheet），布局为 ${layout.cols} 列 × ${layout.rows} 行（每行 ${layout.cols} 格，共 ${layout.rows} 行），按阅读顺序（从左到右、从上到下，第 1 格到第 ${n} 格）讲述以下故事：\n`
        + body + "\n"
        + `参考图 <image1> 里的人物就是故事主角：所有格子保持与参考图一致的五官脸型、发型发色、服装配饰与体型比例，场景与画风统一。\n`
        + `要求：布局严格为 ${layout.cols} 列 × ${layout.rows} 行的网格；每格一个镜头，叙事逐格推进；格子之间用均匀细白缝分隔，便于后续自动切分；格子内不出现任何文字、字幕或编号。`;
}

/** 一键宫格分镜图的生图请求体（/neo_image_gen/generate）：Qwen Image 2.1 + 卡片原图作参考图 + 宫格指令；输出走独立 StoryBoard 目录 */
export async function buildStoryboardGridRequest(refName, story, skillId = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`, refDetail = "") {
    const n = _gridCountFromSkillId(skillId);
    const layout = STORYBOARD_LAYOUTS[n];
    return {
        skill_id: QWEN_IMAGE_SKILL_ID,
        prompt: await buildStoryboardGridPrompt(story, n, skillId, refDetail),
        width: layout.width,
        height: layout.height,
        references: [{ kind: "input", value: refName }],
        loras: [],          // 不带全局 LoRA（避免把 Krea2 风格 LoRA 灌进 Qwen 模型）
        skip_enhance: true, // 固定提示词，不走 LLM 增强
        output_prefix: STORYBOARD_DIR, // 独立输出目录（覆盖全局 output_prefix）
    };
}

/** 卡片图片经 copy_to_input 落到 input 目录（与发送到 LoadImage 同一通道），返回 input 内的文件名 */
async function copyImageToInput(image, subfolder) {
    const query = "filename=" + encodeURIComponent(image.filename || "")
        + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || !result.success) {
        throw new Error((result && result.error) || '无法读取该图片');
    }
    return result.filename;
}



/** 一键角色图的前置小窗（复用九宫格分镜图同款弹窗结构）：先看参考图确认，点「生成」后
 * 在窗口内显示排队/生图进度与结果预览；Esc 或点遮罩关闭。 */
function openCharacterSheetDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-cs-modal-overlay')?.remove();
    // 参考图按卡片图片高度显示（与九宫格小窗一致），方便确认用的就是这张
    const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    let running = false;         // 防止重复提交
    let cancelId = null;         // 当前任务 id（取消用）
    let cancelRequested = false; // 用户点了「取消任务」
    let refName = null;          // copy_to_input 后的 input 文件名（重试复用，不重复落盘）

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-cs-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    const renderIdle = () => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: "将基于这张人像生成头特写 / 正面 / 侧面 / 背面四视图，输出到 Output/CharacterSheet。" }));
        fill(actionsBox, btn("取消", close), btn("生成", start, true));
    };

    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        const bar = $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]);
        fill(statusBox,
            $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]),
            bar);
        fill(actionsBox, btn("取消任务", () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        const box = $el("div", { className: "neo-gallery-cs-result" });
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            box.appendChild(img);
        }
        const size = final.width && final.height ? ` · ${final.width}×${final.height}` : "";
        fill(statusBox, box, $el("div", { className: "neo-gallery-story-hint", textContent: `已生成${size}，可拖入配方的 👤 角色参考图` }));
        fill(actionsBox, btn("打开输出目录", () => openGallerySidebar(CHARACTER_SHEET_DIR, [])), btn("关闭", close, true));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || "生成失败" }));
        fill(actionsBox, btn("重试", start), btn("关闭", close));
    };

    const start = async () => {
        if (running) return;
        running = true;
        cancelRequested = false;
        renderRunning("排队中…");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            const snap = await requestGeneration(buildCharacterSheetRequest(refName));
            cancelId = snap.task_id;
            renderRunning("排队中…");
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError("已取消");
            else renderError(final.error || "生成失败");
        } catch (e) {
            console.error('[Gallery] character sheet generation failed:', e);
            renderError(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => { if (e.key === "Escape") close(); };

    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "\uD83E\uDDAC 生成角色图（多视图）" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        // 参考图直接出缩略图（同一张卡片走同一缓存接口），避免只看到文件名却不确定是哪张
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", {
                className: "neo-gallery-story-ref-img",
                src: getThumbnailSrc(image, subfolder, STORYBOARD_PREVIEW_SIZE),
                alt: image.name || image.filename,
                style: { height: `${previewHeight}px` }
            }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("div", { className: "neo-gallery-story-ref-label", textContent: "参考图 · 人物沿用这张" }),
                $el("div", { className: "neo-gallery-story-path", title: pathLabel, textContent: pathLabel })
            ])
        ]),
        statusBox,
        actionsBox
    ]));

    renderIdle();

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);
}

/** 九宫格分镜图的前置小窗（与角色图小窗同款）：上面是分镜故事（可手写，或点「✨ LLM 生成分镜故事」由所选宫格技能
 * + 下方「简要故事 / 想法」+ 参考图流式生成），下面依次是宫格技能下拉与可选的简要故事 / 想法；点「生成」后窗口内显示排队/生图进度与结果预览。 */
export function openStoryboardDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-story-modal-overlay')?.remove();
    // 预览按卡片图片的高度显示：小窗里的参考图和卡片里看到的一样大，方便确认用的就是这张
    const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");
    const hint = $el("div", { className: "neo-gallery-story-hint" });
    const input = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 6,
        placeholder: "例：雨夜的地铁口，她收起伞抬头，看见多年未见的他站在灯下……"
    });
    // 简要故事 / 想法：LLM 编故事的输入（这一步不带参考图），可留空（留空则只给格数，让 LLM 自己编）；生成结果覆盖写入上面的故事框
    const ideaInput = $el("textarea", {
        className: "neo-gallery-story-idea",
        rows: 3,
        placeholder: "可选：一句话想法（如：雨夜地铁口偶遇旧友）。留空则只给格数，让 LLM 自行编故事"
    });
    // 宫格技能：从后端加载 storyboard_grid_* 技能列表；选中技能同时充当编剧技能（写故事）与生图提示词模板 / 布局
    const gridSel = $el("select", { className: "neo-gallery-story-grid" }, [
        $el("option", { value: "", textContent: "加载中…" }),
    ]);
    (async () => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const gridSkills = skills.filter(s => /^storyboard_grid_\d+$/.test(s.id));
            if (gridSkills.length === 0) {
                gridSel.innerHTML = "";
                for (const n of STORYBOARD_GRID_OPTIONS) {
                    gridSel.appendChild($el("option", { value: `storyboard_grid_${n}`, textContent: STORYBOARD_GRID_LABELS[n] }));
                }
            } else {
                gridSel.innerHTML = "";
                for (const s of gridSkills) {
                    gridSel.appendChild($el("option", { value: s.id, textContent: s.cn_name || s.name || s.id }));
                }
            }
            const defaultId = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
            gridSel.value = [...gridSel.options].some(o => o.value === defaultId) ? defaultId : gridSel.options[0]?.value || "";
        } catch {
            gridSel.innerHTML = "";
            for (const n of STORYBOARD_GRID_OPTIONS) {
                gridSel.appendChild($el("option", { value: `storyboard_grid_${n}`, textContent: STORYBOARD_GRID_LABELS[n] }));
            }
            gridSel.value = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
        }
    })();
    // 表单整块（故事框 + 提示 + 宫格数 + 简要故事框）：生成中被下面的进度/结果区整块替换
    const formBox = $el("div", { className: "neo-gallery-story-form" }, [
        input,
        hint,
        $el("div", { className: "neo-gallery-story-field-label", textContent: "宫格技能" }),
        gridSel,
        $el("div", { className: "neo-gallery-story-field-label", textContent: "简要故事 / 想法（可留空，留空则让 LLM 自行编故事）" }),
        ideaInput
    ]);
    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });

    let refName = null;          // copy_to_input 后的 input 文件名（生成故事与生图复用，不重复落盘）
    let refDetail = null;        // 参考图人物与服装细节（生图前取一次；空串=取不到，不再重试）
    let running = false;         // 防重复提交（生图）
    let cancelId = null;         // 当前生图任务 id（取消用）
    let cancelRequested = false; // 用户点了「取消任务」
    let llmRunning = false;      // 防重复提交（生成故事）
    let llmBtn = null;

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });
    // 产物目录：归档后打开画廊 Grid 主目录（优先跳到实际落盘的日期子目录，取不到时回退根目录）
    const openOutputDir = (final) => {
        const sub = (final.images || []).map(i => i.subfolder).find(Boolean);
        const date = sub ? sub.split("/").filter(Boolean).pop() : "";
        openGallerySidebar(STORYBOARD_DIR, date ? [date] : []);
    };

    // 表单态：故事框 + 简要故事框可编辑，右下有 LLM / 取消 / 生成
    const renderForm = () => {
        hint.classList.remove("neo-gallery-story-hint-error");
        hint.textContent = "按所选宫格技能逐格推进，人物沿用这张图；故事可手写，也可用下面的简要故事 / 想法让 LLM 生成。";
        formBox.style.display = "";
        statusBox.style.display = "none";
        fill(actionsBox, llmBtn, btn("取消", close), btn("生成", onSubmit, true));
    };

    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox,
            $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]),
            $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]));
        fill(actionsBox, btn("取消任务", () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        const box = $el("div", { className: "neo-gallery-cs-result" });
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            box.appendChild(img);
        }
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox, box, $el("div", { className: "neo-gallery-story-hint", textContent: "已生成九宫格分镜图，可拖入导演编辑器「🧩 宫格分镜图拆分」切成关键帧。" }));
        fill(actionsBox, btn("打开输出目录", () => openOutputDir(final), true), btn("关闭", close));
    };

    const renderError = (message) => {
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || "生成失败" }));
        fill(actionsBox, btn("重试", onSubmit), btn("关闭", close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: "九宫格分镜图生成失败", detail: message, actionLabel: "打开技能详情", onAction: () => openSkillDetailById(QWEN_IMAGE_SKILL_ID) });
    };

    // 参考图人物与服装细节：受限视觉调用（只出 1~2 句外形 + 服装），失败或没有视觉模型时返回空串，
    // 生图照常走（只少一层文字锚定，退回只有 <image1> 指代）。
    const loadRefDetail = async () => {
        let buf = "";
        try {
            await invokePromptStream(
                { text: "只看这张参考图，写它的人物外形与服装细节", skillId: STORYBOARD_REF_DETAIL_SKILL_ID, images: [{ kind: "input", value: refName }] },
                {
                    onChunk: (chunk) => { if (chunk && chunk.kind !== "thinking") buf += chunk.text || ""; },
                    onError: (err) => console.warn("[Gallery] reference detail failed:", err),
                }
            );
        } catch (e) {
            console.warn("[Gallery] reference detail failed:", e);
        }
        return buf.trim();
    };

    // 生图：卡片原图落 input/ 当参考图，按故事 + 所选宫格技能出故事板；进度/结果都留在窗口内
    const start = async () => {
        if (running) return;
        running = true;
        cancelRequested = false;
        renderRunning("排队中…");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            if (refDetail === null) {
                renderRunning("读取参考图细节…");
                refDetail = await loadRefDetail();
            }
            if (cancelRequested) { renderError("已取消"); return; }
            const snap = await requestGeneration(await buildStoryboardGridRequest(refName, input.value.trim(), gridSel.value, refDetail));
            cancelId = snap.task_id;
            renderRunning("排队中…");
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError("已取消");
            else failGen(final.error || "生成失败");
        } catch (e) {
            console.error('[Gallery] storyboard generation failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onSubmit = () => {
        if (running) return;
        if (!input.value.trim()) {
            hint.textContent = "请先填写分镜故事，或点「✨ LLM 生成分镜故事」";
            hint.classList.add("neo-gallery-story-hint-error");
            input.focus();
            return;
        }
        start();
    };
    // 宫格故事生成：把简要故事 / 想法交给**所选宫格技能**（它的正文既是编剧指令也是生图模板）写成逐格故事，
    // 覆盖写入上面的故事框。**不给编剧看参考图**——人物设定图（三视图 / 四视图）会被它当成"要描述的图"而反推；
    // 改把参考图的人物外形 + 服装先用 storyboard_ref_detail 提取成文字，连简要故事一起给它。
    const generateStoryFromIdea = async () => {
        if (llmRunning) return;
        llmRunning = true;
        llmBtn.disabled = true;
        llmBtn.textContent = "⏳ 生成中…";
        hint.classList.remove("neo-gallery-story-hint-error");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            if (refDetail === null) refDetail = await loadRefDetail();
            let buf = "";
            const skillId = gridSel.value || `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
            const n = _gridCountFromSkillId(skillId);
            const idea = ideaInput.value.trim();
            const brief = idea || "自行编一个完整故事——有开端、发展、结尾，每格不同场景与不同动作";
            const storyText = `${refDetail ? `参考图人物外形与服装：${refDetail}\n\n` : ""}${brief}（按 ${n} 格分镜）`;
            await invokePromptStream(
                { text: storyText, skillId },
                {
                    onChunk: (chunk) => {
                        if (!chunk || chunk.kind === "thinking") return;
                        buf += chunk.text || "";
                        input.value = buf;
                    },
                    onDone: () => {
                        input.value = buf;
                        hint.textContent = "已生成分镜故事，可继续编辑后再点「生成」。";
                    },
                    onError: (err) => {
                        console.error('[Gallery] storyboard story generation failed:', err);
                        actionToast({ severity: 'error', summary: 'LLM 生成分镜故事失败', detail: String(err), actionLabel: '打开 LLM 设置', onAction: openLLMSettingsModal });
                    }
                }
            );
        } catch (e) {
            console.error('[Gallery] storyboard story generation failed:', e);
            actionToast({ severity: 'error', summary: 'LLM 生成分镜故事失败', detail: String(e?.message || e), actionLabel: '打开 LLM 设置', onAction: openLLMSettingsModal });
        } finally {
            llmRunning = false;
            llmBtn.disabled = false;
            llmBtn.textContent = "✨ LLM 生成分镜故事";
        }
    };
    llmBtn = $el("button", { className: "neo-gallery-story-btn", textContent: "✨ LLM 生成分镜故事", onclick: generateStoryFromIdea });
    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmit();
    };
    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "\uD83E\uDDE9 生成九宫格分镜图" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        // 参考图直接出缩略图（同一张卡片走同一缓存接口），避免只看到文件名却不确定是哪张
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", {
                className: "neo-gallery-story-ref-img",
                src: getThumbnailSrc(image, subfolder, STORYBOARD_PREVIEW_SIZE),
                alt: image.name || image.filename,
                style: { height: `${previewHeight}px` }
            }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("div", { className: "neo-gallery-story-ref-label", textContent: "参考图 \u00B7 人物沿用这张" }),
                $el("div", { className: "neo-gallery-story-path", title: pathLabel, textContent: pathLabel })
            ])
        ]),
        formBox,
        statusBox,
        actionsBox
    ]));

    renderForm();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
}

// 图片反推：弹窗展示参考图，调用 /rs_prompts/reverse_prompt 反推提示词。
// 后端会把结果自动存成与图片同目录的 .txt（已存在则直接返回缓存）。
export function openReversePromptDialog(image, subfolder) {
    const filename = image.filename || image.name;
    const previewSrc = getThumbnailSrc(image, subfolder);
    const pathLabel = `${subfolder ? subfolder + "/" : ""}${filename}`;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    let busy = false;

    function close() {
        if (busy) return; // 反推中不允许关闭，避免误触丢失结果
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    function setStatus(state, text) {
        statusBox.innerHTML = "";
        if (state === "idle") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint", textContent: text }));
        } else if (state === "running") {
            statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: text }),
            ]));
        } else if (state === "success") {
            statusBox.appendChild($el("div", { className: "neo-gallery-rp-result", textContent: text }));
            const copyBtn = $el("button", {
                className: "neo-gallery-story-btn neo-gallery-rp-copy",
                textContent: "\u29C9 复制提示词",
                onclick: () => copyPrompt(text, copyBtn),
            });
            statusBox.appendChild(copyBtn);
        } else if (state === "error") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: text }));
        }
    }

    async function copyPrompt(text, btn) {
        try {
            await navigator.clipboard.writeText(text);
            btn.textContent = "\u2705 已复制";
            setTimeout(() => { btn.textContent = "\u29C9 复制提示词"; }, 1500);
        } catch (e) {
            actionToast({ severity: "info", summary: "复制失败", detail: String(e) });
        }
    }

    function renderStreaming(text) {
        statusBox.innerHTML = "";
        statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
            $el("span", { className: "neo-gallery-cs-spinner" }),
            $el("div", { className: "neo-gallery-rp-result", textContent: text || "…" }),
        ]));
    }

    async function run() {
        busy = true;
        let acc = "";
        renderStreaming("");
        try {
            const language = (langRow.querySelector('input[name="rpLang"]:checked') || {}).value || "zh";
            const resp = await fetch("/rs_prompts/reverse_prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename, subfolder, language }),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            // SSE 流式消费：逐帧解析，正文实时写入，meta 帧（status/txt_file/language）忽略
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const data = line.slice(6);
                    if (data === "[DONE]") break;
                    if (data.startsWith("[ERROR]")) throw new Error(data.slice("[ERROR]".length).trim());
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.meta) continue;
                        if (typeof parsed.text === "string") {
                            acc += parsed.text;
                            renderStreaming(acc);
                        }
                    } catch { /* 非 JSON 帧忽略 */ }
                }
            }
            const final = acc.trim() || "(空提示词)";
            setStatus("success", final);
            actionToast({ severity: "success", summary: "已保存反推结果到图片目录" });
        } catch (err) {
            setStatus("error", err.message || String(err));
        } finally {
            busy = false;
        }
    }

    // 输出语言选择（默认中文）
    const langRow = document.createElement("div");
    langRow.className = "neo-gallery-rp-lang";
    const mkLangOpt = (value, label, checked) => {
        const wrap = document.createElement("label");
        wrap.className = "neo-gallery-rp-lang-opt";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "rpLang";
        input.value = value;
        if (checked) input.checked = true;
        wrap.append(input, document.createTextNode(label));
        return wrap;
    };
    langRow.append(mkLangOpt("zh", "中文", true), mkLangOpt("en", "英文", false));

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay" });
    const modal = $el("div", {
        className: "neo-gallery-story-modal",
        onclick: e => e.stopPropagation(),
    }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "图片反推" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "×", onclick: close }),
        ]),
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", { className: "neo-gallery-story-ref-img", src: previewSrc, style: { height: `${getImageHeight(image) || 160}px` } }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("span", { className: "neo-gallery-story-ref-label", textContent: "参考图" }),
                $el("span", { className: "neo-gallery-story-path", title: pathLabel, textContent: filename }),
            ]),
        ]),
        langRow,
        statusBox,
        $el("div", { className: "neo-gallery-story-actions" }, [
            $el("button", { className: "neo-gallery-story-btn", textContent: "取消", onclick: close }),
            $el("button", { className: "neo-gallery-story-btn neo-gallery-story-btn-primary", textContent: "反推", onclick: run }),
        ]),
    ]);
    overlay.onclick = () => close();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setStatus("idle", "点击「反推」生成提示词，结果将自动保存到图片所在目录");
    document.addEventListener("keydown", onKey);
}

/** LoRA 打标弹窗：为叶子图片目录批量生成标准化标签 .txt（触发词 + 可选先自动标准化目录）。 */
export function openLoraTagDialog(gallery, dirPath) {
    document.querySelector(".neo-gallery-lt-modal-overlay")?.remove();

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    let busy = false;

    function close() {
        if (busy) return; // 打标中不允许关闭，避免误触丢失结果
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    const triggerInput = $el("input", {
        className: "neo-gallery-story-input neo-gallery-lt-trigger",
        type: "text",
        placeholder: "触发词（如 gtx）",
    });
    const stdCheck = $el("input", { type: "checkbox" });
    stdCheck.checked = true;
    const stdRow = $el("label", { className: "neo-gallery-lt-std-row" }, [
        stdCheck,
        document.createTextNode("先自动标准化目录（HEIC→PNG + 001.png... 顺序编号）"),
    ]);

    // 当前打标图片 + 标签结果实时预览：SSE 帧按顺序到达，自然逐张切换
    const previewImg = $el("img", { className: "neo-gallery-lt-preview-img" });
    const previewCaption = $el("div", { className: "neo-gallery-lt-preview-caption" });
    const previewBox = $el("div", { className: "neo-gallery-lt-preview" }, [previewImg, previewCaption]);
    previewBox.style.display = "none";

    function setStatus(state, text) {
        statusBox.innerHTML = "";
        if (state === "idle") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint", textContent: text }));
        } else if (state === "running") {
            statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: text }),
            ]));
        } else if (state === "success") {
            statusBox.appendChild($el("div", { className: "neo-gallery-rp-result", textContent: text }));
        } else if (state === "error") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: text }));
        }
    }

    async function run() {
        const trigger = triggerInput.value.trim();
        if (!trigger) { setStatus("error", "请输入触发词"); return; }
        busy = true;
        let lastMeta = null;
        try {
            const resp = await fetch("/neo_gallery/tag_dir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dir: dirPath, trigger_word: trigger, standardize: stdCheck.checked }),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            // SSE 流式消费：progress 帧更新状态行，meta 帧定最终状态
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const data = line.slice(6);
                    if (data === "[DONE]") break;
                    if (data.startsWith("[ERROR]")) throw new Error(data.slice("[ERROR]".length).trim());
                    let parsed;
                    try { parsed = JSON.parse(data); } catch { continue; }
                    if (parsed.meta) { lastMeta = parsed.meta; continue; }
                    const p = parsed.progress;
                    if (!p) continue;
                    if (p.phase === "standardize") {
                        const n = (p.converted || []).length + (p.renamed || []).length;
                        setStatus("running", `标准化目录：已处理 ${n} 个文件` + (p.backup ? `，原件已备份到 ${p.backup}` : ""));
                    } else {
                        const mark = p.status === "ok" ? "✓" : "✗";
                        setStatus("running", `打标 ${p.index}/${p.total} · ${p.file} ${mark}`);
                        // 实时预览当前图片与标签，随下一帧自动切换
                        previewBox.style.display = "";
                        previewImg.src = `/neo_gallery/thumbnail?filename=${encodeURIComponent(p.file)}&subfolder=${encodeURIComponent(dirPath)}&size=400`;
                        previewCaption.textContent = p.status === "ok" ? (p.caption || "") : `打标失败：${p.error || ""}`;
                    }
                }
            }
            if (lastMeta && lastMeta.status === "error") throw new Error(lastMeta.error);
            if (lastMeta) {
                const failed = lastMeta.failed || [];
                setStatus(failed.length ? "error" : "success",
                    `打标完成 ${lastMeta.done}/${lastMeta.total}` +
                    (failed.length ? `，${failed.length} 张失败：${failed.map((f) => f.file).join("、")}` : ""));
                if (!failed.length) {
                    actionToast({ severity: "success", summary: "LoRA 打标完成", detail: `已写入 ${lastMeta.done} 个标签文件` });
                } else {
                    actionToast({ severity: "warning", summary: "部分图片打标失败", detail: `${failed.length}/${lastMeta.total} 失败` });
                }
            }
            // 重显当前目录，让重命名后的文件与新 .txt 立即可见
            const [source, ...segs] = dirPath.split("/");
            if (typeof gallery.showDirectoryStructure === "function") {
                await gallery.showDirectoryStructure(source, segs);
            }
        } catch (err) {
            setStatus("error", err.message || String(err));
        } finally {
            busy = false;
        }
    }
    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-lt-modal-overlay" });
    const modal = $el("div", {
        className: "neo-gallery-story-modal",
        onclick: e => e.stopPropagation(),
    }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "LoRA 打标" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "×", onclick: close }),
        ]),
        $el("div", { className: "neo-gallery-lt-dir", title: dirPath, textContent: dirPath }),
        $el("div", { className: "neo-gallery-lt-trigger-row" }, [
            $el("span", { className: "neo-gallery-lt-label", textContent: "触发词" }),
            triggerInput,
        ]),
        stdRow,
        previewBox,
        statusBox,
        $el("div", { className: "neo-gallery-story-actions" }, [
            $el("button", { className: "neo-gallery-story-btn", textContent: "取消", onclick: close }),
            $el("button", { className: "neo-gallery-story-btn neo-gallery-story-btn-primary", textContent: "开始打标", onclick: run }),
        ]),
    ]);
    overlay.onclick = () => close();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setStatus("idle", "输入触发词后点「开始打标」，每张图片会写入标准化标签 .txt");
    // preflight：图片数 + 建议触发词（文件夹名拼音首字母），失败不阻塞
    fetch(`/neo_gallery/tag_preflight?dir=${encodeURIComponent(dirPath)}`)
        .then((r) => r.json())
        .then((data) => {
            if (typeof data.image_count === "number") {
                setStatus("idle", `${data.image_count} 张图片 · 输入触发词后点「开始打标」`);
            }
            if (data.suggested_trigger && !triggerInput.value.trim()) {
                triggerInput.value = data.suggested_trigger;
            }
        })
        .catch(() => {});

    document.addEventListener("keydown", onKey);
}




/** 图片编辑弹窗：以卡片原图为参考，用所选生图/编辑技能 + 用户输入的编辑指令生成新图。
 * 默认 Qwen Image 2.1，可在下拉中切换其他 image_gen 类技能。 */
export function openImageEditDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-edit-modal-overlay')?.remove();
    const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    const promptInput = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 4,
        placeholder: "描述你想对这张图做的修改，例如：把背景换成海边日落、给角色加一顶帽子……"
    });

    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let refName = null;

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-edit-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    // 技能下拉：只列 image_gen 类（直接生图或编辑），默认 Qwen Image 2.1
    const skillSel = $el("select", { className: "neo-recipes-sort" });
    (async () => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const genSkills = (Array.isArray(skills) ? skills : []).filter(s => s.category === "image_gen" && s.gen_image);
            genSkills.forEach(s => {
                const opt = $el("option", { value: s.id, textContent: s.cn_name || s.name || s.id });
                if (s.id === QWEN_IMAGE_SKILL_ID) opt.selected = true;
                skillSel.appendChild(opt);
            });
            if (!genSkills.some(s => s.id === QWEN_IMAGE_SKILL_ID)) {
                skillSel.value = genSkills.length ? genSkills[0].id : "";
            }
        } catch {
            skillSel.value = QWEN_IMAGE_SKILL_ID;
        }
    })();

    const renderIdle = () => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: "填写编辑指令后点「生成」，原图将作为参考图传入所选技能。" }));
        fill(actionsBox, btn("取消", close), btn("生成", start, true));
    };

    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        const bar = $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]);
        fill(statusBox,
            $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]),
            bar);
        fill(actionsBox, btn("取消任务", () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        if (images.length > 0) {
            const resultSrc = `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`;
            resultImg.src = resultSrc;
            resultImg.style.display = "block";
            resultImg.title = "点击放大查看";
            resultImg.onclick = () => Lightbox.open({ 
                items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), 
                index: 0 
            });
        }
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: "已生成编辑结果。" }));
        // 保留「再生成」入口：编辑支持连续重复生成，不必关窗重开（与 renderError 的「重试」一致）
        fill(actionsBox, btn("再生成", start), btn("关闭", close, true));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || "生成失败" }));
        fill(actionsBox, btn("重试", start), btn("关闭", close));
    };

    const start = async () => {
        if (running) return;
        const prompt = promptInput.value.trim();
        if (!prompt) { promptInput.focus(); return; }
        running = true;
        cancelRequested = false;
        renderRunning("排队中…");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            const snap = await requestGeneration({
                skill_id: skillSel.value || QWEN_IMAGE_SKILL_ID,
                prompt,
                width: parseInt(widthInput.value, 10) || undefined,
                height: parseInt(heightInput.value, 10) || undefined,
                references: [{ kind: "input", value: refName }],
                loras: [],
                skip_enhance: true,
            });
            cancelId = snap.task_id;
            renderRunning("排队中…");
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError("已取消");
            else renderError(final.error || "生成失败");
        } catch (e) {
            console.error('[Gallery] image edit failed:', e);
            renderError(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 图片对比区（左右并排）
    const origFullUrl = `/neo_gallery/image?filename=${encodeURIComponent(image.filename || image.name)}&subfolder=${encodeURIComponent(subfolder || "")}`;
    const origImg = $el("img", {
        className: "neo-gallery-edit-compare-img",
        src: origFullUrl,
        alt: image.name || image.filename,
        title: "点击放大查看",
        onclick: () => {
            Lightbox.open({
                items: [{ kind: "image", url: origFullUrl, title: pathLabel }],
                index: 0
            });
        }
    });
    const resultImg = $el("img", {
        className: "neo-gallery-edit-compare-img",
        alt: "编辑结果",
        style: { display: "none" }
    });
    const compareBox = $el("div", { className: "neo-gallery-edit-compare" }, [
        $el("div", {}, [
            $el("div", { className: "neo-gallery-edit-compare-label", textContent: "原图" }),
            origImg
        ]),
        $el("div", { className: "neo-gallery-edit-compare-result" }, [
            $el("div", { className: "neo-gallery-edit-compare-label", textContent: "编辑结果" }),
            resultImg
        ])
    ]);

    overlay.appendChild($el("div", { className: "neo-gallery-story-modal neo-gallery-edit-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "\uD83D\uDDBC\uFE0F 图片编辑" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        compareBox,
        $el("div", { className: "neo-gallery-edit-form" }, [
            $el("div", { className: "neo-gallery-edit-form-top-row" }, [
                $el("div", { className: "neo-gallery-story-form-row" }, [
                    $el("label", { className: "neo-director-field-label", textContent: "编辑技能" }),
                    skillSel
                ]),
                $el("div", { className: "neo-gallery-story-form-row" }, [
                    $el("label", { className: "neo-director-field-label", textContent: "目标分辨率" }),
                    $el("input", { type: "number", className: "neo-recipes-sort", id: "img-edit-width", min: 256, max: 8192, step: 16, placeholder: "宽" }),
                    $el("span", { textContent: " × " }),
                    $el("input", { type: "number", className: "neo-recipes-sort", id: "img-edit-height", min: 256, max: 8192, step: 16, placeholder: "高" })
                ])
            ]),
            promptInput,
            statusBox,
            actionsBox
        ])
    ]));

    renderIdle();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);

    // 加载原图获取实际尺寸，填入默认分辨率
    const widthInput = overlay.querySelector("#img-edit-width");
    const heightInput = overlay.querySelector("#img-edit-height");
    const fullUrl = `/neo_gallery/image?filename=${encodeURIComponent(image.filename || image.name)}&subfolder=${encodeURIComponent(subfolder || "")}`;
    const dimProbe = new Image();
    dimProbe.onload = () => {
        if (dimProbe.naturalWidth && dimProbe.naturalHeight) {
            widthInput.value = dimProbe.naturalWidth;
            heightInput.value = dimProbe.naturalHeight;
        }
    };
    dimProbe.src = fullUrl;

    setTimeout(() => promptInput.focus(), 0);
}


/** 素材卡片「⋯」菜单里的生成入口（角色图 / 九宫格分镜图 / 图片编辑），由 gallery-card.js 展开使用。 */
export function buildGenerationMenuItems({ card, gallery, image, subfolder }) {
    return [
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: "用 Qwen Image 2.1 基于这张人像生成头特写+正/侧/背四视图角色设定图；窗口内可看进度与结果预览，完成后拖入配方的 👤 角色参考图",
            onclick: () => { card._removeCollectMenu(); openCharacterSheetDialog(gallery, image, subfolder); }
        }, ["\uD83E\uDDAC 生成角色图（多视图）"]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: "以这张图为参考、按所选宫格技能与故事生成分镜图（每格一镜，可直接进导演编辑器「🧩 宫格分镜图拆分」切成视频关键帧）",
            onclick: () => { card._removeCollectMenu(); openStoryboardDialog(gallery, image, subfolder); }
        }, ["\uD83E\uDDE9 生成九宫格分镜图"]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: "以这张图为参考进行 AI 编辑（默认 Qwen Image 2.1，可在弹窗内切换其他生图/编辑技能）",
            onclick: () => { card._removeCollectMenu(); openImageEditDialog(gallery, image, subfolder); }
        }, ["\uD83D\uDDBC\uFE0F 图片编辑"]) : null,
    ];
}


/** 画廊搜索行「🖼️ 生成素材」：纯提示词一键生成新素材（默认 Krea2 文生图），产物落 Output/NeoAgent/<日期>，素材面板可直接浏览。 */
export function openGenMaterialDialog(gallery) {
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    // agent 式双框（chat 习惯）：output 在上（增强提示词，作最终生成提示词；为空时回退 quick input）
    // + quick input 在下（描述 / 修改指令，增强后保留不自动清空），与 NeoPromptAgent 节点的输入/输出结构一致
    const quickInput = $el("textarea", {
        className: "neo-gallery-gm-quick-input",
        rows: 2,
        placeholder: "描述要生成的素材，例如：红色陶瓷杯的白底产品图……或输入修改指令（↑/↓ 调出历史）"
    });

    // 快捷输入命令终端式历史：↑/↓ 召回之前生成用过的提示词（localStorage 持久化，最新在前，上限 20）
    const gmHistory = createQuickInputHistory(quickInput, { storageKey: "neo.gallery.gen_material.quick_history" });
    // 占位符提示轮播（参考 llm-chat QUICK_INPUT_TIPS）：聚焦且为空时每 5s 换一条
    const GM_QUICK_TIPS = [
        "📷 描述要生成的素材，例如：红色陶瓷杯的白底产品图",
        "✏️ 输入修改指令，例如：去掉动漫风格，改成写实",
        "🎨 加风格要求，例如：改成赛博朋克风格",
        "✨ 输入描述后点「增强」，LLM 帮你扩写成详细提示词",
        "🎲 点 🎲 随机填入一条提示词（配方不入池）",
        "⬆️ 按 ↑/↓ 召回之前生成用过的提示词"
    ];
    let tipTimer = null;
    const setQuickTip = () => { if (!quickInput.value.trim()) quickInput.placeholder = GM_QUICK_TIPS[Math.floor(Math.random() * GM_QUICK_TIPS.length)]; };
    const stopQuickTips = () => { if (tipTimer) { clearInterval(tipTimer); tipTimer = null; } };
    quickInput.addEventListener("focus", () => { setQuickTip(); stopQuickTips(); tipTimer = setInterval(setQuickTip, 5000); });
    quickInput.addEventListener("blur", () => { stopQuickTips(); setQuickTip(); });
    const outputInput = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 4,
        placeholder: "增强后的提示词会显示在这里（不增强时可直接填写，↑/↓ 调出历史）"
    });
    // output 框独立 ↑/↓ 历史：只记生成实际用过的最终提示词（增强长文 / 手填内容），与快捷输入历史互不相干
    const gmOutputHistory = createQuickInputHistory(outputInput, { storageKey: "neo.gallery.gen_material.output_history" });

    // ── llm-chat 式布局：🎲 随机填入 / ▾ 运行时随机设置 / ☰ 预设列表（无配方条目）浮出在 output 框右下角；增强技能下拉 + ✨ 增强集成在 quick input 内部底边 ──
    const GM_RANDOM_KEY = "neo.gallery.gen_material.runtime_random";
    let gmRandom = { enabled: false, count: 1 };
    try {
        const saved = JSON.parse(localStorage.getItem(GM_RANDOM_KEY) || "null");
        if (saved && typeof saved === "object") {
            gmRandom = { enabled: !!saved.enabled, count: Math.max(1, Math.min(parseInt(saved.count, 10) || 1, 16)) };
        }
    } catch {}
    const saveGmRandom = () => { try { localStorage.setItem(GM_RANDOM_KEY, JSON.stringify(gmRandom)); } catch {} };

    const randomBtn = $el("button", { className: "neo-gallery-gm-tool-btn", type: "button", textContent: "🎲", title: "随机填入一条提示词" });
    const randomCaret = $el("button", { className: "neo-gallery-gm-tool-btn", type: "button", textContent: "▾", title: "运行时随机设置" });
    const presetBtn = $el("button", { className: "neo-gallery-gm-tool-btn", type: "button", textContent: "☰", title: "预设列表" });
    // 浮出按钮组（参考 llm-chat rs-button-group）：output 框右下角，半透明、hover 变实
    const randomWrap = $el("div", { className: "neo-gallery-gm-random-wrap" }, [randomBtn, randomCaret]);
    const floatGroup = $el("div", { className: "neo-gallery-gm-float-group" }, [randomWrap, presetBtn]);
    const outputWrap = $el("div", { className: "neo-gallery-gm-output-wrap" }, [outputInput, floatGroup]);

    // 运行时随机设置菜单（复用 Prompt Agent 节点的运行时菜单样式；状态 localStorage 持久化）
    const runtimeMenu = $el("div", { className: "rs-runtime-menu" });
    const runtimeCheck = $el("input", { type: "checkbox" });
    runtimeCheck.checked = gmRandom.enabled;
    const countValEl = $el("span", { className: "rs-runtime-count-val", textContent: String(gmRandom.count) });
    const mkCountBtn = (delta) => {
        const b = $el("button", { className: "rs-runtime-count-btn", type: "button" });
        b.textContent = delta > 0 ? "+" : "−";
        b.addEventListener("click", () => {
            gmRandom.count = Math.max(1, Math.min(gmRandom.count + delta, 16));
            countValEl.textContent = String(gmRandom.count);
            saveGmRandom();
        });
        return b;
    };
    runtimeMenu.append(
        $el("label", { className: "rs-runtime-row rs-runtime-toggle" }, [
            runtimeCheck,
            $el("span", { className: "rs-runtime-row-text", textContent: "运行时随机抽取提示词" })
        ]),
        $el("div", { className: "rs-runtime-row" }, [
            mkCountBtn(-1), countValEl, mkCountBtn(1),
            $el("span", { className: "rs-runtime-row-text", textContent: "张（批量生成）" })
        ])
    );
    const syncRandomState = () => {
        randomBtn.classList.toggle("neo-gallery-gm-tool-on", gmRandom.enabled);
        randomCaret.classList.toggle("neo-gallery-gm-tool-on", gmRandom.enabled);
    };
    runtimeCheck.addEventListener("change", () => {
        gmRandom.enabled = runtimeCheck.checked;
        saveGmRandom();
        syncRandomState();
    });
    syncRandomState();

    // 预设列表浮层（复用预设列表样式；配方不入池，点击填入提示词框）
    const presetOverlay = $el("div", { className: "rs-preset-list-overlay" });
    const presetHeader = $el("div", { className: "rs-preset-header" }, [
        $el("input", { className: "rs-preset-search-input", type: "text", placeholder: "🔍 搜索预设…" }),
        $el("button", { className: "rs-preset-close", type: "button", textContent: "×" })
    ]);
    const presetSearch = presetHeader.querySelector("input");
    presetHeader.querySelector("button").addEventListener("click", () => { presetOverlay.style.display = "none"; outputInput.focus(); });
    const presetBody = $el("div", { className: "rs-preset-list-body" });
    presetOverlay.append(presetHeader, presetBody);

    let presetItems = null; // 本次弹窗会话缓存
    const renderPresetList = (query) => {
        presetBody.textContent = "";
        const q = (query || "").trim().toLowerCase();
        const items = (presetItems || []).filter(it => !q || it.name.toLowerCase().includes(q));
        if (!items.length) {
            presetBody.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: q ? "无匹配预设" : "暂无预设" }));
            return;
        }
        items.forEach(it => {
            const row = $el("div", { className: "rs-preset-item" }, [
                $el("span", { className: "rs-preset-content", textContent: it.name }),
                $el("span", { className: "rs-source-badge", textContent: it.source === "presets" ? "预设" : "自定义" })
            ]);
            row.addEventListener("click", async () => {
                try {
                    const data = await loadPrompt(it.name);
                    outputInput.value = data.text || "";
                    presetOverlay.style.display = "none";
                    outputInput.focus();
                } catch (e) {
                    console.error("[Gallery] load preset failed:", e);
                    actionToast({ severity: "error", summary: "加载预设失败", detail: String(e?.message || e) });
                }
            });
            presetBody.appendChild(row);
        });
    };
    const openPresetList = async () => {
        presetOverlay.style.display = "flex";
        presetSearch.value = "";
        if (!presetItems) {
            presetBody.textContent = "加载中…";
            try { presetItems = await listPrompts(); } catch (e) { console.error("[Gallery] list prompts failed:", e); presetItems = []; }
        }
        renderPresetList("");
        presetSearch.focus();
    };
    presetSearch.addEventListener("input", () => renderPresetList(presetSearch.value));


    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let deleting = false;
    let randomPicking = false;

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-gm-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    // 技能下拉：只列纯文生图技能（不需要参考图）；记住上次选中的技能（localStorage），失效时回 Krea2 文生图
    const skillSel = $el("select", { className: "neo-recipes-sort" });
    let rememberedSkill = "";
    try { rememberedSkill = localStorage.getItem(GM_LAST_SKILL_KEY) || ""; } catch {}
    // 拉技能列表重建下拉（打开时与保存新技能后调用）；preferId 优先选中（刚保存的新技能）
    const fillSkillOptions = async (preferId) => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const genSkills = (Array.isArray(skills) ? skills : []).filter(s => s.gen_image && !s.requires_ref);
            skillSel.textContent = "";
            genSkills.forEach(s => skillSel.appendChild($el("option", { value: s.id, textContent: s.cn_name || s.name || s.id })));
            const ids = genSkills.map(s => s.id);
            if (preferId && ids.includes(preferId)) skillSel.value = preferId;
            else if (rememberedSkill && ids.includes(rememberedSkill)) skillSel.value = rememberedSkill;
            else skillSel.value = ids.includes(KREA2_T2I_SKILL_ID) ? KREA2_T2I_SKILL_ID : (ids[0] || "");
        } catch {
            skillSel.value = KREA2_T2I_SKILL_ID;
        }
        applySkillModelConfig(skillSel.value); // 自定参数同步为该技能配置（模型列表未就绪时为空操作）
    };
    fillSkillOptions();
    // 选中变化即写入 localStorage：下次打开沿用该技能（关窗不清除）；自定参数同步切到新技能
    skillSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_LAST_SKILL_KEY, skillSel.value); } catch {}
        applySkillModelConfig(skillSel.value);
    });

    // 增强 skill 下拉：与节点同源 populateSkillOptions（按分类分组），只列图像提示词增强技能
    // （category=image_enhance）；「默认」空值 = 后端 smart_prompt 自动路由；记住上次选择
    const enhanceSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-enhance-skill" });
    let rememberedEnhanceSkill = "";
    try { rememberedEnhanceSkill = localStorage.getItem(GM_ENHANCE_SKILL_KEY) || ""; } catch {}
    (async () => {
        try {
            const skills = await listSkills();
            enhanceSel.textContent = "";
            enhanceSel.appendChild($el("option", { value: "", textContent: "默认" }));
            populateSkillOptions(enhanceSel, skills.filter(s => s.category === "image_enhance"));
            const ids = [...enhanceSel.options].map(o => o.value);
            if (rememberedEnhanceSkill && ids.includes(rememberedEnhanceSkill)) enhanceSel.value = rememberedEnhanceSkill;
        } catch { /* 拉取失败保持「默认」 */ }
    })();
    enhanceSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_ENHANCE_SKILL_KEY, enhanceSel.value); } catch {}
    });

    // 自定参数：本次临时选主模型 / LoRA / 比例 / 最长边（类似节点上接模型），空值 = 跟随全局生图设置；
    // Text Encoder / VAE 很少变，弹窗里不露出（共享组件保留行，这里裁掉）
    const modelCfg = createModelConfigSection();
    for (const row of modelCfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
    const modelBox = $el("div", { className: "neo-gallery-gm-model-box", style: { display: "none" } });
    modelBox.appendChild(modelCfg.el);
    // 宽高比 / 最长边：本次临时覆盖（空值 = 跟随技能配置 / 全局设置），同行紧凑布局
    // 宽高比选项与导演编辑页同源（DIRECTOR_ASPECTS）：值保持纯比例，显示带中文备注
    const GM_RATIO_OPTIONS = DIRECTOR_ASPECTS.map(([label]) => [label.split(" ")[0], label]);
    const GM_RATIOS = GM_RATIO_OPTIONS.map(([v]) => v);
    // 「默认」选项跟随值用无括号备注：16:9 (宽屏) → 16:9 宽屏，避免嵌套括号
    const GM_RATIO_AUTO_TEXT = Object.fromEntries(DIRECTOR_ASPECTS.map(([label]) => {
        const [v, note] = label.split(" ");
        return [v, `${v} ${note.replace(/[()]/g, "")}`];
    }));
    const GM_EDGES = ["1024", "1152", "1280", "1536", "1792", "2048", "2560", "3072"];
    const makeGmSelect = (options) => {
        const select = document.createElement("select");
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "默认"; // 技能配置就绪后由 setGmAutoLabel 补上跟随值
        select.appendChild(auto);
        for (const opt of options) {
            const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
            const el = document.createElement("option");
            el.value = value;
            el.textContent = text;
            select.appendChild(el);
        }
        return select;
    };
    // 「默认」选项显示当前技能配置跟随的值（切换技能时更新）
    const setGmAutoLabel = (sel, v) => { sel.options[0].textContent = v ? `默认 (${v})` : "默认"; };
    const sizeRow = $el("div", { className: "rs-config-row neo-gallery-gm-size-row" });
    sizeRow.appendChild($el("label", { className: "rs-form-label", textContent: "宽高比" }));
    const ratioSel = makeGmSelect(GM_RATIO_OPTIONS);
    sizeRow.appendChild(ratioSel);
    sizeRow.appendChild($el("label", { className: "rs-form-label", textContent: "最长边" }));
    const edgeSel = makeGmSelect(GM_EDGES);
    sizeRow.appendChild(edgeSel);
    modelBox.appendChild(sizeRow);
    // 💾 保存为新技能：把当前选的「主模型 + LoRA + 宽高比 + 最长边」存成新技能（名称自动生成 = 主模型名+LoRA 名，其余设置沿用当前技能）
    const saveSkillBtn = $el("button", {
        className: "neo-gallery-gm-save-skill",
        type: "button",
        textContent: "💾 保存为新技能",
        style: { display: "none" },
    });
    modelBox.appendChild(saveSkillBtn);
    // 选中了主模型或 LoRA 才显示（委托：覆盖区内任意下拉 / 强度输入变化）
    const refreshSaveSkillBtn = () => {
        const ov = modelCfg.collect();
        saveSkillBtn.style.display = (ov.model || ov.loras.length) ? "" : "none";
    };
    modelBox.addEventListener("change", refreshSaveSkillBtn);
    let savingSkill = false;
    saveSkillBtn.addEventListener("click", async () => {
        if (savingSkill) return;
        const ov = modelCfg.collect();
        if (!ov.model && !ov.loras.length) return;
        savingSkill = true;
        saveSkillBtn.textContent = "💾 保存中…";
        try {
            const res = await fetch("/neo_image_gen/save_combo_skill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skill_id: skillSel.value || KREA2_T2I_SKILL_ID, model: ov.model, loras: ov.loras, ratio: ratioSel.value, edge: edgeSel.value }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            // 新技能已进列表 → 直接选中并记住（下次打开沿用该组合）
            await fillSkillOptions(data.id);
            try { localStorage.setItem(GM_LAST_SKILL_KEY, data.id); } catch {}
            actionToast({ severity: "success", summary: `已保存为新技能「${data.name}」` });
        } catch (e) {
            console.error("[Gallery] save combo skill failed:", e);
            actionToast({ severity: "error", summary: "保存为新技能失败", detail: String(e?.message || e) });
        } finally {
            savingSkill = false;
            saveSkillBtn.textContent = "💾 保存为新技能";
            refreshSaveSkillBtn();
        }
    });
    // 每次打开都默认「自动」（跟随全局设置），不预填已配置值——否则关窗重开像上次选择没清除；
    // 模型列表拉取失败时覆盖区保持空下拉（等效跟随设置），不挡生成
    let genModels = null; // 打开时拉取的模型列表，切换技能重放配置时复用
    // 切换生成技能后把自定参数同步为该技能配置的主模型 / LoRA / 比例 / 最长边（无配置 = 自动跟随全局设置）
    async function applySkillModelConfig(skillId) {
        if (!genModels) return; // 模型列表未就绪：首次加载 / 技能列表回调稍后会应用
        const cfg = await getSkillGenConfig(skillId);
        modelCfg.load(cfg, genModels);
        ratioSel.value = GM_RATIOS.includes(cfg.default_ratio) ? cfg.default_ratio : "";
        edgeSel.value = GM_EDGES.includes(String(cfg.base_resolution)) ? String(cfg.base_resolution) : "";
        setGmAutoLabel(ratioSel, cfg.default_ratio ? (GM_RATIO_AUTO_TEXT[cfg.default_ratio] || cfg.default_ratio) : "");
        setGmAutoLabel(edgeSel, cfg.base_resolution);
    }
    (async () => {
        try {
            genModels = await listGenModels();
            modelCfg.load({}, genModels); // 先按「自动」渲染，避免下拉为空
            applySkillModelConfig(skillSel.value); // 再覆盖为当前技能配置
        } catch {
            // 同上：静默保持「自动」
        }
    })();
    const modelToggle = $el("button", {
        className: "neo-gallery-gm-model-toggle",
        type: "button",
        textContent: "⚙️ 自定参数 ▸",
    });
    modelToggle.addEventListener("click", () => {
        const open = modelBox.style.display === "none";
        modelBox.style.display = open ? "" : "none";
        modelToggle.textContent = `⚙️ 自定参数 ${open ? "▾" : "▸"}`;
    });

    // ✨ 增强：仿 NeoPromptAgent 节点——quick input + output 双框，复用节点 agent 逻辑
    // （所选增强 skill 的 skill.md 作系统提示词 + 按需读引用文件）直调 /rs_prompts/stream_generate_prompt；
    // 输出框行为与节点共用（思考面板 / 流程状态行 / rAF 批量写回）；quick input 有内容时与
    // output 已有提示词按 \n\n---\n\n 拼接（同节点），增强结束后 quick input 保留不自动清空
    const enhanceBtn = $el("button", { className: "neo-gallery-story-btn", textContent: "✨ 增强" });
    // quick input 内部底边工具栏（参考 llm-chat rs-input-toolbar）：增强技能下拉在左（flex）+ ✨ 增强在右
    const gmInputToolbar = $el("div", { className: "neo-gallery-gm-input-toolbar" }, [enhanceSel, enhanceBtn]);
    const quickWrap = $el("div", { className: "neo-gallery-gm-quick-wrap" }, [quickInput, gmInputToolbar]);
    let enhancing = false;
    enhanceBtn.addEventListener("click", async () => {
        if (enhancing || running) return;
        const quickText = quickInput.value.trim();
        const outputText = outputInput.value.trim();
        const text = quickText ? (outputText ? `${outputText}\n\n---\n\n${quickText}` : quickText) : outputText;
        if (!text) { quickInput.focus(); return; }
        // 快捷输入内容记入历史（增强产物是 LLM 长文，不入史；与节点一致在提交时记录）
        if (quickText) gmHistory.record(quickText);
        enhancing = true;
        enhanceBtn.textContent = "⏳ 增强中…";
        try {
            await invokePromptStream({ text, skillId: enhanceSel.value }, createStreamOutputHandlers({
                textarea: outputInput,
                onDone: (acc) => {
                    if (!acc.trim()) actionToast({ severity: "warning", summary: "增强失败", detail: "LLM 未返回内容" });
                    outputInput.focus();
                },
                onError: (e) => {
                    console.error("[Gallery] gen material enhance failed:", e);
                    actionToast({ severity: "error", summary: "提示词增强失败", detail: String(e?.message || e), actionLabel: "打开 LLM 设置", onAction: openLLMSettingsModal });
                }
            }));
        } finally {
            enhancing = false;
            enhanceBtn.textContent = "✨ 增强";
        }
    });

    const renderIdle = () => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: "填写素材描述后点「生成」，图片保存到 Output 目录（NeoAgent/<日期>），可在素材面板浏览。" }));
        fill(actionsBox, btn("取消", close), btn("生成", start, true));
    };

    // 预览区：生成中显示占位（spinner + 进度条），成功后结果图原位替换它（同一容器复用，布局不跳）
    const previewBox = $el("div", { className: "neo-gallery-gm-preview" });

    const renderRunning = (label, progress, preview) => {
        previewBox.className = "neo-gallery-gm-preview";
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        // 采样中拿到实时预览图（与节点预览同源）时替换 spinner，否则显示占位
        const runningRow = preview
            ? $el("img", { className: "neo-gallery-gm-preview-img", src: preview, alt: label })
            : $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]);
        fill(previewBox,
            runningRow,
            $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]));
        fill(statusBox, previewBox);
        fill(actionsBox, btn("取消任务", () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };


    // 成功后：结果图已在位（单张=1 图 / 批量=网格图），这里只补提示 + 操作按钮
    const renderGenDone = (images, hint) => {
        const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
        if (oldHint) oldHint.remove();
        statusBox.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: hint }));
        // 打开输出目录：跳到 Output 下实际落盘的日期子目录（窗口保留，可继续再生成/删除）
        const openOutputDir = () => {
            const sub = images.map(i => i.subfolder).find(Boolean);
            openGallerySidebar("Output", sub ? sub.split("/").filter(Boolean) : []);
        };
        // 删除：结果不满意 → 直接删掉落盘文件（含 .txt 与缩略图缓存），删完回 idle 原地再生成
        const deleteResult = async () => {
            if (!images.length || deleting) return;
            deleting = true;
            try {
                for (const im of images) {
                    const ok = await gallery.deleteItem(im.filename, im.subfolder || "", { silent: true });
                    if (!ok) { actionToast({ severity: "error", summary: "删除失败", detail: `无法删除 ${im.filename}` }); break; }
                }
                renderIdle();
            } catch (e) {
                console.error("[Gallery] gen material delete failed:", e);
                actionToast({ severity: "error", summary: "删除失败", detail: String(e?.message || e) });
            } finally {
                deleting = false;
            }
        };
        fill(actionsBox, btn("打开输出目录", openOutputDir), btn("再生成", start), btn("删除", deleteResult), btn("关闭", close, true));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        // 结果图原位替换预览区：复用同一容器，只换类名与内容
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            previewBox.appendChild(img);
        }
        renderGenDone(images, "已生成，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。");
    };

    // 提交一次生图任务并等终态；render(snap) 随快照推送刷新 UI（单张=整个预览区 / 批量=当前行原位更新）
    const runOnePrompt = async (promptText, render) => {
        // 自定参数只带非空值：空串 / 空数组会覆盖掉全局设置里的显式配置
        const payload = {
            skill_id: skillSel.value || KREA2_T2I_SKILL_ID,
            prompt: promptText,
            skip_enhance: true,
        };
        const ov = modelCfg.collect();
        if (ov.model) payload.model = ov.model;
        if (ov.loras.length) payload.loras = ov.loras;
        if (ratioSel.value) payload.default_ratio = ratioSel.value;
        if (edgeSel.value) payload.base_resolution = parseInt(edgeSel.value, 10);
        const snap = await requestGeneration(payload);
        cancelId = snap.task_id;
        return await watchTask(snap.task_id, render, () => cancelRequested);
    };

    // 运行时随机批量：逐张生成，成功即把结果图追加进网格；取消时保留已生成的
    const runBatch = async (prompts) => {
        const total = prompts.length;
        const results = [];
        fill(statusBox, previewBox); // 结果区挂到上方区域（与单张模式复用同一容器）
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        for (let i = 0; i < total; i++) {
            if (cancelRequested) break;
            const runningRow = $el("div", { className: "neo-gallery-gm-batch-item" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: `生成 ${i + 1}/${total}（排队中…）` })
            ]);
            previewBox.appendChild(runningRow);
            fill(actionsBox, btn("取消任务", () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
            let final;
            try {
                final = await runOnePrompt(prompts[i], s => {
                    runningRow.lastChild.textContent = `生成 ${i + 1}/${total}（${s.status === "running" ? "生图中" : "排队中"}…）`;
                });
            } catch (e) {
                runningRow.remove();
                throw e;
            }
            runningRow.remove();
            if (final.status === "succeeded") {
                results.push(final);
                const images = final.images || [];
                if (images.length > 0) {
                    const img = $el("img", {
                        className: "neo-gallery-cs-result-img",
                        src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                        alt: images[0].filename
                    });
                    img.addEventListener("click", () => Lightbox.open({ items: results.flatMap(f => (f.images || []).map(im => ({ kind: "image", url: im.url, title: im.filename }))), index: 0 }));
                    previewBox.appendChild(img);
                }
            } else if (final.status === "cancelled") {
                break;
            } else {
                // 中途失败：保留已生成的图，错误显示在其下方
                const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
                if (oldHint) oldHint.remove();
                statusBox.appendChild($el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: `第 ${i + 1}/${total} 张生成失败：${final.error || "未知错误"}` }));
                fill(actionsBox, btn("再生成", start), btn("关闭", close, true));
                return;
            }
        }
        if (!results.length) { renderError("已取消"); return; }
        renderGenDone(results.flatMap(f => f.images || []), `已生成 ${results.length}/${total} 张，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。`);
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || "生成失败" }));
        fill(actionsBox, btn("重试", start), btn("关闭", close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: "素材生成失败", detail: message, actionLabel: "打开技能详情", onAction: () => openSkillDetailById(skillSel.value || KREA2_T2I_SKILL_ID) });
    };

    // 🎲 随机填入（与批量同池抽一条，配方不入池）
    randomBtn.addEventListener("click", async () => {
        if (randomPicking || running) return;
        randomPicking = true;
        randomBtn.textContent = "⏳";
        try {
            const data = await randomPrompts(1);
            const text = (data.texts || [])[0] || "";
            if (text.trim()) {
                outputInput.value = text;
                outputInput.focus();
            } else {
                actionToast({ severity: "error", summary: "随机提示词失败", detail: "提示词库为空" });
            }
        } catch (e) {
            console.error("[Gallery] random prompt failed:", e);
            actionToast({ severity: "error", summary: "随机提示词失败", detail: String(e?.message || e) });
        } finally {
            randomPicking = false;
            randomBtn.textContent = "🎲";
        }
    });

    // ▾ 运行时随机设置菜单（挂在弹窗 overlay 上，随窗移除）
    let runtimeMenuOpen = false;
    const closeRuntimeMenu = () => { runtimeMenuOpen = false; runtimeMenu.style.display = "none"; };
    randomCaret.addEventListener("click", (e) => {
        e.stopPropagation();
        if (runtimeMenuOpen) { closeRuntimeMenu(); return; }
        runtimeMenuOpen = true;
        runtimeMenu.style.display = "block";
        const r = randomCaret.getBoundingClientRect();
        runtimeMenu.style.left = `${r.left}px`;
        runtimeMenu.style.top = `${r.bottom + 6}px`;
    });
    const onDocClick = (e) => {
        if (runtimeMenuOpen && !runtimeMenu.contains(e.target)) closeRuntimeMenu();
    };
    document.addEventListener("click", onDocClick);

    // ☰ 预设列表（无配方条目，点击填入提示词框）
    presetBtn.addEventListener("click", () => {
        closeRuntimeMenu();
        openPresetList();
    });


    const start = async () => {
        if (running) return;
        let prompts;
        if (gmRandom.enabled) {
            // 运行时随机：从节点同池抽 N 条不重复提示词，逐张批量生成（配方不入池）
            const n = Math.max(1, Math.min(gmRandom.count || 1, 16));
            renderRunning(`抽取 ${n} 条随机提示词…`);
            let res;
            try {
                res = await randomPrompts(n);
            } catch (e) {
                console.error("[Gallery] random prompts failed:", e);
                failGen(String(e?.message || e));
                return;
            }
            prompts = (res.texts || []).filter(t => t && t.trim());
            if (!prompts.length) { failGen("提示词库为空，抽不到随机提示词"); return; }
        } else {
            // 生成用 output 内容作最终提示词（为空回退 quick input），固定 skip_enhance
            const prompt = outputInput.value.trim() || quickInput.value.trim();
            if (!prompt) { quickInput.focus(); return; }
            prompts = [prompt];
        }
        const batch = prompts.length > 1;
        // 两份历史各自独立：output 为空记快捷输入，非空记 output 的最终提示词（批量模式不记）
        if (!batch) {
            if (outputInput.value.trim()) gmOutputHistory.record(prompts[0]);
            else gmHistory.record(prompts[0]);
        }
        running = true;
        cancelRequested = false;
        try {
            if (!batch) {
                renderRunning("排队中…");
                const final = await runOnePrompt(prompts[0], s => renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress, s.preview));
                if (final.status === "succeeded") renderSuccess(final);
                else if (final.status === "cancelled") renderError("已取消");
                else failGen(final.error || "生成失败");
            } else {
                await runBatch(prompts);
            }
        } catch (e) {
            console.error('[Gallery] gen material failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") {
            // 有浮层先关浮层，无浮层才关窗
            if (runtimeMenuOpen) closeRuntimeMenu();
            else if (presetOverlay.style.display === "flex") presetOverlay.style.display = "none";
            else close();
        }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 结果区在上（预览/成品原位替换），输入区在下（技能 / 自定参数 / agent 式增强双框：output 上带 🎲☰ 浮出组、quick input 下内嵌 ✨ 工具栏），操作按钮收尾
    const modal = $el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "\uD83D\uDDBC\uFE0F 生成素材" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        statusBox,
        $el("div", { className: "neo-gallery-story-form-row" }, [
            $el("label", { className: "neo-director-field-label", textContent: "生成技能" }),
            skillSel,
            modelToggle
        ]),
        modelBox,
        outputWrap,
        quickWrap,
        actionsBox
    ]);
    overlay.appendChild(modal);
    // 浮层挂在 overlay 上（z-index 高于弹窗，随窗移除）
    overlay.append(runtimeMenu, presetOverlay);

    // 标题栏拖动：同导演编辑器模式——首次按下从居中切到绝对定位并记录起点，之后按鼠标位移更新 left/top；
    // 钳制保证窗口不会被拖出视口（始终留一条可点到的标题栏 / ✕）。
    const titlebar = modal.querySelector(".neo-gallery-story-titlebar");
    let dragging = false;
    let startMX = 0, startMY = 0, startL = 0, startT = 0;
    const onTitleMove = (e) => {
        if (!dragging) return;
        let left = startL + (e.clientX - startMX);
        let top = startT + (e.clientY - startMY);
        const w = modal.offsetWidth;
        left = Math.max(-w + 80, Math.min(left, window.innerWidth - 80));
        top = Math.max(0, Math.min(top, window.innerHeight - 44));
        modal.style.left = left + "px";
        modal.style.top = top + "px";
    };
    const onTitleUp = () => {
        dragging = false;
        window.removeEventListener("mousemove", onTitleMove);
        window.removeEventListener("mouseup", onTitleUp);
    };
    titlebar.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest("button, .neo-gallery-story-close")) return; // 关闭钮不触发拖动，标题栏其余空白可拖窗口
        const r = modal.getBoundingClientRect();
        if (!modal.style.left) { // 首次：从居中切到绝对定位，无跳变
            modal.style.position = "absolute";
            modal.style.left = r.left + "px";
            modal.style.top = r.top + "px";
        }
        startMX = e.clientX; startMY = e.clientY;
        startL = parseFloat(modal.style.left); startT = parseFloat(modal.style.top);
        dragging = true;
        window.addEventListener("mousemove", onTitleMove);
        window.addEventListener("mouseup", onTitleUp);
    });

    renderIdle();
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { stopQuickTips(); document.removeEventListener("keydown", onKey); document.removeEventListener("click", onDocClick); origRemove(); };
    document.body.appendChild(overlay);

    setTimeout(() => quickInput.focus(), 0);
}