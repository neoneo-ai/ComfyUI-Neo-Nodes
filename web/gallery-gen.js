/**
 * Gallery 素材卡片「一键生成」：角色图（多视图）与九宫格分镜图的请求体、弹窗 UI 与生成流程。
 * 从 gallery-card.js 拆出，固定走 Qwen Image 2.1 预设；输出分别落 Output/CharacterSheet 与 Output/StoryBoard。
 */

import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { getImageHeight, getThumbnailSrc, isImageFile } from "./gallery-utils.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, listSkills, populateSkillOptions } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, createModelConfigSection, listGenModels } from "./image-gen.js";
import { invokePromptStream, createStreamOutputHandlers } from "./prompt-service.js";

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
        fill(actionsBox, btn("打开输出目录", () => gallery.showDirectoryStructure(CHARACTER_SHEET_DIR, [])), btn("关闭", close, true));
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
        gallery.showDirectoryStructure(STORYBOARD_DIR, date ? [date] : []);
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
        fill(actionsBox, btn("打开输出目录", () => { openOutputDir(final); close(); }, true), btn("关闭", close));
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
    // + quick input 在下（描述 / 修改指令，增强成功后被消费清空），与 NeoPromptAgent 节点的输入/输出结构一致
    const quickInput = $el("textarea", {
        className: "neo-gallery-gm-quick-input",
        rows: 2,
        placeholder: "描述要生成的素材，例如：红色陶瓷杯的白底产品图……或输入修改指令"
    });
    const outputInput = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 4,
        placeholder: "增强后的提示词会显示在这里（不增强时可直接填写）"
    });

    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let deleting = false;

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
    };
    fillSkillOptions();
    // 选中变化即写入 localStorage：下次打开沿用该技能（关窗不清除）
    skillSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_LAST_SKILL_KEY, skillSel.value); } catch {}
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

    // 模型覆盖：本次临时选主模型 / LoRA（类似节点上接模型），空值 = 跟随全局生图设置；
    // Text Encoder / VAE 很少变，弹窗里不露出（共享组件保留行，这里裁掉）
    const modelCfg = createModelConfigSection();
    for (const row of modelCfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
    const modelBox = $el("div", { className: "neo-gallery-gm-model-box", style: { display: "none" } });
    modelBox.appendChild(modelCfg.el);
    // 💾 保存为新技能：把当前选的「主模型 + LoRA」组合存成新技能（名称自动生成 = 主模型名+LoRA 名，其余设置沿用当前技能）
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
                body: JSON.stringify({ skill_id: skillSel.value || KREA2_T2I_SKILL_ID, model: ov.model, loras: ov.loras }),
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
    (async () => {
        try {
            const models = await listGenModels();
            modelCfg.load({}, models);
        } catch {
            // 同上：静默保持「自动」
        }
    })();
    const modelToggle = $el("button", {
        className: "neo-gallery-gm-model-toggle",
        type: "button",
        textContent: "⚙️ 模型覆盖 ▸",
    });
    modelToggle.addEventListener("click", () => {
        const open = modelBox.style.display === "none";
        modelBox.style.display = open ? "" : "none";
        modelToggle.textContent = `⚙️ 模型覆盖 ${open ? "▾" : "▸"}`;
    });

    // ✨ 增强：仿 NeoPromptAgent 节点——quick input + output 双框，复用节点 agent 逻辑
    // （所选增强 skill 的 skill.md 作系统提示词 + 按需读引用文件）直调 /rs_prompts/stream_generate_prompt；
    // 输出框行为与节点共用（思考面板 / 流程状态行 / rAF 批量写回）；quick input 有内容时与
    // output 已有提示词按 \n\n---\n\n 拼接（同节点），成功后 quick input 被消费清空
    const enhanceBtn = $el("button", { className: "neo-gallery-story-btn", textContent: "✨ 增强" });
    let enhancing = false;
    enhanceBtn.addEventListener("click", async () => {
        if (enhancing || running) return;
        const quickText = quickInput.value.trim();
        const outputText = outputInput.value.trim();
        const text = quickText ? (outputText ? `${outputText}\n\n---\n\n${quickText}` : quickText) : outputText;
        if (!text) { quickInput.focus(); return; }
        enhancing = true;
        enhanceBtn.textContent = "⏳ 增强中…";
        try {
            await invokePromptStream({ text, skillId: enhanceSel.value }, createStreamOutputHandlers({
                textarea: outputInput,
                onDone: (acc) => {
                    if (acc.trim()) quickInput.value = ""; // 已消费
                    else actionToast({ severity: "warning", summary: "增强失败", detail: "LLM 未返回内容" });
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
        fill(statusBox, previewBox, $el("div", { className: "neo-gallery-story-hint", textContent: "已生成，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。" }));
        // 打开输出目录：跳到 Output 下实际落盘的日期子目录
        const openOutputDir = () => {
            const sub = images.map(i => i.subfolder).find(Boolean);
            gallery.showDirectoryStructure("Output", sub ? sub.split("/").filter(Boolean) : []);
            close();
        };
        // 删除：结果不满意 → 直接删掉落盘文件（含 .txt 与缩略图缓存），删完回 idle 原地再生成
        const deleteResult = async () => {
            if (!images.length || deleting) return;
            deleting = true;
            try {
                const ok = await gallery.deleteItem(images[0].filename, images[0].subfolder || "", { silent: true });
                if (ok) renderIdle();
                else actionToast({ severity: "error", summary: "删除失败", detail: `无法删除 ${images[0].filename}` });
            } catch (e) {
                console.error("[Gallery] gen material delete failed:", e);
                actionToast({ severity: "error", summary: "删除失败", detail: String(e?.message || e) });
            } finally {
                deleting = false;
            }
        };
        fill(actionsBox, btn("打开输出目录", openOutputDir), btn("再生成", start), btn("删除", deleteResult), btn("关闭", close, true));
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

    const start = async () => {
        if (running) return;
        // 生成用 output 内容作最终提示词（为空回退 quick input），固定 skip_enhance
        const prompt = outputInput.value.trim() || quickInput.value.trim();
        if (!prompt) { quickInput.focus(); return; }
        running = true;
        cancelRequested = false;
        renderRunning("排队中…");
        try {
            // 模型覆盖只带非空值：空串 / 空数组会覆盖掉全局设置里的显式配置（TE / VAE 不在弹窗露出，不随请求发）
            const payload = {
                skill_id: skillSel.value || KREA2_T2I_SKILL_ID,
                prompt,
                skip_enhance: true,
            };
            const ov = modelCfg.collect();
            if (ov.model) payload.model = ov.model;
            if (ov.loras.length) payload.loras = ov.loras;
            const snap = await requestGeneration(payload);
            cancelId = snap.task_id;
            renderRunning("排队中…");
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress, s.preview);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError("已取消");
            else failGen(final.error || "生成失败");
        } catch (e) {
            console.error('[Gallery] gen material failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 结果区在上（预览/成品原位替换），输入区在下（技能 / 模型覆盖 / agent 式增强双框：output 上、quick input 下），操作按钮收尾
    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: "\uD83D\uDDBC\uFE0F 生成素材" }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        statusBox,
        $el("div", { className: "neo-gallery-story-form-row" }, [
            $el("label", { className: "neo-director-field-label", textContent: "生成技能" }),
            skillSel
        ]),
        modelToggle,
        modelBox,
        outputInput,
        quickInput,
        $el("div", { className: "neo-gallery-gm-enhance-row" }, [
            $el("label", { className: "neo-director-field-label", textContent: "增强技能" }),
            enhanceSel,
            enhanceBtn
        ]),
        actionsBox
    ]));

    renderIdle();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);

    setTimeout(() => quickInput.focus(), 0);
}