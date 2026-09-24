/**
 * Gallery Card - content and interactions of a single directory/media card
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { app } from "../../../../scripts/app.js";
import { getReservedSpace, getImageHeight, getCardHeight, getCoverHeight, isImageFile, isVideoFile, isAudioFile, getThumbnailSrc, getAudioSrc, showToast, showInlineFeedback } from './gallery-utils.js';
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask } from "./image-gen.js";

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

// 已解码波形峰值的会话缓存：同一文件在页面内只请求/解码一次，跨卡片复用。
// 持久化到后端本地目录由 /neo_gallery/waveform 负责（见 gallery.py）。
const _waveformSessionCache = new Map(); // "subfolder::filename" -> { peaks, duration }
function _waveformKey(filename, subfolder) {
    return `${subfolder || ""}::${filename}`;
}

// Civitai fetch badge for pending lora directory cards. Network failures and rejected
// keys need different wording: Civitai is unreachable without a proxy on many networks,
// and that is not a key problem.
export function civitaiBadge(civitai) {
    if (civitai && civitai.needs_api_key) {
        return { text: "需要配置 C 站 API KEY", cls: "status-pending", title: "" };
    }
    if (civitai && (civitai.status === 'failed' || civitai.status === 'not_found')) {
        const err = civitai.error || "";
        const offline = err.includes("无法连接") || err.includes("Civitai HTTP 0");
        const text = civitai.status === 'not_found'
            ? "Not on Civitai"
            : (offline ? "C 站无法连接" : (err.includes("KEY") ? "API KEY 被拒绝" : "Fetch failed"));
        const hint = offline ? "（可在设置中点「测试 C 站连通性」排查）" : "";
        return { text, cls: "status-failed", title: err + hint };
    }
    return { text: "Fetching from Civitai...", cls: "status-loading", title: "" };
}
export class GalleryCard {
    constructor(gallery) {
        this.gallery = gallery;
    }


    // ====== Send Menus ======

    _removeSendMenu() {
        const existing = document.getElementById('neo-gallery-send-menu');
        if (existing) existing.remove();
    }

    _removeImgSendMenu() {
        const existing = document.getElementById('neo-gallery-img-send-menu');
        if (existing) existing.remove();
    }

    async _showVideoSendMenu(gallery, image, button) {
        this._removeVideoSendMenu();
        if (!isVideoFile(image.filename)) {
            showToast(gallery.app, 'warning', 'Not a Video', 'This file is not a video.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                const isLoadVideo = /load.?video/i.test(node.comfyClass || '') || /load.?video/i.test(node.title || '');
                const isVideoWidget = /video/.test(wn);
                if (isLoadVideo && widget.type === 'combo' && /video/.test(wn)) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadVideo, isText: false });
                } else if ((isLoadVideo || isVideoWidget) && widget.inputEl) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: widget.type === 'customtext' || widget.type === 'text' });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const isLoadVideo = /load.?video/i.test(sn.comfyClass || '') || /load.?video/i.test(sn.title || '');
            const hasVideoWidget = sn.widgets && sn.widgets.some(w => /video/.test((w.name || '').toLowerCase()));
            if (isLoadVideo && hasVideoWidget) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoadVideo-type nodes found.');
            return;
        }

        menuItems.forEach(item => {
            item.isSelected = item.nodeId === selectedNodeId;
        });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isLoadImage !== b.isLoadImage) return a.isLoadImage ? -1 : 1;
            return 0;
        });

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendVideoToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-video-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeVideoSendMenu(); gallery.sendVideoToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeVideoSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    _removeVideoSendMenu() {
        const existing = document.getElementById('neo-gallery-video-send-menu');
        if (existing) existing.remove();
    }

    async _showImgSendMenu(gallery, image, button) {
        this._removeImgSendMenu();
        if (!/\.(png|jpg|jpeg|gif|webp|bmp|tiff|mp4|webm|mov|avi)$/i.test(image.filename)) {
            showToast(gallery.app, 'warning', 'Not an Image', 'This file is not an image.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                const isLoadImage = /load.?image/i.test(node.comfyClass || '') || /load.?image/i.test(node.title || '');
                const isImageWidget = /image|upload/.test(wn);
                if (isLoadImage && widget.type === 'combo' && /image/.test(wn)) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: false });
                } else if ((isLoadImage || isImageWidget) && widget.inputEl) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: widget.type === 'customtext' || widget.type === 'text' });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const isLoadImage = /load.?image/i.test(sn.comfyClass || '') || /load.?image/i.test(sn.title || '');
            const hasImageWidget = sn.widgets && sn.widgets.some(w => /image|upload/.test((w.name || '').toLowerCase()));
            const hasTextWidget = sn.widgets && sn.widgets.some(w => ['string', 'text', 'customtext'].includes(w.type));
            if ((isLoadImage && hasImageWidget) || hasTextWidget) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoadImage-type nodes found.');
            return;
        }

        menuItems.forEach(item => {
            item.isSelected = item.nodeId === selectedNodeId;
        });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isLoadImage !== b.isLoadImage) return a.isLoadImage ? -1 : 1;
            return 0;
        });

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendImageToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-img-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeImgSendMenu(); gallery.sendImageToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeImgSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    _removeLoraSendMenu() {
        const existing = document.getElementById('neo-gallery-lora-send-menu');
        if (existing) existing.remove();
    }

    async _showLoraSendMenu(gallery, loraPath, button) {
        this._removeLoraSendMenu();
        if (!loraPath) {
            showToast(gallery.app, 'warning', 'No Lora', 'This item is not linked to a lora file.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            // Standard lora loaders only (LoraLoader / LoraLoaderModelOnly / variants)
            if (!/^LoraLoader/i.test(node.comfyClass || '') || !node.widgets) return;
            node.widgets.forEach((widget, index) => {
                if (widget.name === 'lora_name' && widget.type === 'combo') {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}` });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            if (/^LoraLoader/i.test(sn.comfyClass || '') && sn.widgets?.some(w => w.name === 'lora_name' && w.type === 'combo')) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoraLoader nodes found.');
            return;
        }

        menuItems.forEach(item => { item.isSelected = item.nodeId === selectedNodeId; });
        menuItems.sort((a, b) => (a.isSelected !== b.isSelected) ? (a.isSelected ? -1 : 1) : 0);

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendLoraToNode(loraPath, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }
        if (menuItems.length === 0 && selectedNodeId) {
            // Only the selected (possibly bypassed) loader matched \u2014 send straight to it
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const idx = sn.widgets.findIndex(w => w.name === 'lora_name' && w.type === 'combo');
            gallery.sendLoraToNode(loraPath, `${sn.id}:widget:${idx}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-lora-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeLoraSendMenu(); gallery.sendLoraToNode(loraPath, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
            }, [label]);
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeLoraSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    async _showSendMenu(gallery, image, button) {
        this._removeSendMenu();
        const menuItems = [];

        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                if (/negative/.test(wn)) return;
                if (widget.inputEl && /string|text|custom/.test(widget.type || '')) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isNeoPrompt: /neo.?prompt/i.test(node.title) });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            if (sn && sn.widgets && sn.widgets.some(w => !/negative/.test((w.name || '').toLowerCase()) && w.inputEl && /string|text|custom/.test(w.type || ''))) {
                selectedNodeId = sn.id;
            }
        }

        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No valid text nodes found.');
            return;
        }

        menuItems.forEach(item => { item.isSelected = item.nodeId === selectedNodeId; });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isNeoPrompt !== b.isNeoPrompt) return a.isNeoPrompt ? -1 : 1;
            return 0;
        });

        const hasSelection = selKeys.length > 0;
        if (!hasSelection && menuItems.length === 1) {
            this.sendToTarget(image.name, image.txt_content, button, menuItems[0].nodeId, menuItems[0].widgetIndex);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => {
                    e.stopPropagation();
                    this._removeSendMenu();
                    this.sendToTarget(image.name, image.txt_content, button, item.nodeId, item.widgetIndex);
                },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    // ====== Internal Helpers ======

    /**
     * Resolve target node and widget from a nodeId (used by copyToClipboard).
     */
    _resolveTargetFromNodeId(nodeId) {
        const targetNode = this.gallery.app.graph.getNodeById(parseInt(nodeId));
        if (!targetNode) return null;

        let isPromptNode = !!targetNode._rsPromptUIElements;
        let targetWidget = null;

        if (isPromptNode) {
            return { targetNode, isPromptNode: true, targetWidget: null };
        }

        // Find first valid text widget as fallback
        targetWidget = targetNode.widgets?.find(w => ['string', 'text', 'customtext'].includes(w.type));
        return { targetNode, isPromptNode: false, targetWidget };
    }

    /**
     * Send cleaned text to a resolved target (prompt node or regular widget).
     */
    _sendToResolvedTarget(textToCopy, targetNode, isPromptNode, targetWidget, feedbackBtn) {
        if (!targetNode) return;

        // Branch 1: Neo Prompt node with custom textarea
        if (isPromptNode && targetNode._rsPromptUIElements) {
            const { customTextarea, textWidget } = targetNode._rsPromptUIElements;
            if (customTextarea) {
                customTextarea.value = textToCopy;
                customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
            if (textWidget) {
                textWidget.value = textToCopy;
            }
            this.gallery.app.graph.setDirtyCanvas(true, true);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Sent!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Sent!', `Sent to ${targetNode.title || 'Node'}`);
        }
        // Branch 2: Regular widget on target node
        else if (targetWidget) {
            targetWidget.value = textToCopy;
            try {
                if (targetNode.onWidgetChanged) {
                    targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
                }
            } catch (e) {
                console.warn(`[Neo Gallery] onWidgetChanged threw: ${e.message}`);
            }
            this.gallery.app.graph.setDirtyCanvas(true, true);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Sent!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Sent!', `Sent to ${targetNode.title} - ${targetWidget.name}`);
        }
    }

    // ====== Public API ======

    /**
     * Send text to a specific node/widget by explicit nodeId and widgetIndex.
     * Falls back to clipboard copy if target resolution fails.
     */
    sendToTarget(imageName, txtContent, feedbackBtn = null, targetNodeId, targetWidgetIndex) {
        const textToCopy = this._cleanText(txtContent);

        // Resolve target node by explicit nodeId
        const resolved = this._resolveTargetFromNodeId(targetNodeId);
        if (!resolved || !resolved.targetNode) {
            console.error(`[Neo Gallery] sendToTarget: Failed to get node by id ${targetNodeId}, falling back to clipboard`);
            return this._fallbackToClipboard(textToCopy, feedbackBtn);
        }

        // For regular widgets, use the specific widget index
        let targetWidget = resolved.targetWidget;
        if (!resolved.isPromptNode && targetWidgetIndex != null) {
            targetWidget = resolved.targetNode.widgets?.[parseInt(targetWidgetIndex)];
            if (!targetWidget) {
                console.error(`[Neo Gallery] sendToTarget: targetWidget[${targetWidgetIndex}] is null/undefined, falling back to clipboard`);
                return this._fallbackToClipboard(textToCopy, feedbackBtn);
            }
        }

        this._sendToResolvedTarget(textToCopy, resolved.targetNode, resolved.isPromptNode, targetWidget, feedbackBtn);
    }

    /**
     * Fetch an image, re-encode it as PNG (clipboard only reliably accepts PNG),
     * and write it to the system clipboard. Requires a secure context.
     */
    _copyImageToClipboard(imageUrl, feedbackBtn = null) {
        const fail = (err) => {
            console.error('[Neo Gallery] Copy image failed:', err);
            const msg = String(err && err.message || err);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u274C ' + msg.slice(0, 20), 'error');
            else showToast(this.gallery.app, 'error', 'Copy Failed', msg);
        };
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
            fail(new Error('\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u526A\u8D34\u677F\u56FE\u7247'));
            return;
        }
        fetch(imageUrl).then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.blob();
        }).then(blob => new Promise((resolve, reject) => {
            const img = new Image();
            const objUrl = URL.createObjectURL(blob);
            img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('\u56FE\u7247\u52A0\u8F7D\u5931\u8D25')); };
            img.src = objUrl;
        })).then(img => new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG \u7F16\u7801\u5931\u8D25')), 'image/png');
        })).then(pngBlob => {
            // Promise form of ClipboardItem: required by some browsers to keep the write permission alive
            const item = new ClipboardItem({ 'image/png': new Promise(resolve => resolve(pngBlob)) });
            return navigator.clipboard.write([item]).then(() => {
                if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Copied!', 'success');
                else showToast(this.gallery.app, 'success', 'Image Copied!', 'Copied image to clipboard');
            });
        }).catch(fail);
    }

    /**
     * Copy text to system clipboard only.
     */
    copyToClipboard(imageName, txtContent, feedbackBtn = null) {
        const textToCopy = this._cleanText(txtContent);
        return this._fallbackToClipboard(textToCopy, feedbackBtn);
    }

    /**
     * Clean text content for copying.
     */
    _cleanText(txtContent) {
        return String(txtContent || "").trim();
    }

    /**
     * Fallback: write to system clipboard.
     */
    _fallbackToClipboard(textToCopy, feedbackBtn = null) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Copied!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Copied!', `Copied to clipboard`);
        }).catch((err) => {
            console.error('[Neo Gallery] Clipboard write failed:', err);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u274C Failed', 'error');
        });
    }

    async createDirCard(gallery, name, path, items, subdirs = {}, readOnly = false, source = "local", dirInfo = null) {
        const isRemote = source === "oss";
        // Lora dirs are addressed by their "Lora/..." path; name may be just the lora stem.
        const isLoraDir = String(path || "").toLowerCase().startsWith("lora/");
        const navTarget = isRemote ? path : (isLoraDir ? path : name);
        const card = $el("div", {
            className: "neo-gallery-category-card" + (isRemote ? " neo-gallery-card-remote" : ""),
            onclick: () => gallery.showDirectoryStructure(navTarget, [])
        });

        const isPending = !!(dirInfo && dirInfo.pending);
        const loraPath = (dirInfo && dirInfo.lora_path) || null;
        const civitai = (dirInfo && dirInfo.civitai) || null;

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading",
            style: { minHeight: `${Math.max(gallery.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${Math.max(gallery.maxThumbnailSize, 80)}px` }
        });

        // Mark card as lazy-load target with data attributes
        card.dataset.lazyCovers = name;
        card.dataset.lazyCoversPath = path;

        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: name });
        const info = $el("div", { className: "neo-gallery-card-info" }, [
            nameEl
        ]);

        if (isRemote) {
            nameEl.parentElement.appendChild($el("span", {
                className: "neo-gallery-remote-badge",
                textContent: "\u2601"
            }));
        }

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge " + (isRemote ? "type-remote" : "type-directory"),
            title: isRemote ? "Remote (OSS)" : "Directory"
        }, [isRemote ? "\u2601\uFE0F" : "\uD83D\uDCC1"]);

        if (!readOnly) {
            const deleteBtn = $el("div", {
                className: "neo-gallery-card-delete-btn",
                title: `Remove directory "${name}"`,
                onclick: (e) => {
                    e.stopPropagation();
                    gallery.removeCustomDir(path);
                }
            }, ["\u00D7"]);
            card.appendChild(deleteBtn);
        }

        // Pending lora fetch (queued/running/failed) status badge.
        if (isPending) {
            const badge = civitaiBadge(civitai);
            card.appendChild($el("div", {
                className: "neo-gallery-card-status " + badge.cls,
                textContent: badge.text,
                title: badge.title
            }));
        } else if (dirInfo && dirInfo.has_pending) {
            card.appendChild($el("div", {
                className: "neo-gallery-card-status status-pending",
                textContent: "Pending loras",
                title: "Some loras are still queued for Civitai example fetching"
            }));
        }

        // Send the lora path to a standard LoraLoader from the lora directory card.
        if (loraPath) {
            const loraBtn = $el("div", {
                className: "neo-gallery-card-lora-send-btn",
                title: "Send the lora path to a standard LoraLoader",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraSendMenu(gallery, loraPath, loraBtn);
                }
            }, ["\uD83D\uDCE4"]);
            card.appendChild(loraBtn);
        }

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Store cover wrapper reference for lazy loading
        card._coverWrapper = coverWrapper;

        // Try to load cover images from cache immediately
        this._applyCoverImages(card, coverWrapper, gallery, name, name);

        return card;
    }

    /**
     * Apply cover images to a directory card from the global cache.
     */
    _applyCoverImages(card, coverWrapper, gallery, dirName, displayLabel) {
        // Use cached cover images from batch fetch
        // Case-insensitive lookup: backend uses lowercase keys (e.g. "presets")
        // but frontend passes the directory name as displayed (e.g. "Presets")
        // Also try the card's full path (e.g. "Cloud Presets/26-06-25") for OSS subdirs
        const coverPath = card.dataset && card.dataset.lazyCoversPath;
        const covers = (gallery._dirCovers && gallery._dirCovers[dirName]) ||
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === dirName.toLowerCase())?.[1]) ||
                       (gallery._dirCovers && coverPath && gallery._dirCovers[coverPath]) ||
                       (gallery._dirCovers && coverPath && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === coverPath.toLowerCase())?.[1]) ||
                       [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, dirName, displayLabel, gallery);
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - keep skeleton loading for lazy loading
            // Don't remove skeleton-loading here, let IntersectionObserver handle it
            // Only show placeholder if skeleton is not active
            if (!coverWrapper.classList.contains('skeleton-loading')) {
                coverWrapper.innerHTML = '';
                coverWrapper.appendChild($el("div", {
                    className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                    textContent: "\uD83D\uDCCB"
                }));
            }
        }
    }

    /**
     * Render a cover grid from an array of image entries.
     */
    _renderCoverGrid(coverWrapper, images, dirName, displayLabel, gallery) {
        const displayImages = images.slice(0, 2);
        if (displayImages.length === 0) return;

        coverWrapper.innerHTML = '';
        const coverGrid = $el("div", { className: "neo-gallery-card-cover-grid" });

        let loadedCount = 0;

        displayImages.forEach((imgData) => {
            const imgSubfolder = imgData.subfolder || "";
            const imgItem = $el("div", { className: "neo-gallery-card-cover-grid-item" });

            const img = $el("img", {
                src: getThumbnailSrc(imgData, imgSubfolder),
                alt: displayLabel,
                loading: "lazy"
            });

            img.onload = () => {
                if (loadedCount === displayImages.length) {
                    const height = getCoverHeight(coverWrapper, gallery);
                    coverGrid.style.height = `${height * 2}px`;
                }
            };

            img.onerror = () => {
                imgItem.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:24px;">\uD83D\uDCCB</div>';
            };

            imgItem.appendChild(img);
            coverGrid.appendChild(imgItem);
        });

        coverWrapper.appendChild(coverGrid);
    }

    async createSubdirCard(gallery, subdirName, parentDir, fullPath, subdirData = null) {
        const cardHeight = getCardHeight(gallery);

        const card = $el("div", {
            className: "neo-gallery-category-card",
            onclick: () => gallery.showDirectoryStructure(parentDir, fullPath),
            style: { width: `${gallery.maxThumbnailSize}px`, minHeight: `${cardHeight}px` }
        });

        const isPending = !!(subdirData && subdirData.pending);
        const civitai = (subdirData && subdirData.civitai) || null;
        const loraPath = (subdirData && subdirData.lora_path) || null;

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: "Directory"
        }, ["\uD83D\uDCC1"]);

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading",
            style: { minHeight: `${Math.max(gallery.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${gallery.maxThumbnailSize}px` }
        });

        const info = $el("div", { className: "neo-gallery-card-info" }, [
            $el("span", { className: "neo-gallery-card-name", textContent: subdirName })
        ]);

        if (isPending) {
            const badge = civitaiBadge(civitai);
            card.appendChild($el("div", {
                className: "neo-gallery-card-status " + badge.cls,
                textContent: badge.text,
                title: badge.title
            }));
        }

        // Send the lora path to a standard LoraLoader from the directory card itself.
        if (loraPath) {
            const loraBtn = $el("div", {
                className: "neo-gallery-card-lora-send-btn",
                title: "Send the lora path to a standard LoraLoader",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraSendMenu(gallery, loraPath, loraBtn);
                }
            }, ["\uD83D\uDCE4"]);
            card.appendChild(loraBtn);
        }

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Try to apply cover images from cache first, then fallback to lazy fetch
        const subdirKey = `${parentDir}/${fullPath.join("/")}`;
        this._applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName);

        return card;
    }

    /**
     * Apply cover images to a subdirectory card from the global cache.
     */
    _applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName) {
        // Case-insensitive lookup for consistency
        const covers = (gallery._dirCovers && gallery._dirCovers[subdirKey]) || 
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === subdirKey.toLowerCase())?.[1]) || [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, subdirKey, subdirName, gallery);
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - show placeholder
            coverWrapper.innerHTML = '';
            coverWrapper.appendChild($el("div", {
                className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                textContent: "\uD83D\uDCCB"
            }));
            // Remove skeleton loading state even for placeholder
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        }
    }

    /**
     * Update subdir card cover with sample images.
     */
    _updateSubdirCardCover(card, coverWrapper, structure, subdirName, gallery) {
        let coverImages = [];

        // First priority: use sample_images from backend (recursively collected)
        if (structure.sample_images && structure.sample_images.length > 0) {
            coverImages = structure.sample_images.slice(0, 2);
        } else if (structure.images && structure.images.length > 0) {
            // Fallback: use direct images at this level
            coverImages = structure.images.slice(0, 2);
        }

        if (coverImages.length > 0) {
            coverWrapper.innerHTML = '';

            const coverGrid = $el("div", { className: "neo-gallery-card-cover-grid" });

            let loadedCount = 0;
            const displayImages = coverImages.slice(0, 2);

            displayImages.forEach((imgData) => {
                // Use the subfolder from the image data itself (set by backend)
                const imgSubfolder = imgData.subfolder || "";

                const imgItem = $el("div", { className: "neo-gallery-card-cover-grid-item" });

                const img = $el("img", {
                    src: getThumbnailSrc(imgData, imgSubfolder),
                    alt: subdirName,
                    loading: "lazy"
                });

                img.onload = () => {
                    loadedCount++;
                    if (loadedCount === displayImages.length) {
                        const height = getCoverHeight(coverWrapper, gallery);
                        coverGrid.style.height = `${height * 2}px`;
                    }
                };

                img.onerror = () => {
                    imgItem.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:24px;">\uD83D\uDCCB</div>';
                };

                imgItem.appendChild(img);
                coverGrid.appendChild(imgItem);
            });

            coverWrapper.appendChild(coverGrid);
        } else {
            // No images found at any level, show folder icon
            coverWrapper.innerHTML = '';
            coverWrapper.appendChild($el("div", {
                className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                textContent: "\uD83D\uDCCB"
            }));
        }
    }

    // ====== 收藏菜单（缩略图卡右下角「⋯」信息扩展按钮） ======

    _removeCollectMenu() {
        const existing = document.querySelector('.neo-gallery-collect-menu');
        if (existing) existing.remove();
    }

    /** 根据素材来源拆分 gallery 目录名与子路径，用于本地收藏路径记录。 */
    _bookmarkLocator(image, subfolder, source, gallery) {
        const full = String(subfolder || "");
        if (String(source || "").toLowerCase() === "oss") {
            return { source: "oss", dir: full, subfolder: "" };
        }
        // 顶层目录名必须是列表接口可解析的卡片名（自定义目录名 / Input / Output）。
        // item.subfolder 只是卡片内相对路径（如 "美女"），单独无法定位，
        // 因此用当前视图的 source + categoryPath 还原「可打开、可取封面」的路径。
        const view = gallery && gallery.currentView;
        if (view && view.source) {
            const dir = view.source;
            const sub = Array.isArray(view.categoryPath) ? view.categoryPath.join("/") : "";
            return { source: "local", dir, subfolder: sub };
        }
        const segs = full.split("/").filter(Boolean);
        const dir = segs[0] || "Input";
        return { source: "local", dir, subfolder: segs.slice(1).join("/") };
    }

    async _collectMedia(gallery, payload, label) {
        try {
            const resp = await api.fetchApi('/neo_bookmark/local/add', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            if (data.success) {
                showToast(gallery.app, 'success', '已加入收藏', label);
            } else if (resp.status === 409) {
                showToast(gallery.app, 'info', '已在收藏中', label);
            } else {
                showToast(gallery.app, 'error', '收藏失败', data.error || '');
            }
        } catch (e) {
            showToast(gallery.app, 'error', '收藏失败', String(e));
        }
    }

    /** 只读素材源判定：presets/lora/C站收藏目录与远程 oss（⋯ 菜单删除项与左上角勾选框共用）。 */
    _isReadOnlySource(subfolder, source) {
        const subLower = String(subfolder || "").toLowerCase();
        return subLower === 'presets' || subLower.startsWith('presets/') ||
            subLower === 'lora' || subLower.startsWith('lora/') ||
            subLower === 'civitai_bookmarks' || subLower.startsWith('civitai_bookmarks/') ||
            source === "oss";
    }

    _showCollectMenu(gallery, image, subfolder, source, anchor) {
        this._removeCollectMenu();
        const loc = this._bookmarkLocator(image, subfolder, source, gallery);
        const displayName = (image.name || image.filename || '').replace(/\.\w+$/, '') || "素材";
        const isOss = loc.source === "oss";
        const fileSub = loc.subfolder ? `/${loc.subfolder}` : "";
        const pathLabel = `${loc.dir}${fileSub}${image.filename ? '/' + image.filename : ''}`;

        const collectFile = () => this._collectMedia(gallery, {
            source: loc.source, name: displayName,
            dir: loc.dir, subfolder: loc.subfolder, filename: image.filename || image.name || ""
        }, displayName);

        // 系统输入/输出文件可删除；presets、lora 与远程 oss 来源只读。
        const canDelete = !this._isReadOnlySource(subfolder, source);
        // 有勾选时菜单「删除」升级为批量删除已选素材
        const selectedCount = (gallery._selectedItems && gallery._selectedItems.size) || 0;

        // 导入工作流：仅当素材内嵌了 ComfyUI 工作流时显示（异步探测后放开）。
        const wfItem = $el("div", {
            className: "neo-gallery-collect-item",
            style: { display: "none" },
            title: "将此素材内嵌的 ComfyUI 工作流载入画布",
            onclick: async () => {
                this._removeCollectMenu();
                try {
                    await this._importWorkflowFromMedia(gallery, image, subfolder);
                } catch (err) {
                    showToast(gallery.app, "error", "导入失败", String(err.message || err));
                }
            }
        }, ["\u2937 导入工作流"]);
        this._fetchMediaMeta(image, subfolder).then(meta => {
            if (meta && meta.has && (meta.workflow || meta.prompt)) wfItem.style.display = "";
        }).catch(() => {});

        const menu = $el("div", { className: "neo-gallery-collect-menu" }, [
            $el("div", { className: "neo-gallery-collect-title" }, [
                $el("span", { className: "neo-gallery-collect-name", textContent: displayName }),
                isOss ? $el("span", { className: "neo-gallery-card-source-badge", textContent: "OSS 预设" }) : null
            ].filter(Boolean)),
            $el("div", {
                className: "neo-gallery-collect-path",
                title: pathLabel,
                textContent: pathLabel
            }),
            $el("div", {
                className: "neo-gallery-collect-item",
                onclick: () => { collectFile(); this._removeCollectMenu(); }
            }, ["\u2B50 收藏本图"]),
            isImageFile(image.filename) ? $el("div", {
                className: "neo-gallery-collect-item",
                title: "用 Qwen Image 2.1 基于这张人像生成头特写+正/侧/背四视图角色设定图；完成后在 Gallery 输出目录拖入配方的 👤 角色参考图",
                onclick: () => { this._removeCollectMenu(); this._generateCharacterSheet(image, subfolder); }
            }, ["\uD83E\uDDAC 生成角色图（多视图）"]) : null,
            isImageFile(image.filename) ? $el("div", {
                className: "neo-gallery-collect-item",
                title: "以这张图为参考、按你填的故事生成 3×3 九宫格分镜图（每格一镜，可直接进导演编辑器「🧩 宫格分镜图拆分」切成视频关键帧）",
                onclick: () => { this._removeCollectMenu(); this._openStoryboardDialog(image, subfolder); }
            }, ["\uD83E\uDDE9 生成九宫格分镜图"]) : null,
            $el("div", {
                className: "neo-gallery-collect-item",
                title: "在画廊中打开角色图输出目录（Output/CharacterSheet），最新结果排在最前",
                onclick: () => { this._removeCollectMenu(); gallery.showDirectoryStructure("Output", [CHARACTER_SHEET_DIR]); }
            }, ["\uD83D\uDCC2 直达角色输出目录"]),
            $el("div", {
                className: "neo-gallery-collect-item",
                title: "在画廊中打开分镜图输出目录（Output/StoryBoard），最新结果排在最前",
                onclick: () => { this._removeCollectMenu(); gallery.showDirectoryStructure("Output", [STORYBOARD_DIR]); }
            }, ["\uD83D\uDCC2 直达分镜目录"]),
            ...(image.lora_path ? [
                $el("div", {
                    className: "neo-gallery-collect-item",
                    title: "发送到画布上的 LoraLoader",
                    onclick: () => { this._removeCollectMenu(); this._showLoraSendMenu(gallery, image.lora_path, anchor); }
                }, ["\uD83D\uDCE4 发送 Lora"]),
                $el("div", {
                    className: "neo-gallery-collect-path neo-gallery-collect-lora-path",
                    title: image.lora_path,
                    textContent: image.lora_path
                })
            ] : []),
            image.txt_content ? $el("div", {
                className: "neo-gallery-collect-prompt-preview",
                title: "提示词（可全选复制）"
            }, [
                $el("span", { className: "neo-gallery-collect-prompt-text", textContent: gallery.cleanText(image.txt_content) })
            ]) : null,
            image.txt_content ? $el("div", {
                className: "neo-gallery-collect-item",
                onclick: () => { this.copyToClipboard(image.name, image.txt_content); this._removeCollectMenu(); }
            }, ["\u29C9 复制提示词"]) : null,
            wfItem,
            canDelete ? $el("div", {
                className: "neo-gallery-collect-item neo-gallery-collect-item-danger",
                title: selectedCount > 0 ? `删除已勾选的 ${selectedCount} 个素材，不影响未选中文件` : "仅删除当前素材",
                onclick: () => { this._removeCollectMenu(); selectedCount > 0 ? gallery.deleteSelected() : gallery.deleteItem(image.name, subfolder); }
            }, [selectedCount > 0 ? `\uD83D\uDDD1\uFE0F 删除已选素材（${selectedCount}）` : "\uD83D\uDDD1\uFE0F 删除"]) : null
        ].filter(Boolean));

        document.body.appendChild(menu);
        const rect = (anchor && anchor.getBoundingClientRect()) || { right: 0, bottom: 0 };
        const mRect = menu.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(rect.right - mRect.width, window.innerWidth - mRect.width - 8)) + 'px';
        menu.style.top = (rect.bottom + 4) + 'px';
        if (rect.bottom + mRect.height > window.innerHeight) {
            menu.style.top = Math.max(8, rect.top - mRect.height - 4) + 'px';
        }

        const closeOnOutside = (e) => {
            if (!menu.contains(e.target)) this._removeCollectMenu();
        };
        const closeOnEsc = (e) => { if (e.key === 'Escape') this._removeCollectMenu(); };
        setTimeout(() => {
            document.addEventListener('mousedown', closeOnOutside);
            document.addEventListener('keydown', closeOnEsc);
        }, 0);
        menu._cleanup = () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEsc);
        };
        const origRemove = menu.remove.bind(menu);
        menu.remove = () => { if (menu._cleanup) menu._cleanup(); origRemove(); };
    }

    /** 卡片图片经 copy_to_input 落到 input 目录（与发送到 LoadImage 同一通道），返回 input 内的文件名 */
    async _copyImageToInput(image, subfolder) {
        const query = "filename=" + encodeURIComponent(image.filename || "")
            + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : "");
        const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
        const result = await resp.json().catch(() => null);
        if (!resp.ok || !result || !result.success) {
            throw new Error((result && result.error) || '无法读取该图片');
        }
        return result.filename;
    }

    /** 一键角色图：卡片图片先经 copy_to_input 落到 input 目录（与发送到 LoadImage 同一通道），
     * 再作为参考图提交 Qwen Image 2.1 多视图生成；完成后提示把结果拖入配方 👤 角色参考图。 */
    async _generateCharacterSheet(image, subfolder) {
        const gallery = this.gallery;
        let refName;
        try {
            refName = await this._copyImageToInput(image, subfolder);
        } catch (e) {
            console.error('[Gallery] character sheet copy_to_input failed:', e);
            showToast(gallery.app, 'error', '生成角色图失败', String(e?.message || e));
            return;
        }
        try {
            const snap = await requestGeneration(buildCharacterSheetRequest(refName));
            showToast(gallery.app, 'info', '角色图生成中', '排队/生图中…结果保存在 Gallery 输出目录');
            const final = await watchTask(snap.task_id);
            if (final.status === "succeeded") {
                showToast(gallery.app, 'success', '角色图已生成', '在 Neo Gallery 输出目录找到后，拖入配方的 👤 角色参考图');
            } else if (final.status !== "cancelled") {
                showToast(gallery.app, 'error', '角色图生成失败', final.error || '未知错误');
            }
        } catch (e) {
            console.error('[Gallery] character sheet generation failed:', e);
            showToast(gallery.app, 'error', '生成角色图失败', String(e?.message || e));
        }
    }

    /** 九宫格分镜图的前置小窗：填故事 / 想法（Ctrl+Enter 生成，Esc 或点遮罩关闭） */
    _openStoryboardDialog(image, subfolder) {
        document.querySelector('.neo-gallery-story-modal-overlay')?.remove();
        const gallery = this.gallery;
        // 预览按卡片图片的高度显示：小窗里的参考图和卡片里看到的一样大，方便确认用的就是这张
        const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
        const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");
        const hint = $el("div", {
            className: "neo-gallery-story-hint",
            textContent: "写下这个故事：九宫格按 1→9 逐格推进，人物沿用这张图。"
        });
        const input = $el("textarea", {
            className: "neo-gallery-story-input",
            rows: 6,
            placeholder: "例：雨夜的地铁口，她收起伞抬头，看见多年未见的他站在灯下……"
        });
        const overlay = $el("div", { className: "neo-gallery-story-modal-overlay" });
        const close = () => overlay.remove();
        const submit = () => {
            const story = input.value.trim();
            if (!story) {
                hint.textContent = "请先填写故事 / 想法";
                hint.classList.add("neo-gallery-story-hint-error");
                input.focus();
                return;
            }
            close();
            this._generateStoryboard(image, subfolder, story);
        };
        const onKey = (e) => {
            if (e.key === "Escape") close();
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
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
            input,
            hint,
            $el("div", { className: "neo-gallery-story-actions" }, [
                $el("button", { className: "neo-gallery-story-btn", textContent: "取消", onclick: close }),
                $el("button", { className: "neo-gallery-story-btn neo-gallery-story-btn-primary", textContent: "生成", onclick: submit })
            ])
        ]));
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
        document.addEventListener("keydown", onKey);
        const origRemove = overlay.remove.bind(overlay);
        overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
        document.body.appendChild(overlay);
        setTimeout(() => input.focus(), 0);
    }

    /** 一键九宫格分镜图：卡片图片先落 input/ 当参考图，再按故事出 3×3 故事板；
     * 成功后直接跳到产物所在目录（供拖入导演编辑器「🧩 宫格分镜图拆分」切成关键帧）。 */
    async _generateStoryboard(image, subfolder, story) {
        const gallery = this.gallery;
        let refName;
        try {
            refName = await this._copyImageToInput(image, subfolder);
        } catch (e) {
            console.error('[Gallery] storyboard copy_to_input failed:', e);
            showToast(gallery.app, 'error', '生成分镜图失败', String(e?.message || e));
            return;
        }
        try {
            const snap = await requestGeneration(buildStoryboardGridRequest(refName, story));
            showToast(gallery.app, 'info', '九宫格分镜图生成中', '排队/生图中…结果保存在 Output/StoryBoard');
            const final = await watchTask(snap.task_id);
            if (final.status === "succeeded") {
                showToast(gallery.app, 'success', '九宫格分镜图已生成', '可拖入导演编辑器「🧩 宫格分镜图拆分」切成关键帧');
                const dir = (final.images || []).map(i => i.subfolder).find(Boolean);
                if (dir) gallery.showDirectoryStructure("Output", dir.split("/").filter(Boolean));
            } else if (final.status !== "cancelled") {
                showToast(gallery.app, 'error', '九宫格分镜图生成失败', final.error || '未知错误');
            }
        } catch (e) {
            console.error('[Gallery] storyboard generation failed:', e);
            showToast(gallery.app, 'error', '生成分镜图失败', String(e?.message || e));
        }
    }

    // ====== Image Element ======

    createImageElement(gallery, image, subfolder, source = "") {
        const isImageFileResult = isImageFile(image.filename);
        const isVideoFileResult = isVideoFile(image.filename);
        const isAudioFileResult = isAudioFile(image.filename);
        const isDraggableMedia = (isImageFileResult || isVideoFileResult || isAudioFileResult) && !image.lora_path;
        const reservedSpace = getReservedSpace(gallery.displayLabels);
        const imageHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);

        const container = $el("div", {
            className: isAudioFileResult
                ? "neo-gallery-thumb-container neo-gallery-thumb-container-audio"
                : "neo-gallery-thumb-container",
            style: {
                height: `${gallery.maxThumbnailSize}px`,
                width: `${gallery.maxThumbnailSize}px`
            },
            // 音频卡片不需要灯箱：点击容器不打开大图（播放由卡片自身处理）
            onclick: () => {
                if (isAudioFileResult) return;
                this.showLightbox(gallery, image, subfolder);
            },
            draggable: isDraggableMedia,
            ondragstart: (e) => {
                if (!isDraggableMedia) { e.preventDefault(); return; }
                e.dataTransfer.setData("application/x-neo-gallery", JSON.stringify({ filename: image.filename, subfolder }));
                e.dataTransfer.setData("text/plain", image.filename);
                e.dataTransfer.effectAllowed = "copy";
            },
            dataset: { filename: image.filename, subfolder: subfolder }
        });

        let imgSendBtn = null;
        if (!isVideoFileResult && !isAudioFileResult) {
            imgSendBtn = $el("div", {
                className: "neo-gallery-thumb-img-send-btn",
                title: image.lora_path ? "发送 Lora 到画布上的 LoraLoader" : "发送图片到画布上的 Load Image 节点",
                onclick: (e) => {
                    e.stopPropagation();
                    if (image.lora_path) {
                        this._showLoraSendMenu(gallery, image.lora_path, imgSendBtn);
                    } else {
                        this._showImgSendMenu(gallery, image, imgSendBtn);
                    }
                }
            }, ["\uD83D\uDCE4"]);
        }

        let sendBtn = null;
        if (image.txt_content) {
            sendBtn = $el("div", {
                className: "neo-gallery-thumb-send-btn",
                title: "发送提示词到画布节点",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showSendMenu(gallery, image, sendBtn);
                }
            }, ["\u2708\uFE0F"]);
        }

        let videoSendBtn = null;
        if (isVideoFileResult) {
            videoSendBtn = $el("div", {
                className: "neo-gallery-thumb-video-send-btn",
                title: "发送视频到画布节点",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showVideoSendMenu(gallery, image, videoSendBtn);
                }
            }, ["\uD83D\uDCE5"]);
        }

        let audioSendBtn = null;
        if (isAudioFileResult) {
            audioSendBtn = $el("div", {
                className: "neo-gallery-thumb-audio-send-btn",
                title: "发送音频到画布上的 LoadAudio 节点",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showAudioSendMenu(gallery, image, audioSendBtn);
                }
            }, ["\uD83C\uDFB5"]);
        }

        // 右下角信息扩展按钮：点击弹出扩展菜单（收藏 / Lora 发送 / 提示词预览 / 导入工作流 / 删除）。
        const bookmarkBtn = $el("div", {
            className: "neo-gallery-thumb-bookmark-btn",
            title: "更多操作",
            onclick: (e) => {
                e.stopPropagation();
                this._showCollectMenu(gallery, image, subfolder, source, bookmarkBtn);
            }
        }, ["\u22EF"]);

        // 左上角勾选框：多选后由底部操作条批量删除（仅可删除来源显示，与 ⋯ 菜单 canDelete 一致）
        const selectCheck = (!this._isReadOnlySource(subfolder, source) && !isAudioFileResult) ? $el("input", {
            className: "neo-gallery-select-check",
            type: "checkbox",
            title: "选中（可多选，Ctrl+A 全选）",
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => {
                e.stopPropagation();
                const checked = e.target.checked;
                gallery.toggleSelection(image.name, subfolder);
                container.classList.toggle('neo-gallery-thumb-selected', checked);
            }
        }) : null;

        let mediaEl;
        const thumbnailSrc = isVideoFileResult || isImageFileResult ? getThumbnailSrc(image, subfolder) : null;
        
        if (isAudioFileResult) {
            mediaEl = this._buildAudioCard(gallery, image, subfolder);
            // 音频用长条形卡片：容器高度收窄以贴合波形条，避免方形留白
            container.style.height = "auto";
        } else if (thumbnailSrc) {
            // Lazy loading: defer actual src until image scrolls into view
            mediaEl = $el("img", {
                className: "neo-gallery-thumb-img",
                src: gallery.placeholderImageUrl,
                alt: image.name,
                dataset: { thumbnailSrc },
                onerror: () => {
                    if (mediaEl) mediaEl.src = gallery.placeholderImageUrl;
                }
            });
            mediaEl.draggable = false;   // 由容器接管拖拽（携带 Neo Gallery 数据），而非浏览器原生图片拖拽
            
            // Pre-load for aspect ratio calculation AND set real src
            const preloaderImg = new Image();
            preloaderImg.onload = () => {
                const aspectRatio = preloaderImg.height / preloaderImg.width;
                container.style.width = `${Math.max(gallery.maxThumbnailSize * (1 / aspectRatio), 40)}px`;
                // Set the real thumbnail src now that we have dimensions
                mediaEl.src = thumbnailSrc;
            };
            preloaderImg.src = thumbnailSrc;
        } else {
            // Unknown type - show placeholder
            mediaEl = $el("div", {
                className: "neo-gallery-thumb-img neo-gallery-thumb-placeholder",
                textContent: "\uD83D\uDCCB"
            });
        }

        // 视频卡片左上角播放图标，一眼区分视频与图片。
        const videoBadge = isVideoFileResult ? $el("div", {
            className: "neo-gallery-thumb-video-badge"
        }, ["\u25B6"]) : null;

        const btnBar = $el("div", { className: "neo-gallery-thumb-btn-bar" }, [videoSendBtn, audioSendBtn, sendBtn, imgSendBtn, bookmarkBtn].filter(Boolean));

        const imgWrapper = $el("div", { className: "neo-gallery-thumb-img-wrapper" }, [videoBadge, mediaEl, btnBar, selectCheck].filter(Boolean));

        const labelEl = gallery.displayLabels ? $el("span", {
            className: "neo-gallery-image-label",
            textContent: image.name.replace(/\.\w+$/, '')
        }) : null;

        container.appendChild(imgWrapper);
        if (labelEl) container.appendChild(labelEl);

        const loc = this._bookmarkLocator(image, subfolder, source, gallery);
        const fullPath = [loc.dir, loc.subfolder, image.filename || image.name].filter(Boolean).join("/");
        container.title = `${fullPath}\n点击打开大图，右下角 ⋯ 更多操作`;

        return container;
    }

    // ====== 音频卡片：波形 + 播放预览 ======

    _buildAudioCard(gallery, image, subfolder) {
        const card = $el("div", { className: "neo-gallery-thumb-img neo-gallery-audio-card" });

        const playBtn = $el("div", {
            className: "neo-gallery-audio-play-btn",
            title: "播放 / 暂停预览"
        }, ["\u25B6"]);
        card.appendChild(playBtn);

        const canvas = $el("canvas", { className: "neo-gallery-audio-waveform" });
        card.appendChild(canvas);

        const timeEl = $el("span", { className: "neo-gallery-audio-time", textContent: "0:00 / 0:00" });
        card.appendChild(timeEl);
        card._audioTimeEl = timeEl;

        // 默认画装饰性波形占位（按文件名做确定性种子），首次播放再解码真实峰值重绘。
        // bars 存在卡片上，进度更新时据此重绘填充。
        card._audioBars = this._decorativeHeights(image.filename);
        card._renderAudio = (progress) => this._renderWaveform(canvas, card._audioBars, progress);
        card._renderAudio(0);

        // 若后端已缓存该文件的真实峰值（之前播放过），直接应用，无需再解码。
        this._loadCachedWaveform(image, subfolder, canvas, card);

        // 点击整条卡片即播放/暂停；阻止冒泡到容器，避免误触打开灯箱。
        card.addEventListener("click", (e) => {
            e.stopPropagation();
            this._toggleAudioPlayback(gallery, image, subfolder, card);
        });
        return card;
    }

    _toggleAudioPlayback(gallery, image, subfolder, card) {
        const canvas = card.querySelector(".neo-gallery-audio-waveform");
        const playBtn = card.querySelector(".neo-gallery-audio-play-btn");
        const url = getAudioSrc(image, subfolder);
        let player = gallery._audioPlayer;
        if (!player) {
            player = new Audio();
            gallery._audioPlayer = player;
            // 播放进度：重绘当前卡片波形填充 + 更新时长标签；播完复位
            player.addEventListener("timeupdate", () => gallery._onAudioTimeUpdate());
            player.addEventListener("ended", () => gallery._stopAudio());
        }
        // 已在播放本文件 → 暂停（保留当前进度）
        if (gallery._audioActiveUrl === url && !player.paused) {
            player.pause();
            playBtn.textContent = "\u25B6";
            return;
        }
        // 同一文件的暂停态 → 直接续播，不重载、不清进度
        if (gallery._audioActiveUrl === url && player.paused) {
            playBtn.textContent = "\u23F8";
            gallery._audioActiveCard = card;
            gallery._audioActiveBtn = playBtn;
            player.play().catch(err => { console.error('[Neo Gallery] audio playback failed', err); gallery._stopAudio(); });
            return;
        }
        // 切换文件：先停掉上一个并复位其按钮/波形，再加载新文件
        gallery._stopAudio();
        player.src = url;
        playBtn.textContent = "\u23F8";
        gallery._audioActiveUrl = url;
        gallery._audioActiveCard = card;
        gallery._audioActiveBtn = playBtn;
        player.play().catch(err => { console.error('[Neo Gallery] audio playback failed', err); gallery._stopAudio(); });

        // 首次播放：解码出真实峰值重绘波形（一次性开销，失败则保留装饰波形）
        if (!canvas.dataset.decoded) {
            this._decodeAndDrawWaveform(gallery, card, url, image, subfolder)
                .then(() => { canvas.dataset.decoded = "1"; })
                .catch(err => { console.warn('[Neo Gallery] waveform decode failed', err); });
        }
    }

    _renderWaveform(canvas, heights, progress = 0) {
        const dpr = window.devicePixelRatio || 1;
        // 布局前 clientWidth/Height 为 0，回退到默认尺寸；布局后按实际显示尺寸绘制更清晰
        const W = canvas.clientWidth || 240;
        const H = canvas.clientHeight || 72;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);
        const n = heights.length;
        const gap = W / n;
        for (let i = 0; i < n; i++) {
            const bh = Math.max(2, Math.min(1, heights[i]) * H * 0.9);
            const played = progress > 0 && (i + 0.5) / n <= progress;
            ctx.fillStyle = played ? "#8b5cf6" : "rgba(148, 163, 184, 0.45)";
            ctx.fillRect(i * gap, (H - bh) / 2, Math.max(1, gap - 1), bh);
        }
    }

    _decorativeHeights(seedStr) {
        const n = 60;
        let seed = 2166136261;
        for (let i = 0; i < seedStr.length; i++) {
            seed ^= seedStr.charCodeAt(i);
            seed = Math.imul(seed, 16777619) >>> 0;
        }
        const phase = (seed % 628) / 100;
        const heights = new Array(n);
        for (let i = 0; i < n; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const rnd = seed / 4294967296;
            const t = i / n;
            const base = 0.25 + 0.5 * Math.abs(Math.sin(t * Math.PI * 3 + phase));
            heights[i] = Math.min(1, base * (0.55 + rnd * 0.8));
        }
        return heights;
    }

    async _decodeAndDrawWaveform(gallery, card, url, image, subfolder) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        let actx = gallery._audioCtx;
        if (!actx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error('AudioContext unavailable');
            actx = new AC();
            gallery._audioCtx = actx;
        }
        if (actx.state === 'suspended') await actx.resume().catch(() => {});
        const audioBuf = await actx.decodeAudioData(buf);
        const data = audioBuf.getChannelData(0);
        const n = 60;
        const step = Math.max(1, Math.floor(data.length / n));
        const peaks = new Array(n);
        for (let i = 0; i < n; i++) {
            let peak = 0;
            const start = i * step;
            for (let j = start; j < start + step && j < data.length; j += 8) {
                const v = Math.abs(data[j]);
                if (v > peak) peak = v;
            }
            peaks[i] = Math.min(1, peak);
        }
        card._audioBars = peaks;
        // 持久化真实峰值到后端本地目录，之后打开卡片可直接显示正确波形。
        this._saveWaveform(image, subfolder, peaks, audioBuf.duration || 0);
        // 按当前播放进度重绘（未开始/已暂停则 progress=0）
        const player = gallery._audioPlayer;
        const dur = player && isFinite(player.duration) ? player.duration : 0;
        const progress = (dur > 0 && player) ? Math.min(1, player.currentTime / dur) : 0;
        card._renderAudio(progress);
    }

    // 从后端读取已缓存的真实波形峰值；命中则替换装饰占位并标记为已解码。
    async _loadCachedWaveform(image, subfolder, canvas, card) {
        const key = _waveformKey(image.filename, subfolder);
        let entry = _waveformSessionCache.get(key);
        if (!entry) {
            try {
                const url = `${window.location.protocol}//${window.location.host}/neo_gallery/waveform?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder || "")}`;
                const resp = await fetch(url, { headers: { "X-StopPropagation": "1" } });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && data.has && Array.isArray(data.peaks) && data.peaks.length) {
                        entry = { peaks: data.peaks, duration: Number(data.duration) || 0 };
                        _waveformSessionCache.set(key, entry);
                    }
                }
            } catch (_) {}
        }
        if (!entry) return;
        card._audioBars = entry.peaks;
        canvas.dataset.decoded = "1"; // 已有真实峰值，播放时无需再解码
        if (entry.duration > 0 && card._audioTimeEl) {
            const m = Math.floor(entry.duration / 60);
            const s = Math.floor(entry.duration % 60).toString().padStart(2, "0");
            card._audioTimeEl.textContent = `0:00 / ${m}:${s}`;
        }
        card._renderAudio(0);
    }

    // 将解码出的真实峰值写入后端本地目录缓存（失败静默，不影响播放）。
    async _saveWaveform(image, subfolder, peaks, duration) {
        const key = _waveformKey(image.filename, subfolder);
        _waveformSessionCache.set(key, { peaks, duration });
        try {
            await fetch(`${window.location.protocol}//${window.location.host}/neo_gallery/waveform`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-StopPropagation": "1" },
                body: JSON.stringify({ filename: image.filename, subfolder: subfolder || "", peaks, duration }),
            });
        } catch (_) {}
    }

    // ====== 音频发送到 LoadAudio 节点 ======

    async _showAudioSendMenu(gallery, image, button) {
        this._removeAudioSendMenu();
        if (!isAudioFile(image.filename)) {
            showToast(gallery.app, 'warning', 'Not an Audio', 'This file is not audio.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                const isLoadAudio = /load.?audio/i.test(node.comfyClass || '') || /load.?audio/i.test(node.title || '');
                const isAudioWidget = /audio/.test(wn);
                if (isLoadAudio && widget.type === 'combo' && isAudioWidget) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isText: false });
                } else if ((isLoadAudio || isAudioWidget) && widget.inputEl) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isText: widget.type === 'customtext' || widget.type === 'text' });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const isLoadAudio = /load.?audio/i.test(sn.comfyClass || '') || /load.?audio/i.test(sn.title || '');
            const hasAudioWidget = sn.widgets && sn.widgets.some(w => /audio/.test((w.name || '').toLowerCase()));
            if (isLoadAudio && hasAudioWidget) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoadAudio-type nodes found.');
            return;
        }

        menuItems.forEach(item => { item.isSelected = item.nodeId === selectedNodeId; });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            return 0;
        });

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendAudioToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-audio-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeAudioSendMenu(); gallery.sendAudioToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeAudioSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    _removeAudioSendMenu() {
        const existing = document.getElementById('neo-gallery-audio-send-menu');
        if (existing) existing.remove();
    }

    // ====== Lightbox（复用通用 Lightbox 组件）======

    _lightboxImageUrl(image, subfolder) {
        const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
        return image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
    }

    _lightboxVideoUrl(image, subfolder) {
        return `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
    }

    _fetchBlobUrl(url) {
        return fetch(url)
            .then(resp => { if (!resp.ok) throw new Error(`HTTP ${resp.status}`); return resp.blob(); })
            .then(blob => URL.createObjectURL(blob));
    }

    _toLightboxItem(img, fallbackSubfolder) {
        const owner = img.subfolder || fallbackSubfolder;
        const isVideo = isVideoFile(img.filename);
        const isAudio = isAudioFile(img.filename);
        const url = isVideo ? this._lightboxVideoUrl(img, owner)
            : isAudio ? getAudioSrc(img, owner)
            : this._lightboxImageUrl(img, owner);
        return {
            raw: img,
            subfolder: owner,
            kind: isVideo ? 'video' : isAudio ? 'audio' : 'image',
            title: img.filename,
            url,
            // 图片用 fetch+blob 取源：加载完成可判定，翻页时不会出现半张图与闪烁
            resolve: (isVideo || isAudio) ? null : () => this._fetchBlobUrl(url)
        };
    }

    // 汇总当前视图内可翻页的媒体列表。目录模式取各目录条目；其余优先用目录已加载的条目，
    // 否则回退到网格正在渲染的条目（也覆盖 allDirectories 里没有的书签目录，其条目自带 subfolder）。
    showLightbox(gallery, image, subfolder) {
        const { entries, index } = gallery.list.collectLightboxMedia(image, subfolder);
        // 点击的媒体不在当前视图（如首页单图收藏，源目录未加载）时只显示本图
        if (index < 0) {
            Lightbox.open({
                items: [this._toLightboxItem(image, subfolder)],
                index: 0,
                actions: (item) => this._lightboxActions(gallery, item),
                panel: (item) => this._buildLightboxPanel(gallery, item)
            });
            return;
        }
        Lightbox.open({
            items: entries.map(img => this._toLightboxItem(img, subfolder)),
            index,
            actions: (item) => this._lightboxActions(gallery, item),
            panel: (item) => this._buildLightboxPanel(gallery, item)
        });
    }

    _lightboxActions(gallery, item) {
        const actions = [{
            label: "\u29C9 \u590D\u5236\u56FE\u7247",
            title: "\u590D\u5236\u56FE\u7247\u5230\u526A\u8D34\u677F",
            onClick: (_item, _lightbox, btn) => this._copyImageToClipboard(item.url, btn)
        }];
        if (item.kind === 'video') {
            actions.push({
                label: "\uD83D\uDCE5 Video",
                title: "\u5C06\u89C6\u9891\u53D1\u9001\u5230\u8282\u70B9",
                onClick: (_item, _lightbox, btn) => this._showVideoSendMenu(gallery, item.raw, btn)
            });
        }
        if (item.kind === 'audio') {
            actions.push({
                label: "\uD83C\uDFB5 Audio",
                title: "将音频发送到节点",
                onClick: (_item, _lightbox, btn) => this._showAudioSendMenu(gallery, item.raw, btn)
            });
        }
        return actions;
    }
    // 侧栏：txt 副文件即时渲染；无 txt 时等内嵌元数据，没有内容就不占位。
    _buildLightboxPanel(gallery, item) {
        const image = item.raw;
        const subfolder = item.subfolder;
        if (image.txt_content) return this._lightboxPromptPanel(gallery, image, subfolder);
        return this._fetchMediaMeta(image, subfolder).then(meta =>
            (meta && meta.has) ? this._lightboxEmbeddedPanel(gallery, image, subfolder, meta) : null);
    }

    _lightboxPromptPanel(gallery, image, subfolder) {
        const body = $el("div", { className: "neo-lightbox-panel-body" });
        const sections = this.gallery.parsePromptSections(image.txt_content);
        if (sections.length > 0 && sections.some(s => s.label)) {
            for (const section of sections) {
                if (section.label) {
                    body.appendChild($el("div", { className: "neo-lightbox-panel-item" }, [
                        $el("span", { className: "neo-lightbox-panel-label", textContent: section.label + "\uff1a" }),
                        $el("span", { className: "neo-lightbox-panel-value", textContent: section.value })
                    ]));
                } else if (section.value) {
                    body.appendChild($el("div", {
                        textContent: section.value,
                        style: { marginBottom: "3px", whiteSpace: "pre-wrap" }
                    }));
                }
            }
        } else {
            body.appendChild($el("div", {
                textContent: this.gallery.cleanText(image.txt_content),
                style: { whiteSpace: "pre-wrap" }
            }));
        }

        const copyBtn = $el("div", {
            className: "neo-lightbox-panel-btn",
            textContent: "\u29C9 \u590D\u5236\u63D0\u793A\u8BCD",
            onclick: (e) => { e.stopPropagation(); this.copyToClipboard(image.name, image.txt_content, copyBtn); }
        });

        const inner = $el("div", { className: "neo-lightbox-panel-inner" }, [
            $el("div", { className: "neo-lightbox-panel-header" }, [
                $el("span", { className: "neo-lightbox-panel-title", textContent: "\u63D0\u793A\u8BCD" }),
                copyBtn
            ]),
            body
        ]);

        const btns = $el("div", { className: "neo-lightbox-panel-btns", style: { display: "none" } });
        inner.appendChild(btns);
        this._fetchMediaMeta(image, subfolder).then(meta => {
            // 已翻页或面板已销毁：丢弃过期结果，避免覆盖新页内容。
            if (!inner.isConnected || !meta || !meta.has) return;
            const frag = this._buildMetaButtons(meta, gallery, image, subfolder);
            if (!frag.childNodes.length) return;
            btns.style.display = "";
            btns.appendChild(frag);
        }).catch(() => {});

        return inner;
    }

    _lightboxEmbeddedPanel(gallery, image, subfolder, meta) {
        const body = $el("div", { className: "neo-lightbox-panel-body" });
        const texts = meta.texts;
        const addSection = (label, arr) => {
            if (!arr || !arr.length) return;
            body.appendChild($el("div", { className: "neo-lightbox-panel-item" }, [
                $el("span", { className: "neo-lightbox-panel-label", textContent: label + "\uff1a" }),
                $el("span", { className: "neo-lightbox-panel-value", textContent: arr.join("\n"), style: { whiteSpace: "pre-wrap" } })
            ]));
        };
        addSection("\u6B63\u5411", texts?.positive);
        addSection("\u8D1F\u5411", texts?.negative);

        const inner = $el("div", { className: "neo-lightbox-panel-inner" }, [body]);
        const frag = this._buildMetaButtons(meta, gallery, image, subfolder);
        if (frag.childNodes.length) {
            const btns = $el("div", { className: "neo-lightbox-panel-btns" });
            btns.appendChild(frag);
            inner.appendChild(btns);
        }
        return inner;
    }

    _fetchMediaMeta(image, subfolder) {
        // 按文件缓存元数据 Promise：翻页来回切换时不再重复请求，避免右侧面板文字闪烁。
        const key = `${subfolder}/${image.filename}`;
        if (!this._mediaMetaCache) this._mediaMetaCache = new Map();
        let p = this._mediaMetaCache.get(key);
        if (!p) {
            const params = `filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
            p = fetch(`/neo_gallery/media_meta?${params}`).then(r => (r.ok ? r.text() : null)).then(txt => {
                if (!txt) return null;
                try {
                    return JSON.parse(txt);
                } catch (e) {
                    // ComfyUI 内嵌元数据可能含非标准 NaN/Infinity 字面量，替换后重试
                    return JSON.parse(txt.replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null"));
                }
            }).catch(() => null);
            this._mediaMetaCache.set(key, p);
        }
        return p;
    }

    // 导入素材内嵌的 ComfyUI 工作流到画布（灯箱「导入工作流」按钮与卡片扩展菜单共用）。
    async _importWorkflowFromMedia(gallery, image, subfolder) {
        const meta = await this._fetchMediaMeta(image, subfolder);
        if (!meta || !meta.has) throw new Error("此素材没有内嵌工作流");
        const wf = meta.workflow;
        const isUiFormat = !!(wf && Array.isArray(wf.nodes));
        const source = isUiFormat ? wf
            : (meta.prompt && typeof app.loadApiJson === "function") ? meta.prompt
            : null;
        if (!source) {
            throw new Error(wf ? "工作流缺少 nodes 数据，无法载入" : "此文件只有 API 格式工作流且当前前端不支持");
        }
        if (isUiFormat) {
            await app.loadGraphData(source);
        } else {
            await app.loadApiJson(source, "gallery-example");
        }
        Lightbox.close();
        requestAnimationFrame(() => {
            const canvas = app.canvas;
            const nodes = canvas?.graph?.nodes;
            if (!nodes?.length || !canvas.ds) return;
            const b = [Infinity, Infinity, -Infinity, -Infinity];
            for (const n of nodes) {
                const r = n.boundingRect || [n.pos[0], n.pos[1], n.size?.[0] || 0, n.size?.[1] || 0];
                b[0] = Math.min(b[0], r[0]);
                b[1] = Math.min(b[1], r[1]);
                b[2] = Math.max(b[2], r[0] + r[2]);
                b[3] = Math.max(b[3], r[1] + r[3]);
            }
            if (!b.every(isFinite)) return;
            canvas.ds.fitToBounds([b[0] - 10, b[1] - 10, b[2] - b[0] + 20, b[3] - b[1] + 20]);
            canvas.setDirty?.(true, true);
        });
        showToast(gallery.app, "success", "工作流已载入画布", "");
    }

    _buildMetaButtons(meta, gallery, image, subfolder) {
        const frag = document.createDocumentFragment();
        if (meta.workflow || meta.prompt) {
            const loadBtn = document.createElement('div');
            loadBtn.className = "neo-lightbox-panel-btn";
            loadBtn.textContent = "\u2937 \u5BFC\u5165\u5DE5\u4F5C\u6D41";
            loadBtn.title = "将此示例内嵌的 ComfyUI 工作流载入画布";
            loadBtn.onclick = async (e) => {
                e.stopPropagation();
                if (loadBtn.disabled) return;
                loadBtn.disabled = true;
                const origLabel = loadBtn.textContent;
                loadBtn.textContent = "⏳ 检测中…";
                loadBtn.style.opacity = "0.6";
                try {
                    await this._importWorkflowFromMedia(gallery, image, subfolder);
                } catch (err) {
                    showToast(gallery.app, "error", "导入失败", String(err.message || err));
                } finally {
                    loadBtn.disabled = false;
                    loadBtn.textContent = origLabel;
                    loadBtn.style.opacity = "";
                }
            };
            frag.appendChild(loadBtn);
        }
        return frag;
    }
}
