/**
 * Gallery 素材卡片「一键生成」：角色图（多视图）与九宫格分镜图的请求体、弹窗 UI 与生成流程。
 * 从 gallery-card.js 拆出，固定走 Qwen Image 2.1 预设；输出分别落 Output/CharacterSheet 与 Output/StoryBoard。
 */

import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { getImageHeight, getThumbnailSrc, isImageFile, showToast } from "./gallery-utils.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask } from "./image-gen.js";
import { invokePromptStream } from "./prompt-service.js";

// 一键角色图 / 九宫格分镜图都固定走 Qwen Image 2.1 预设（多路参考槽位、不走 Krea2 编辑链）。
const QWEN_IMAGE_SKILL_ID = "qwen_image_21";
// 用所选人像作参考图生成四视图角色设定图，供拖入导演配方的 👤 角色参考图。
const CHARACTER_SHEET_PROMPT = "角色设定多视图：根据参考图中的人物，在一张横版画面中生成四个视图横向并排的角色设定图：第一格为大头特写（肩部以上，突出五官脸型），第二格为正面全身站立，第三格为侧面全身站立，第四格为背面全身站立。严格保持与参考图一致的五官脸型、发型发色、服装配饰和体型比例；全身视图中人物自然站立，双臂下垂，纯白背景，均匀柔光，写实摄影风格，高清细节，画面内不出现文字标注。";
// 角色图输出目录：保存路径的日期段会变成文件名前缀，成品直接落在 Output/CharacterSheet 下。
const CHARACTER_SHEET_DIR = "CharacterSheet";

/** 一键角色图的生图请求体（/neo_image_gen/generate）：固定 Qwen Image 2.1 + 头特写/正/侧/背提示词 + 1920×1080 请求（输出尺寸按 16 对齐）；输出走独立 CharacterSheet 目录 */
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

// 一键九宫格分镜图：原图当参考 + 九宫格指令出 3×3 故事板，供导演编辑器「🧩 宫格分镜图拆分」
// 切成视频关键帧。尺寸与导演编辑器一键九宫格一致：2048 基准 16:9（每格约 683×384）。
const STORYBOARD_DIR = "StoryBoard";
const STORYBOARD_WIDTH = 2048;
const STORYBOARD_HEIGHT = 1152;
// 小窗里的参考图预览尺寸（px，走 /neo_gallery/thumbnail 缓存，不为预览另存大图）
const STORYBOARD_PREVIEW_SIZE = 480;
// 九宫格故事生成任务（skills/tasks/storyboard_story）：简要故事 / 想法 + 参考图 → 1→9 逐格推进的故事
const STORYBOARD_STORY_SKILL_ID = "storyboard_story";

/** 故事 → 九宫格指令（语义同预设技能 nine_grid_storyboard 的模板前缀，另加 <image1> 身份锚定）。
 * qwen_image21 分词器会为每张参考图插字面量 <imageN>，所以提示词里可以直接写 <image1>。 */
export function buildStoryboardGridPrompt(story) {
    return "一张 3×3 九宫格分镜故事板（nine-panel storyboard sheet），按阅读顺序（从左到右、从上到下，第 1 格到第 9 格）讲述以下故事：\n"
        + story + "\n"
        + "参考图 <image1> 里的人物就是故事主角：所有格子保持与参考图一致的五官脸型、发型发色、服装配饰与体型比例，场景与画风统一。\n"
        + "要求：每格一个镜头，叙事逐格推进；格子之间用均匀细白缝分隔，便于后续自动切分；格子内不出现任何文字、字幕或编号。";
}

/** 一键九宫格分镜图的生图请求体（/neo_image_gen/generate）：Qwen Image 2.1 + 卡片原图作参考图 + 九宫格指令；输出走独立 StoryBoard 目录 */
export function buildStoryboardGridRequest(refName, story) {
    return {
        skill_id: QWEN_IMAGE_SKILL_ID,
        prompt: buildStoryboardGridPrompt(story),
        width: STORYBOARD_WIDTH,
        height: STORYBOARD_HEIGHT,
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
        fill(actionsBox, btn("打开输出目录", () => gallery.showDirectoryStructure("Output", [CHARACTER_SHEET_DIR])), btn("关闭", close, true));
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

/** 九宫格分镜图的前置小窗（与角色图小窗同款）：上面是九宫格故事（可手写，或由下方「简要故事 / 想法」+ 参考图
 * 用 LLM 生成），下面是可选的简要故事 / 想法；点「生成」后窗口内显示排队/生图进度与结果预览。 */
function openStoryboardDialog(gallery, image, subfolder) {
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
    // 简要故事 / 想法：LLM 的输入，可留空（留空则只按参考图编故事）；生成结果覆盖写入上面的九宫格故事框
    const ideaInput = $el("textarea", {
        className: "neo-gallery-story-idea",
        rows: 3,
        placeholder: "可选：一句话想法（如：雨夜地铁口偶遇旧友）。留空则直接按参考图编故事"
    });
    // 表单整块（故事框 + 提示 + 简要故事框）：生成中被下面的进度/结果区整块替换
    const formBox = $el("div", { className: "neo-gallery-story-form" }, [
        input,
        hint,
        $el("div", { className: "neo-gallery-story-field-label", textContent: "简要故事 / 想法（可留空，留空则按参考图生成）" }),
        ideaInput
    ]);
    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });

    let refName = null;          // copy_to_input 后的 input 文件名（生成故事与生图复用，不重复落盘）
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
    // 产物目录：优先跳到实际落盘的日期子目录，取不到时回退 StoryBoard 根目录
    const openOutputDir = (final) => {
        const dir = (final.images || []).map(i => i.subfolder).find(Boolean);
        gallery.showDirectoryStructure("Output", dir ? dir.split("/").filter(Boolean) : [STORYBOARD_DIR]);
    };

    // 表单态：故事框 + 简要故事框可编辑，右下有 LLM / 取消 / 生成
    const renderForm = () => {
        hint.classList.remove("neo-gallery-story-hint-error");
        hint.textContent = "九宫格按 1→9 逐格推进，人物沿用这张图；可手写，或用下面的简要故事 / 想法让 LLM 生成。";
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

    // 生图：卡片原图落 input/ 当参考图，按故事出 3×3 故事板；进度/结果都留在窗口内
    const start = async () => {
        if (running) return;
        running = true;
        cancelRequested = false;
        renderRunning("排队中…");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            const snap = await requestGeneration(buildStoryboardGridRequest(refName, input.value.trim()));
            cancelId = snap.task_id;
            renderRunning("排队中…");
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? "生图中…" : "排队中…", s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError("已取消");
            else renderError(final.error || "生成失败");
        } catch (e) {
            console.error('[Gallery] storyboard generation failed:', e);
            renderError(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onSubmit = () => {
        if (running) return;
        if (!input.value.trim()) {
            hint.textContent = "请先填写九宫格故事，或点「✨ LLM 生成九宫格故事」";
            hint.classList.add("neo-gallery-story-hint-error");
            input.focus();
            return;
        }
        start();
    };
    // 九宫格故事生成：卡片原图经 copy_to_input 落到 input/，连同一句简要故事 / 想法（可空）交给
    // storyboard_story 任务流式产出 1→9 逐格推进的故事，覆盖写入上面的故事框，供编辑后再生成。
    // refName 缓存避免重复落盘。
    const generateStoryFromIdea = async () => {
        if (llmRunning) return;
        llmRunning = true;
        llmBtn.disabled = true;
        llmBtn.textContent = "⏳ 生成中…";
        hint.classList.remove("neo-gallery-story-hint-error");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            let buf = "";
            await invokePromptStream(
                { text: ideaInput.value.trim(), skillId: STORYBOARD_STORY_SKILL_ID, images: [{ kind: "input", value: refName }] },
                {
                    onChunk: (chunk) => {
                        if (!chunk || chunk.kind === "thinking") return;
                        buf += chunk.text || "";
                        input.value = buf;
                    },
                    onDone: () => {
                        input.value = buf;
                        hint.textContent = "已生成九宫格故事，可继续编辑后再点「生成」。";
                    },
                    onError: (err) => {
                        console.error('[Gallery] storyboard story generation failed:', err);
                        showToast(gallery.app, 'error', 'LLM 生成九宫格故事失败', String(err));
                    }
                }
            );
        } catch (e) {
            console.error('[Gallery] storyboard story generation failed:', e);
            showToast(gallery.app, 'error', 'LLM 生成九宫格故事失败', String(e?.message || e));
        } finally {
            llmRunning = false;
            llmBtn.disabled = false;
            llmBtn.textContent = "✨ LLM 生成九宫格故事";
        }
    };
    llmBtn = $el("button", { className: "neo-gallery-story-btn", textContent: "✨ LLM 生成九宫格故事", onclick: generateStoryFromIdea });
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

/** 素材卡片「⋯」菜单里的四个生成入口（角色图 / 九宫格分镜图 / 两个直达目录），由 gallery-card.js 展开使用。 */
export function buildGenerationMenuItems({ card, gallery, image, subfolder }) {
    return [
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: "用 Qwen Image 2.1 基于这张人像生成头特写+正/侧/背四视图角色设定图；窗口内可看进度与结果预览，完成后拖入配方的 👤 角色参考图",
            onclick: () => { card._removeCollectMenu(); openCharacterSheetDialog(gallery, image, subfolder); }
        }, ["\uD83E\uDDAC 生成角色图（多视图）"]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: "以这张图为参考、按你填的故事生成 3×3 九宫格分镜图（每格一镜，可直接进导演编辑器「🧩 宫格分镜图拆分」切成视频关键帧）",
            onclick: () => { card._removeCollectMenu(); openStoryboardDialog(gallery, image, subfolder); }
        }, ["\uD83E\uDDE9 生成九宫格分镜图"]) : null,
        $el("div", {
            className: "neo-gallery-collect-item",
            title: "在画廊中打开角色图输出目录（Output/CharacterSheet），最新结果排在最前",
            onclick: () => { card._removeCollectMenu(); gallery.showDirectoryStructure("Output", [CHARACTER_SHEET_DIR]); }
        }, ["\uD83D\uDCC2 直达角色输出目录"]),
        $el("div", {
            className: "neo-gallery-collect-item",
            title: "在画廊中打开分镜图输出目录（Output/StoryBoard），最新结果排在最前",
            onclick: () => { card._removeCollectMenu(); gallery.showDirectoryStructure("Output", [STORYBOARD_DIR]); }
        }, ["\uD83D\uDCC2 直达分镜目录"]),
    ];
}
