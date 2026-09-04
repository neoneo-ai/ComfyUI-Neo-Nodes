/**
 * prompt-manager.js
 * 提示词管理模块 - UI 组件创建 + 保存、列表、加载、删除
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { attachComboBox } from "./combo-box.js";
import { collectWorkflowAssets, collectWorkflowResults, collectWorkflowLoras, saveRecipe, listRecipes, deleteRecipe, applyRecipeToWorkflow, RECIPE_ICON_SVG } from "./recipes.js";

import {
    savePrompt,
    loadPrompt,
    listPrompts,
    listPromptLines,
    deletePrompt,
    extractTitle,
    extractClassify,
    randomPrompt as randomPromptAPI,
    fileToBase64,
    imagesFromClipboard
} from "./prompt-service.js";
import { listSkills, createSkillManagerModal, renderMarkdown } from "./skill.js";
import { createModelConfigForm } from "./llm-setting.js";

// 字节数转人类可读大小（后端 /rs_prompts/get_models 返回的 file_size，多模态已含 mmproj）
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(bytes);
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    const rounded = i === 0 ? String(Math.round(size)) : Math.round(size * 10) / 10;
    return rounded + ' ' + units[i];
}

// ==========================================
// DOM 元素工厂
// ==========================================

function mkEl(tag, className, styles = '') {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (styles) {
        el.style.cssText = styles;
    }
    return el;
}

// ==========================================
// UI 组件创建 (内部使用)
// ==========================================

function createOverlayWithSearch() {
    const overlay = mkEl("div", "rs-preset-list-overlay");
    // Search input at top of the panel
    const searchBar = mkEl("input", "rs-preset-search-input");
    searchBar.type = "text";
    searchBar.placeholder = "🔍 Search presets...";
    const body = mkEl("div", "rs-preset-list-body");
    overlay.appendChild(searchBar);
    overlay.appendChild(body);
    return { overlay, body, searchBar };
}

function createInputModal() {
    const modal = mkEl("div", "rs-preset-name-input");
    const aiStatus = mkEl("div", "rs-ai-status processing");
    aiStatus.innerHTML = "⏳ AI 正在分析提示词...";

    const label = mkEl("div", "rs-input-label");
    label.textContent = "名称:";

    const inputWrapper = mkEl("div", "rs-input-wrapper");
    const field = mkEl("input", "rs-input-field");
    field.placeholder = "Enter preset name...";
    inputWrapper.appendChild(field);

    const tagsLabel = mkEl("div", "rs-input-label");
    tagsLabel.textContent = "Tags (optional):";

    const tagsContainer = mkEl("div", "rs-tags-container");
    const tagList = ["唯美", "特色", "写实", "古风", "动漫", "油画", "室内", "户外"];
    const selectedTags = new Set();

    tagList.forEach(tag => {
        const tagBtn = mkEl("button", "rs-tag-btn");
        tagBtn.textContent = tag;
        tagBtn.addEventListener("click", () => {
            if (selectedTags.has(tag)) {
                selectedTags.delete(tag);
                tagBtn.classList.remove("rs-tag-selected");
            } else {
                selectedTags.add(tag);
                tagBtn.classList.add("rs-tag-selected");
            }
        });
        tagsContainer.appendChild(tagBtn);
    });

    const recipeHint = mkEl("div", "rs-recipe-hint");
    recipeHint.style.display = "none";

    // 同时保存结果：把当前工作流最近一次执行的输出存入配方 samples/（用于封面与预览），
    // 示例文件内嵌了 ComfyUI 工作流，可在详情浮层一键复制回画布。
    const saveResultsRow = mkEl("label", "rs-save-results-row");
    saveResultsRow.title = "把当前工作流最近一次执行的输出存入配方，用于封面与预览展示；示例内嵌工作流，可在详情浮层一键复制回画布";
    const saveResultsCheck = mkEl("input", "rs-save-results-check");
    saveResultsCheck.type = "checkbox";
    saveResultsCheck.checked = true; // 默认选中当前运行结果与工作流备份
    const saveResultsText = mkEl("span", "");
    saveResultsText.textContent = "同时保存结果";
    saveResultsRow.append(saveResultsCheck, saveResultsText);
    saveResultsRow.style.display = "none";

    const btnsDiv = mkEl("div", "rs-input-buttons");
    const okBtn = mkEl("button", "rs-input-ok-btn");
    okBtn.textContent = "保存提示词";
    const recipeOkBtn = mkEl("button", "rs-input-ok-btn rs-input-recipe-btn");
    recipeOkBtn.innerHTML = `${RECIPE_ICON_SVG}<span>保存配方</span>`;
    recipeOkBtn.style.display = "none";
    const cancelBtn = mkEl("button", "rs-input-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, recipeOkBtn, cancelBtn);
    modal.append(aiStatus, label, inputWrapper, tagsLabel, tagsContainer, recipeHint, saveResultsRow, btnsDiv);

    return { modal, aiStatus, label, field, inputWrapper, tagsLabel, tagsContainer, okBtn, recipeOkBtn, cancelBtn, selectedTags, recipeHint, saveResultsRow, saveResultsCheck };
}

function createDeleteModal() {
    const modal = mkEl("div", "rs-delete-confirm-overlay");
    const textDiv = mkEl("div", "rs-delete-text");
    const btnsDiv = mkEl("div", "rs-delete-buttons");
    const okBtn = mkEl("button", "rs-delete-ok-btn");
    okBtn.textContent = "OK";
    const cancelBtn = mkEl("button", "rs-delete-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, cancelBtn);
    modal.append(textDiv, btnsDiv);
    return { modal, textDiv, okBtn, cancelBtn };
}

// ==========================================
// Quick input tips rotation
// ==========================================

const QUICK_INPUT_TIPS = [
    "✨ 输入描述，AI 自动帮你生成提示词",
    "📝 输入改写需求，如：'去掉动漫风格，改成写实'",
    "🌐 输入翻译需求，如：'翻译成中文'",
    "🎨 输入风格要求，如：'改成赛博朋克风格'",
    "📷 输入场景描述，如：'夕阳下的海边日落'",
    "🔍 输入关键词搜索已有提示词",
    "🚀 输入描述后按 Enter 生成，Shift+Enter 换行",
    "🔄 输入修改指令，如：'增加细节描述'",
    "🎭 输入角色描述，如：'一个穿着汉服的女孩'",
    "🌅 输入时间场景，如：'清晨的森林，阳光穿透树叶'",
    "🏙️ 输入城市描述，如：'未来科幻城市，高楼林立'",
    "💾 点击保存按钮将提示词存为预设",
    "▾ 自动增强菜单内配置 LLM，🎛️ 管理技能/模板"
];

function getRandomTip() {
    return QUICK_INPUT_TIPS[Math.floor(Math.random() * QUICK_INPUT_TIPS.length)];
}

// ==========================================
// Status bars with toggle, template selector, action buttons
// ==========================================

function createStatusBars() {
    const statusBar = mkEl("div", "rs-status-bar");
    
    const toggleWrapper = mkEl("div", "rs-toggle-wrapper");
    
    // Tab-style toggle with text labels
    const toggleSwitch = mkEl("div", "rs-toggle-switch");
    toggleSwitch.setAttribute("data-rs-tooltip", "Switch between local prompt and external input");
    
    const localTab = mkEl("div", "rs-toggle-tab rs-toggle-local");
    localTab.textContent = "LOCAL";
    localTab.dataset.state = "local";
    
    const externalTab = mkEl("div", "rs-toggle-tab rs-toggle-external");
    externalTab.textContent = "EXTERNAL";
    externalTab.dataset.state = "external";
    
    toggleSwitch.appendChild(localTab);
    toggleSwitch.appendChild(externalTab);
    toggleWrapper.appendChild(toggleSwitch);
    
    // Template selector dropdown (now skill-aware: templates + tasks + image skills)
    const tplSelector = mkEl("select", "rs-tpl-selector");
    tplSelector.title = "Select skill (template / task / image)";
    // 复用可搜索下拉组件：skill 数量多时支持输入过滤；原生 select 仍作数据源，
    // doPopulate 的选项重建 / value 恢复 / change 派发协议不变。
    // 注意：可见 UI 是返回的 box（select 已被移入其中），工具栏须挂载 box 而非 select。
    const tplCombo = attachComboBox(tplSelector, { placeholder: "🔍 输入过滤 skill...", emptyText: "无匹配 skill" });

    // 附加图片 chips 容器 + 图片选择按钮（用于反推等 vision skill）
    const imageChipsRow = mkEl("div", "rs-image-chips");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    const attachedImages = []; // [{data: dataURI, name: string}]

    function addImageFile(file) {
        return fileToBase64(file).then(img => {
            attachedImages.push(img);
            renderImageChips();
            return img;
        }).catch(e => console.error("Failed to read image:", e));
    }

    // 悬停放大预览：单例元素挂在 body 上（fixed 定位），避免被节点 overflow 裁剪
    let imageHoverPreview = null;

    function showImageHoverPreview(src, anchorEl) {
        if (!imageHoverPreview) {
            imageHoverPreview = mkEl("img", "rs-image-hover-preview");
            document.body.appendChild(imageHoverPreview);
        }
        // 预览最大尺寸跟随画布缩放比率，保持与节点内容的视觉大小一致
        const canvasScale = app?.canvas?.ds?.scale || 1;
        const scale = Math.max(0.4, Math.min(canvasScale, 2.5));
        const maxW = 320 * scale;
        const maxH = 320 * scale;
        imageHoverPreview.style.maxWidth = maxW + "px";
        imageHoverPreview.style.maxHeight = maxH + "px";

        const r = anchorEl.getBoundingClientRect();
        // 按图片实际显示尺寸（保持宽高比）定位，避免横向/纵向图片偏离缩略图太远
        const positionPreview = () => {
            if (imageHoverPreview.style.display !== "block") return;
            const nw = imageHoverPreview.naturalWidth || maxW;
            const nh = imageHoverPreview.naturalHeight || maxH;
            const k = Math.min(1, maxW / nw, maxH / nh); // 不放大，仅按需缩小
            const dispW = nw * k;
            const dispH = nh * k;
            let left = r.left + r.width / 2 - dispW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - dispW - 8));
            let top = r.top - dispH - 10; // 默认显示在缩略图上方
            if (top < 8) top = r.bottom + 10; // 放不下则翻到下方
            imageHoverPreview.style.left = left + "px";
            imageHoverPreview.style.top = top + "px";
        };
        imageHoverPreview.onload = positionPreview;
        imageHoverPreview.src = src;
        imageHoverPreview.style.display = "block";
        // 缓存命中时 onload 不触发，complete 时立即定位
        if (imageHoverPreview.complete && imageHoverPreview.naturalWidth) {
            positionPreview();
        }
    }

    function hideImageHoverPreview() {
        if (imageHoverPreview) imageHoverPreview.style.display = "none";
    }

    function renderImageChips() {
        imageChipsRow.innerHTML = "";
        attachedImages.forEach((img, idx) => {
            const chip = mkEl("span", "rs-image-chip");

            const thumb = document.createElement("img");
            thumb.src = img.input ? inputViewUrl(img.input) : img.data;
            thumb.alt = `Image ${idx + 1}`;
            thumb.className = "rs-image-chip-thumb";
            // 悬停放大预览
            thumb.addEventListener("mouseenter", () => showImageHoverPreview(thumb.src, chip));
            thumb.addEventListener("mouseleave", hideImageHoverPreview);

            // 顺序编号 badge：显示该图的参数位 <Picture N>；无参数位（反推附件）不显示编号
            const controls = mkEl("span", "rs-image-controls");

            if (img.pictureNo != null) {
                const orderBadge = mkEl("span", "rs-image-order-badge");
                orderBadge.textContent = `${img.pictureNo}`;
                controls.appendChild(orderBadge);
            }

            // 删除按钮
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "✕";
            del.className = "rs-image-chip-del";
            del.title = "移除图片";
            del.addEventListener("click", () => {
                attachedImages.splice(idx, 1);
                renderImageChips();
            });

            controls.appendChild(del);
            chip.appendChild(thumb);
            chip.appendChild(controls);
            imageChipsRow.appendChild(chip);
        });
    }

    function clearImages() {
        attachedImages.length = 0;
        renderImageChips();
    }

    // input 目录图片的缩略图地址（ComfyUI /view 端点）
    function inputViewUrl(value) {
        const v = String(value).trim().replace(/\[[^\]]*\]$/, "");
        const i = v.lastIndexOf("/");
        const fname = i >= 0 ? v.slice(i + 1) : v;
        const sub = i >= 0 ? v.slice(0, i) : "";
        return `/view?filename=${encodeURIComponent(fname)}&subfolder=${encodeURIComponent(sub)}&type=input`;
    }

    // 图片判重键：去掉 [input]/[output] 标注并归一化
    function imageKey(value) {
        return String(value || "").replace(/\[[^\]]*\]\s*$/, "").trim();
    }

    // 以文件名形式附加图片（出队时由后端从 input/output 目录解析，无需连线）。
    // 判重：同一图片已附加则忽略，避免重复 chip / 编号错乱。
    // pictureNo：目标节点 IMAGE 输入参数序号；未连接的图片为 undefined（仅作反推附件）。
    function addImageInput(value, name, pictureNo) {
        const key = imageKey(value);
        if (!key) return;
        const dup = attachedImages.some(img => imageKey(img.input) === key);
        if (dup) return;
        attachedImages.push({ name: name || key.split("/").pop(), input: value, pictureNo });
        renderImageChips();
    }

    // 收集工作流上未禁用的 Load Image 节点图片（与 gallery 发送按钮同款过滤：跳过 BYPASS/禁用）。
    // pictureNo：图片输出连接到目标节点 IMAGE 输入槽的参数序号（1-based）；无连线为 null，仅能用于反推。
    function collectWorkflowLoadImages() {
        return (async () => {
            try {
                let nodes = null;
                let serializedLinks = null; // graphToPrompt 序列化格式的 links 数组
                if (typeof app?.graphToPrompt === "function") {
                    try {
                        const prompt = await app.graphToPrompt();
                        nodes = prompt?.workflow?.nodes || null;
                        serializedLinks = prompt?.workflow?.links || null;
                    } catch (e) {
                        console.warn("[Neo] graphToPrompt:", e);
                    }
                }
                if (!Array.isArray(nodes)) nodes = app.graph?._nodes || [];

                // linkId -> {origin_id, target_id, target_slot}
                const linkMap = new Map();
                if (Array.isArray(serializedLinks)) {
                    for (const l of serializedLinks) {
                        // [id, origin_id, origin_slot, target_id, target_slot, type]
                        if (Array.isArray(l)) linkMap.set(String(l[0]), { origin_id: l[1], target_id: l[3], target_slot: l[4] });
                    }
                } else {
                    const gl = app.graph?.links;
                    const iter = gl && typeof gl.forEach === "function" ? gl : Object.values(gl || {});
                    iter.forEach(l => {
                        if (l && l.target_id != null) linkMap.set(String(l.id), l);
                    });
                }
                const nodeById = new Map(nodes.map(n => [String(n.id), n]));

                // 该 load image 输出连到目标节点 IMAGE 输入槽的参数序号；无连线返回 null
                const computePictureNo = (n) => {
                    for (const o of (n.outputs || [])) {
                        const lids = Array.isArray(o.links) ? o.links : (o.link != null ? [o.link] : []);
                        for (const lid of lids) {
                            const link = linkMap.get(String(lid));
                            if (!link) continue;
                            const target = nodeById.get(String(link.target_id));
                            if (!target) continue;
                            let count = 0;
                            const slotIdx = Number(link.target_slot) || 0;
                            for (let i = 0; i < (target.inputs || []).length; i++) {
                                if (String(target.inputs[i].type).toUpperCase() !== "IMAGE") continue;
                                count++;
                                if (i === slotIdx) return count;
                            }
                        }
                    }
                    return null;
                };

                // 有参数位（pictureNo）的优先排在前面；两组内部保持工作流原有顺序
                const connected = [];
                const unconnected = [];
                const skipped = [];
                for (const n of nodes) {
                // 核心 LoadImage / LoadImageOutput 及各类加载器变体
                const cls = String(n.comfyClass || n.type || "");
                if (!/load.*image/i.test(cls)) continue;
                if (n.mode === 2 || n.mode === 4) continue; // NEVER / BYPASS
                // 新增/切换/粘贴加载的节点，其 widgets_values 可能滞后于当前 widget 值。
                // 与前端序列化一致：先把自己节点的 widget 当前值回填，避免 @ 读到旧图片。
                if (Array.isArray(n.widgets) && Array.isArray(n.widgets_values)) {
                    for (let i = 0; i < n.widgets.length; i++) {
                        const w = n.widgets[i];
                        if (w && w.value !== undefined) n.widgets_values[i] = w.value;
                    }
                }
                // widgets_values 里图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
                let raw;
                for (const entry of (n.widgets_values || [])) {
                    if (typeof entry === "string" || Array.isArray(entry)) { raw = entry; break; }
                    if (entry && typeof entry === "object" && (entry.name || entry.filename)) { raw = entry; break; }
                }
                let v = "";
                if (typeof raw === "string") v = raw.trim();
                else if (Array.isArray(raw)) v = String(raw[0] ?? "").trim();
                else if (raw && typeof raw === "object") v = String(raw.name ?? raw.filename ?? "").trim();
                if (!v) {
                    skipped.push(`节点#${n.id}: empty`);
                    continue;
                }
                // [input]/[output] 标注不参与扩展名判断
                const base = v.replace(/\[[^\]]*\]\s*$/, "").trim();
                if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(base)) {
                    skipped.push(`节点#${n.id}: ${v}`);
                    continue;
                }
                const pictureNo = computePictureNo(n);
                (pictureNo != null ? connected : unconnected).push({ value: v, nodeId: n.id, pictureNo });
            }
            if (skipped.length) console.info("[Neo] @ 图片选择器跳过的加载节点:", skipped);
            return [...connected, ...unconnected];
        } catch (e) {
            console.warn("collectWorkflowLoadImages:", e);
            return [];
        }
        })();
    }

    // 估算 textarea 光标距内容区左上角的像素坐标（用于把 @ 弹层定位到光标附近）
    function getCaretPixel(el) {
        const mirror = mkEl("div");
        const cs = window.getComputedStyle(el);
        for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle",
                         "letterSpacing", "lineHeight", "textTransform", "wordSpacing",
                         "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                         "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
                         "boxSizing", "width"]) {
            mirror.style[p] = cs[p];
        }
        mirror.style.position = "absolute";
        mirror.style.left = "-99999px";
        mirror.style.top = "0";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.wordWrap = "break-word";
        mirror.style.overflowWrap = "break-word";
        mirror.style.visibility = "hidden";
        const before = mkEl("span");
        before.textContent = el.value.slice(0, el.selectionStart);
        const marker = mkEl("span");
        marker.textContent = "\u200b"; // 零宽空格占位，测光标位置
        mirror.appendChild(before);
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const mRect = marker.getBoundingClientRect();
        const m0 = mirror.getBoundingClientRect();
        document.body.removeChild(mirror);
        return { x: mRect.left - m0.left, y: mRect.top - m0.top };
    }

    async function openAtImagePicker() {
        if (quickInputWrapper.querySelector(".rs-at-picker")) return;
        // @ 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入图片标记
        const sel = quickInput.selectionStart || 0;
        const atIndex = sel - 1;
        if (atIndex < 0 || quickInput.value[atIndex] !== "@") return;
        const images = await collectWorkflowLoadImages();
        // await 期间用户可能改动了输入：@ 不在原位置则放弃
        if (quickInput.value[atIndex] !== "@") return;

        // 点击行即插入：已附加的图片引用现有 <Picture N>，未附加的先添加再插入，然后关闭弹层
        const insertImageAtCaret = (img) => {
            if (!img || quickInput.value[atIndex] !== "@") { closePicker(); return; }
            // 无参数位（输出未连接）：仅作为反推附件附加，不占用 <Picture N> 编号
            if (img.pictureNo == null) {
                addImageInput(img.value); // 内部判重，已附加则忽略
                closePicker();
                return;
            }
            // 有参数位：确保已附加（chips 用于发送 payload），插入其参数序号标记
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (existIdx < 0) addImageInput(img.value, null, img.pictureNo);
            const marker = "<Picture " + img.pictureNo + ">";
            quickInput.value = quickInput.value.slice(0, atIndex) + marker + quickInput.value.slice(atIndex + 1);
            // 焦点回到输入框并停在插入标记之后，方便继续输入
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(atIndex + marker.length, atIndex + marker.length);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            closePicker();
        };

        const picker = mkEl("div", "rs-at-picker");
        const list = mkEl("div", "rs-at-picker-list");

        // 弹层无标题栏：无可用图片时在列表内给占位提示
        if (!images.length) {
            const empty = mkEl("div", "rs-at-picker-empty");
            empty.textContent = "工作流中没有可用的 Load Image 图片";
            list.appendChild(empty);
        }

        images.forEach(img => {
            const row = mkEl("div", "rs-at-picker-row");
            row.style.position = "relative";

            const thumb = mkEl("img", "rs-at-picker-thumb");
            thumb.src = inputViewUrl(img.value);

            row.addEventListener("click", () => insertImageAtCaret(img));

            // 徽章语义：
            // - 有参数位（pictureNo）：蓝色 #N，点击插入/引用 <Picture N>
            // - 无参数位但已附加：灰色 ✓，点击无操作（仅作反推附件）
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (img.pictureNo != null) {
                const picBadge = mkEl("span", "rs-picker-pic-badge");
                picBadge.textContent = `#${img.pictureNo}`;
                row.append(thumb, picBadge);
            } else if (existIdx >= 0) {
                const refBadge = mkEl("span", "rs-picker-ref-badge");
                refBadge.textContent = "✓";
                row.append(thumb, refBadge);
            } else {
                row.append(thumb);
            }
            list.appendChild(row);
        });

        picker.append(list);
        // 挂到 body 并用 fixed 定位：quickInputWrapper 的 overflow 会裁剪内部弹层
        document.body.appendChild(picker);

        // ==========================================
        // 键盘导航：↑/↓ 移动高亮，Enter 插入当前项，Esc 关闭
        // ==========================================
        picker.tabIndex = 0;
        let activeIndex = 0;
        const rowEls = Array.from(list.querySelectorAll(".rs-at-picker-row"));
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls.length - 1, idx));
            rowEls.forEach((r, i) => {
                r.classList.toggle("rs-picker-row-active", i === activeIndex);
            });
            const activeEl = rowEls[activeIndex];
            // 只滚动列表内部，避免 scrollIntoView 连带滚动祖先/页面导致弹层整体偏离
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) {
                    list.scrollTop = rowTop;
                } else if (rowBottom > listBottom) {
                    list.scrollTop = rowBottom - list.clientHeight;
                }
            }
        };
        rowEls.forEach((row, idx) => {
            row.classList.add("rs-picker-row");
            row.addEventListener("mousemove", () => setActiveRow(idx));
        });
        picker.addEventListener("keydown", (e) => {
            // 阻断冒泡，避免 ComfyUI 全局键盘处理器（画布平移等）响应这些按键导致弹层偏离输入框
            if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", " ", "Enter"].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
            switch (e.key) {
                case "ArrowDown":
                    setActiveRow(activeIndex + 1);
                    break;
                case "ArrowUp":
                    setActiveRow(activeIndex - 1);
                    break;
                case "Home":
                    setActiveRow(0);
                    break;
                case "End":
                    setActiveRow(rowEls.length - 1);
                    break;
                case "Enter":
                    insertImageAtCaret(images[activeIndex]);
                    break;
            }
        });
        // 打开后聚焦到 picker，让键盘立即可用，同时保留 Esc 全局处理
        picker.focus({ preventScroll: true });
        setTimeout(() => setActiveRow(0), 0);

        let handleEsc = null;
        let handleInputChange = null;
        const closePicker = () => {
            document.removeEventListener("mousedown", onOutside);
            if (handleEsc) document.removeEventListener("keydown", handleEsc);
            if (handleInputChange) quickInput.removeEventListener("input", handleInputChange);
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target)) closePicker();
        };
        setTimeout(() => document.addEventListener("mousedown", onOutside), 0);

        // 锚定到 @ 所在光标位置附近（支持在文本中间插入时跟随 @）。
        // 同步读取坐标并在同一次布局内计算定位，避免 rAF 延迟到下一帧导致缩放/布局变化偏移。
        const r = quickInput.getBoundingClientRect();
        const caret0 = getCaretPixel(quickInput);
        // 计算元素所在缩放容器的实际缩放比例：getBoundingClientRect 返回层叠后的屏幕坐标，
        // 而 getCaretPixel 的镜像测量返回 CSS 内容坐标。两者不一致时按比例校正，抵消画布缩放偏移。
        const elW = quickInput.offsetWidth || r.width;
        const elH = quickInput.offsetHeight || r.height;
        const scaleX = elW ? r.width / elW : 1;
        const scaleY = elH ? r.height / elH : scaleX;
        const caret = { x: caret0.x * scaleX, y: caret0.y * scaleY };
        const cs = window.getComputedStyle(quickInput);
        const bLeft = parseFloat(cs.borderLeftWidth) || 0;
        const bTop = parseFloat(cs.borderTopWidth) || 0;
        const pw = Math.min(Math.max(r.width, 50), 80); // 限制宽度在 50-80px 之间
        const estHeight = 260;
        let left = r.left + bLeft + caret.x - quickInput.scrollLeft;
        let top = r.top + bTop + caret.y + 20 - quickInput.scrollTop; // 默认在其下方
        // 水平：优先让弹层显示在 @ 右侧，超视口则靠右对齐
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
        // 垂直：下方放不下则翻到上方
        if (top + estHeight > window.innerHeight - 8) {
            top = r.top + bTop + caret.y - 14 - estHeight;
        }
        picker.style.left = Math.max(8, left) + "px";
        picker.style.top = Math.max(8, top) + "px";
        picker.style.width = pw + "px";

        // ESC 键关闭选择器
        handleEsc = (e) => {
            if (e.key === "Escape") closePicker();
        };
        document.addEventListener("keydown", handleEsc);

        // 监听输入框变化，如果 @ 被删除（选择器将失去对应锚点）则关闭
        handleInputChange = () => {
            if (quickInput.value[atIndex] !== "@") closePicker();
        };
        quickInput.addEventListener("input", handleInputChange);

        cancelBtn.addEventListener("click", closePicker);
        okBtn.addEventListener("click", () => {
            if (!selected.length) { closePicker(); return; }
            // 编号顺序由工作流 Load Image 节点参数顺序决定（images 顺序），而非点击顺序。
            // 已附加的图片只做引用（插入现有编号），未附加的才真正添加。
            const markers = [];
            images.forEach(img => {
                if (!selected.includes(img.value)) return;
                const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
                if (existIdx >= 0) {
                    markers.push("<Picture " + (existIdx + 1) + ">");
                    return;
                }
                addImageInput(img.value);
                markers.push("<Picture " + attachedImages.length + ">");
            });
            // 在 @ 所在位置替换成内联 <Picture N> 标记（编号与 chips 一致），用于描述图片间交互
            if (quickInput.value[atIndex] === "@" && markers.length) {
                const joined = markers.join(" ");
                quickInput.value = quickInput.value.slice(0, atIndex) + joined + quickInput.value.slice(atIndex + 1);
                // 光标放到插入标记之后
                quickInput.setSelectionRange(atIndex + joined.length, atIndex + joined.length);
                quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
            closePicker();
        });
    }

    // 图片选择按钮（+）
    const attachBtn = mkEl("button", "rs-attach-btn");
    attachBtn.textContent = "+";
    attachBtn.title = "附加图片（反推/多模态 skill）";
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        Array.from(fileInput.files || []).forEach(addImageFile);
        fileInput.value = "";
    });

    const CATEGORY_LABELS = {
        "vision": { label: "🖼️ 图像 / 反推", order: 0 },
        "task": { label: "⚙️ 任务", order: 1 },
        "style": { label: "🎨 风格模板", order: 2 },
        "custom": { label: "📝 自定义", order: 3 }
    };

    /** 从起始节点出发做 BFS，返回同一连通分量的所有节点 */
    function getConnectedNodes(startNode) {
        if (!startNode || !app.graph?._nodes) return null;
        const allNodes = app.graph._nodes;
        const visited = new Set();
        const queue = [startNode.id];
        visited.add(startNode.id);
        while (queue.length > 0) {
            const curId = queue.shift();
            const cur = allNodes.find(n => n.id === curId);
            if (!cur) continue;
            // 遍历输出 → 下游节点
            for (let si = 0; si < (cur.outputs || []).length; si++) {
                const links = cur.outputs[si].links || [];
                for (const linkId of links) {
                    const link = app.graph.links?.[linkId];
                    if (link && !visited.has(link.target_id)) {
                        visited.add(link.target_id);
                        queue.push(link.target_id);
                    }
                }
            }
            // 遍历输入 ← 上游节点
            for (let si = 0; si < (cur.inputs || []).length; si++) {
                const linkId = cur.inputs[si]?.link;
                if (linkId && app.graph.links?.[linkId]) {
                    const lnk = app.graph.links[linkId];
                    if (!visited.has(lnk.origin_id)) {
                        visited.add(lnk.origin_id);
                        queue.push(lnk.origin_id);
                    }
                }
            }
        }
        return allNodes.filter(n => visited.has(n.id));
    }

    /** 自动检测当前工作流的上下文（CLIP类型、模型类型），返回 context tags 集合 */
    function detectWorkflowContext(startNode) {
        const ctx = new Set();
        let nodes;
        if (startNode) {
            const connected = getConnectedNodes(startNode);
            nodes = connected || [startNode];
        } else {
            nodes = app.graph?._nodes;
        }
        nodes.forEach(node => {
            // CLIPLoader: widget "type" is the CLIP type (e.g. "krea2", "minimax")
            if (node.type === "CLIPLoader" || node.comfyClass === "CLIPLoader") {
                const typeWidget = node.widgets?.find(w => w.name === "type");
                if (typeWidget) ctx.add(String(typeWidget.value || "").toLowerCase());
            }
            // UNETLoader / VAELoader: collect model name widget value
            const modelNameWidget = node.widgets?.find(w => w.name === "model_name" || w.name === "vae_name" || w.name === "ckpt_name");
            if (modelNameWidget) {
                ctx.add(String(modelNameWidget.value || "").toLowerCase());
            }
            // Add the full node title for broader tag matching
            const title = String(node.title || "").trim();
            if (title && title !== node.type) {
                ctx.add(title.toLowerCase());
            }
        });
        return ctx;
    }

    // debounce: per-node timer to avoid duplicate calls from multiple init paths
    const _populateTimer = new Map();

    async function populateTemplateSelector(startNode = null) {
        const node = startNode;
        if (node && _populateTimer.has(node.id)) {
            clearTimeout(_populateTimer.get(node.id));
        }
        return new Promise(resolve => {
            _populateTimer.set(node.id, setTimeout(() => {
                _populateTimer.delete(node.id);
                Promise.resolve(doPopulate(startNode)).then(resolve, resolve);
            }, 50));
        });
    }

    async function doPopulate(startNode = null) {
        const skills = await listSkills();
        const currentVal = tplSelector.value;
        // 自动检测工作流上下文并预筛选/预选择最佳 skill
        const detectedCtx = detectWorkflowContext(startNode);
        let bestMatchId = null;
        if (detectedCtx.size > 0) {
            let bestScore = -1;
            skills.forEach(s => {
                const skillTags = (s.tags || []).map(t => String(t).toLowerCase());
                // 子串 + 分词双向匹配
                const matched = [];
                [...detectedCtx].forEach(tag => {
                    skillTags.forEach(st => {
                        if (tag.includes(st) || st.includes(tag)) {
                            if (!matched.includes(st)) matched.push(st);
                        } else {
                            const words = tag.split(/[\s\-_/\\]+/).filter(w => w.length > 0);
                            if (words.some(w => st.includes(w) || w.includes(st))) {
                                if (!matched.includes(st)) matched.push(st);
                            }
                        }
                    });
                });
                const score = matched.length;
                if (score > 0) {
                    console.log(`[PromptManager] skill=${s.id} matchTags=[${matched.join(",")}]`);
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestMatchId = s.id;
                }
            });
        }
        tplSelector.innerHTML = "";

        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "默认";
        tplSelector.appendChild(defaultOpt);

        if (skills) {
            // 按 category 分组
            const groups = {};
            skills.forEach(s => {
                const cat = CATEGORY_LABELS[s.category] ? s.category : "style";
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(s);
            });
            Object.keys(groups).sort((a, b) =>
                (CATEGORY_LABELS[a]?.order ?? 99) - (CATEGORY_LABELS[b]?.order ?? 99)
            ).forEach(cat => {
                const optgroup = document.createElement("optgroup");
                optgroup.label = CATEGORY_LABELS[cat].label;
                groups[cat].forEach(s => {
                    const opt = document.createElement("option");
                    opt.value = s.id;
                    const imgBadge = s.needs_image ? "📷 " : "";
                    const pin = s.source === "presets" ? " 📌" : "";
                    opt.textContent = `${imgBadge}${s.name || s.id}${pin}`;
                    optgroup.appendChild(opt);
                });
                tplSelector.appendChild(optgroup);
            });
        }

        if (currentVal && [...tplSelector.options].some(o => o.value === currentVal)) {
            tplSelector.value = currentVal;
        } else if (bestMatchId && [...tplSelector.options].some(o => o.value === bestMatchId)) {
            // 工作流上下文匹配到 skill，自动选中
            tplSelector.value = bestMatchId;
        }

        // Programmatic value assignment does not fire change events;
        // dispatch one so node listeners sync the template_id hidden input used by queue runs.
        tplSelector.dispatchEvent(new Event("change"));
    }
    
    const settingsBtn = mkEl("button", "rs-settings-btn");
    settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/></svg>';
    settingsBtn.setAttribute("data-rs-tooltip", "Manage skills / templates");
    
    statusBar.appendChild(toggleWrapper);

    const randomBtn = mkEl("button", "rs-random-btn");
    randomBtn.textContent = "🎲";
    randomBtn.setAttribute("data-rs-tooltip", "Random prompt");

    // 🎲 主点击=立即随机填入；▾ 展开运行时随机的运行期配置菜单
    // （勾选状态由 NodeBehaviors.wireRuntimeRandom 接线持久化到 properties 与隐藏控件）
    const randomWrap = mkEl("div", "rs-random-wrap");
    const randomCaret = mkEl("button", "rs-random-caret");
    randomCaret.type = "button";
    randomCaret.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    randomCaret.setAttribute("data-rs-tooltip", "Runtime random options");
    const runtimeMenu = mkEl("div", "rs-runtime-menu");
    // 挂到 body 用 fixed 定位：留在节点 DOM widget 内会被节点边界裁剪（同 combo-box 列表与预设列表浮层策略）
    document.body.appendChild(runtimeMenu);
    const runtimeToggleRow = mkEl("label", "rs-runtime-row rs-runtime-toggle");
    const runtimeCheckbox = mkEl("input", "rs-auto-generate-checkbox");
    runtimeCheckbox.type = "checkbox";
    const runtimeToggleText = mkEl("span", "rs-runtime-row-text");
    runtimeToggleText.textContent = "运行时随机抽取提示词";
    runtimeToggleRow.appendChild(runtimeCheckbox);
    runtimeToggleRow.appendChild(runtimeToggleText);
    const runtimeCountRow = mkEl("div", "rs-runtime-row");
    const runtimeCountText = mkEl("span", "rs-runtime-row-text");
    runtimeCountText.textContent = "每次抽取";
    const runtimeCountMinus = mkEl("button", "rs-runtime-count-btn");
    runtimeCountMinus.type = "button";
    runtimeCountMinus.textContent = "−";
    const runtimeCountVal = mkEl("span", "rs-runtime-count-val");
    runtimeCountVal.textContent = "1";
    const runtimeCountPlus = mkEl("button", "rs-runtime-count-btn");
    runtimeCountPlus.type = "button";
    runtimeCountPlus.textContent = "+";
    runtimeCountRow.appendChild(runtimeCountText);
    runtimeCountRow.appendChild(runtimeCountMinus);
    runtimeCountRow.appendChild(runtimeCountVal);
    runtimeCountRow.appendChild(runtimeCountPlus);
    runtimeMenu.appendChild(runtimeToggleRow);
    runtimeMenu.appendChild(runtimeCountRow);
    randomWrap.appendChild(randomBtn);
    randomWrap.appendChild(randomCaret);
    let runtimeMenuOpen = false;
    const closeRuntimeMenu = () => {
        runtimeMenuOpen = false;
        runtimeMenu.style.display = "none";
    };
    const openRuntimeMenu = () => {
        runtimeMenu.style.display = "block";
        const r = randomCaret.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = runtimeMenu.offsetWidth || 220, h = runtimeMenu.offsetHeight || 110;
        let left = Math.min(Math.max(8, r.right - w), vw - 8 - w);
        let top = r.bottom + 4;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
        runtimeMenu.style.left = left + "px";
        runtimeMenu.style.top = top + "px";
        runtimeMenuOpen = true;
    };
    randomCaret.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        runtimeMenuOpen ? closeRuntimeMenu() : openRuntimeMenu();
    });
    // 捕获阶段监听外部按下：画布等区域的指针事件会被上游全局处理器 stopPropagation，
    // 冒泡阶段根本到不了 document；捕获阶段在最前面执行不受影响。
    // （同一处理挂 pointerdown 与 mousedown 双保险，第二次触发时已关闭会直接返回）
    const onDocPointerDown = (e) => {
        if (!runtimeMenuOpen) return;
        if (randomWrap.contains(e.target) || runtimeMenu.contains(e.target)) return;
        closeRuntimeMenu();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && runtimeMenuOpen) closeRuntimeMenu();
    });
    randomBtn._rsRuntime = { checkbox: runtimeCheckbox, countRow: runtimeCountRow, minusBtn: runtimeCountMinus, plusBtn: runtimeCountPlus, valueSpan: runtimeCountVal, wrap: randomWrap, destroy: () => runtimeMenu.remove() };

    const listBtn = mkEl("button", "rs-list-btn");
    listBtn.textContent = "☰";
    listBtn.setAttribute("data-rs-tooltip", "Preset list");

    const quickInputWrapper = mkEl("div", "rs-quick-input-wrapper");

    // Note: randomBtn, listBtn are NOT added to quickInputWrapper here.
    // They will be placed in topRightBtnGroup by createPromptManagerUI().

    const quickInput = document.createElement("textarea");
    quickInput.className = "rs-quick-input";
    quickInput.placeholder = 'Describe what you want... (Enter to generate, Shift+Enter for newline)';
    quickInput.rows = 2;

    let tipInterval = null;

    function startTipRotation() {
        stopTipRotation();
        tipInterval = setInterval(() => {
            if (!quickInput.value.trim()) {
                quickInput.placeholder = getRandomTip();
            }
        }, 5000);
    }

    function stopTipRotation() {
        if (tipInterval) {
            clearInterval(tipInterval);
            tipInterval = null;
        }
    }

    quickInput.addEventListener("focus", () => {
        quickInput.placeholder = getRandomTip();
        startTipRotation();
    });

    quickInput.addEventListener("blur", () => {
        stopTipRotation();
        if (!quickInput.value.trim()) {
            quickInput.placeholder = getRandomTip();
        }
    });

    // Create input toolbar (chat-like experience)
    const inputToolbar = mkEl("div", "rs-input-toolbar");

    const generateBtn = mkEl("button", "rs-generate-btn");
    generateBtn.textContent = "✨";
    generateBtn.setAttribute("data-rs-tooltip", "Generate from description");

    // Auto-generate 复选框并入 ✨ 的 ▾ 菜单（参照骰子菜单交互）：
    // ✨ 主点击=立即生成；▾ 展开"运行时自动增强"开关。保留原 checkbox 元素身份，
    // 使 prompts.js 既有接线（恢复/持久化/rs_auto_generate 事件）零改动。
    const autoGenerateCheckbox = document.createElement("input");
    autoGenerateCheckbox.type = "checkbox";
    autoGenerateCheckbox.className = "rs-auto-generate-checkbox";
    autoGenerateCheckbox.id = "rs-auto-generate";
    const autoGenerateLabel = document.createElement("label");
    autoGenerateLabel.htmlFor = "rs-auto-generate";
    autoGenerateLabel.className = "rs-auto-generate-label";
    autoGenerateLabel.textContent = "自动增强";

    const genCaret = mkEl("button", "rs-random-caret");
    genCaret.type = "button";
    genCaret.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    genCaret.setAttribute("data-rs-tooltip", "Auto-enhance options");
    const autoMenu = mkEl("div", "rs-runtime-menu rs-auto-config");
    document.body.appendChild(autoMenu); // 挂 body 防节点边界裁剪
    const autoToggleRow = mkEl("label", "rs-runtime-row rs-runtime-toggle");
    autoToggleRow.appendChild(autoGenerateCheckbox);
    autoToggleRow.appendChild(autoGenerateLabel);
    const autoHint = mkEl("div", "rs-runtime-hint");
    autoHint.textContent = "每次运行时用 LLM 基于描述自动增强提示词";
    autoMenu.appendChild(autoToggleRow);
    autoMenu.appendChild(autoHint);
    // LLM 配置表单（原设置弹窗的 LLM Settings 标签，现整体挂进自动增强菜单）
    const modelForm = createModelConfigForm();
    const autoDivider = mkEl("div", "rs-runtime-divider");
    const autoSectionTitle = mkEl("div", "rs-runtime-section-title");
    autoSectionTitle.textContent = "🤖 LLM Settings";
    autoMenu.appendChild(autoDivider);
    autoMenu.appendChild(autoSectionTitle);
    autoMenu.appendChild(modelForm.el);
    const autoWrap = mkEl("div", "rs-auto-wrap");
    autoWrap.appendChild(generateBtn);
    autoWrap.appendChild(genCaret);

    let autoMenuOpen = false;
    const closeAutoMenu = () => { if (autoMenuOpen) modelForm.save(); autoMenuOpen = false; autoMenu.style.display = "none"; };
    const openAutoMenu = () => {
        autoMenu.style.display = "block";
        const r = genCaret.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = autoMenu.offsetWidth || 220, h = autoMenu.offsetHeight || 110;
        let left = Math.min(Math.max(8, r.right - w), vw - 8 - w);
        let top = r.bottom + 4;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
        autoMenu.style.left = left + "px";
        autoMenu.style.top = top + "px";
        modelForm.load();
        autoMenuOpen = true;
    };
    genCaret.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        autoMenuOpen ? closeAutoMenu() : openAutoMenu();
    });
    // 捕获阶段外关，规避上游全局处理器 stopPropagation（同骰子菜单）
    const onAutoDocPointerDown = (e) => {
        if (!autoMenuOpen) return;
        if (autoWrap.contains(e.target) || autoMenu.contains(e.target)) return;
        if (e.target.closest && e.target.closest(".rs-combo-list")) return; // 模型下拉浮层挂在 body，点它不关菜单
        closeAutoMenu();
    };
    document.addEventListener("pointerdown", onAutoDocPointerDown, true);
    document.addEventListener("mousedown", onAutoDocPointerDown, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && autoMenuOpen) closeAutoMenu();
    });

    // 勾选自动增强 ⇄ 主按钮高亮：不做图标替换，仅切 class，由 CSS 画圆形边框/光晕（见 .rs-auto-enhance-active）
    const syncGenerateIcon = () => {
        generateBtn.classList.toggle("rs-auto-enhance-active", autoGenerateCheckbox.checked);
    };
    autoGenerateCheckbox.addEventListener("change", (e) => {
        e.stopPropagation(); // 防冒泡进全局关浮层/事件处理器
        syncGenerateIcon();
    });
    // 整行点击切换：外层与内层都是 <label>（label 不能嵌套，内层 htmlFor 激活不可靠），
    // 故直接监听行点击手动反转勾选；点到复选框本身时交给原生机
    autoToggleRow.addEventListener("click", (e) => {
        if (e.target === autoGenerateCheckbox) return;
        e.preventDefault();
        autoGenerateCheckbox.checked = !autoGenerateCheckbox.checked;
        autoGenerateCheckbox.dispatchEvent(new Event("change"));
    });

    // Add elements to toolbar
    inputToolbar.appendChild(attachBtn);
    inputToolbar.appendChild(tplCombo.box);
    inputToolbar.appendChild(settingsBtn);
    const spacer = mkEl("div", "rs-spacer");
    inputToolbar.appendChild(spacer);
    inputToolbar.appendChild(autoWrap);

    // Add input and toolbar to wrapper
    quickInputWrapper.appendChild(imageChipsRow);
    quickInputWrapper.appendChild(quickInput);
    quickInputWrapper.appendChild(inputToolbar);
    quickInputWrapper.appendChild(fileInput);

    // 粘贴图片直接附加（反推）
    quickInput.addEventListener("paste", (e) => {
        const files = imagesFromClipboard(e);
        if (files.length) {
            e.preventDefault();
            files.forEach(addImageFile);
        }
    });

    // 拖拽图片到输入框附加
    quickInputWrapper.addEventListener("dragover", (e) => e.preventDefault());
    quickInputWrapper.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        files.forEach(addImageFile);
    });

    // 输入 @ 唤起工作流图片选择器（支持在文本中间插入：看光标前一个字符）
    quickInput.addEventListener("input", () => {
        const caret = quickInput.selectionStart;
        if (caret > 0 && quickInput.value[caret - 1] === "@") openAtImagePicker();
    });

    const customTextarea = document.createElement("textarea");
    customTextarea.className = "comfy-multiline-input";
    customTextarea.placeholder = "Enter your prompt here...";

    const buttonsWrapper = mkEl("div", "rs-buttons-wrapper");
    
    const actionRow = mkEl("div", "rs-btn-row rs-action-row");

    const saveBtn = mkEl("button", "rs-btn rs-action-btn");
    saveBtn.textContent = "💾";
    saveBtn.setAttribute("data-rs-tooltip", "Save as preset");

    // Note: saveBtn is NOT added to actionRow here.
    // It will be placed in topRightBtnGroup by createPromptManagerUI().
    buttonsWrapper.appendChild(actionRow);

    return { statusBar, quickInputWrapper, randomBtn, randomWrap, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, settingsBtn, toggleSwitch, localTab, externalTab, tplSelector, populateTemplateSelector, actionRow, autoGenerateCheckbox, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker };
}

// ==========================================
// Main UI factory
// ==========================================

function createPromptManagerUI() {
    const { statusBar, quickInputWrapper, randomBtn, randomWrap, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, settingsBtn, toggleSwitch, localTab, externalTab, tplSelector, populateTemplateSelector, actionRow, autoGenerateCheckbox, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker } = createStatusBars();
    const { overlay: presetListOverlay, body: presetListBody, searchBar: presetSearchBar } = createOverlayWithSearch();
    const { modal: presetNameInput, aiStatus, label, field: inputField, tagsLabel, tagsContainer, selectedTags, okBtn: inputOk, recipeOkBtn: inputRecipeOk, cancelBtn: inputCancel, recipeHint, saveResultsRow: recipeResultsRow, saveResultsCheck: recipeResultsCheck } = createInputModal();
    const { modal: deleteConfirmOverlay, textDiv: deleteText, okBtn: deleteOk, cancelBtn: deleteCancel } = createDeleteModal();
    const skillModal = createSkillManagerModal();

    const root = mkEl("div", "rs-root");

    root.appendChild(statusBar);
    // Preset list overlay - positioned as a centered panel (not dropdown).
    // 挂到 body 而非节点 DOM 层：留在节点层内时，聚焦搜索框引发节点选中后
    // 选中态工具栏会压在浮层之上。同时拦截浮层内部指针/按键事件向外冒泡，
    // 避免点击或聚焦输入框时触发画布选节点等副作用。
    document.body.appendChild(presetListOverlay);
    ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "touchstart", "keydown"].forEach((t) => {
        presetListOverlay.addEventListener(t, (e) => e.stopPropagation());
    });
    // 弹出位置贴着节点上的 list 按钮（不再屏幕居中）：与按钮右缘对齐、默认弹到下方，
    // 下方放不下且上方空间更大时上翻，水平夹在视口内。调用前需已将 display 设为 flex 以便测量。
    const placePresetOverlay = () => {
        const r = listBtn.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = presetListOverlay.offsetWidth || 400;
        const h = presetListOverlay.offsetHeight || 300;
        let left = r.right - w;
        if (left < 8) left = 8;
        if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
        const spaceBelow = vh - 8 - (r.bottom + 6);
        const spaceAbove = r.top - 14;
        let top = r.bottom + 6;
        if (h > spaceBelow && spaceAbove > spaceBelow) {
            top = Math.max(8, r.top - h - 6);
        }
        if (top + h > vh - 8) top = Math.max(8, vh - 8 - h);
        presetListOverlay.style.left = left + "px";
        presetListOverlay.style.top = top + "px";
        presetListOverlay.style.transform = "none";
    };
    // 列表内容异步加载、集合翻页、聚合搜索结果都会让浮层变高，跟踪尺寸变化随时重定位，
    // 否则刚打开时按空列表测量的位置会在内容渲染后底部越出视口。
    new ResizeObserver(() => {
        if (presetListOverlay.style.display === "flex") placePresetOverlay();
    }).observe(presetListOverlay);

    // 配方行悬停浮出预览图：单一共享节点，避免每个 row 都创建/销毁 <img>
    let presetPreviewPop = null;
    const recipeAssetUrl = (recipe, file) =>
        `${window.location.protocol}//${window.location.host}/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}`;
    function showPresetPreview(anchor, recipe, coverFile) {
        if (!coverFile) return;
        if (!presetPreviewPop) {
            presetPreviewPop = document.createElement("div");
            presetPreviewPop.className = "rs-preset-preview-pop";
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            presetPreviewPop.appendChild(img);
            document.body.appendChild(presetPreviewPop);
        }
        const img = presetPreviewPop.querySelector("img");
        const key = `${recipe}::${coverFile}`;
        if (img.dataset.src !== key) {
            img.dataset.src = key;
            img.src = recipeAssetUrl(recipe, coverFile);
        }
        const rect = anchor.getBoundingClientRect();
        const popWidth = 240;
        const margin = 8;
        let left = rect.right + margin;
        if (left + popWidth > window.innerWidth - margin) {
            left = rect.left - popWidth - margin;
        }
        if (left < margin) left = margin;
        let top = rect.top;
        presetPreviewPop.style.left = `${left}px`;
        presetPreviewPop.style.top = `${top}px`;
        presetPreviewPop.classList.add("visible");
    }
    function hidePresetPreview() {
        if (presetPreviewPop) presetPreviewPop.classList.remove("visible");
    }

    // 预设列表键盘导航：↑↓/Home/End/PageUp/PageDown 切换活动行，Enter 激活，
    // Delete 触发自定义行的删除确认，Esc 关闭浮层，← 在集合视图里走「返回」行。
    // 活动行复用 .rs-preset-active 类，避免与 :hover 视觉冲突。
    let presetActiveIndex = -1;
    const getVisiblePresetItems = () => {
        const all = presetListBody.querySelectorAll(".rs-preset-item");
        return Array.from(all).filter(el => el.offsetParent !== null || getComputedStyle(el).display !== "none");
    };
    const setActivePresetItem = (index) => {
        const items = getVisiblePresetItems();
        if (!items.length) {
            presetActiveIndex = -1;
            return;
        }
        let next = index;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        items.forEach((el, i) => el.classList.toggle("rs-preset-active", i === next));
        presetActiveIndex = next;
        const target = items[next];
        if (target && typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ block: "nearest" });
        }
    };
    const activatePresetItem = (row) => {
        if (!row) return;
        row.click();
    };
    const findActivePresetIndex = () => {
        const items = getVisiblePresetItems();
        return items.findIndex(el => el.classList.contains("rs-preset-active"));
    };
    const handlePresetListKeydown = (e) => {
        if (presetListOverlay.style.display !== "flex") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target;
        // 浮层内的输入控件（搜索框）允许普通字符编辑；
        // 只在方向键/Home/End/PageUp/PageDown/Enter/Esc/← 时才切换列表焦点
        const inSearch = target === presetSearchBar;
        if (inSearch && e.key !== "ArrowDown" && e.key !== "ArrowUp"
            && e.key !== "Enter" && e.key !== "Escape"
            && e.key !== "Home" && e.key !== "End"
            && e.key !== "PageUp" && e.key !== "PageDown"
            && e.key !== "ArrowLeft") return;

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            presetListOverlay.style.display = "none";
            isListOpen = false;
            clearCollectionViewState();
            hidePresetPreview();
            presetActiveIndex = -1;
            return;
        }

        const items = getVisiblePresetItems();
        if (!items.length) return;

        let current = findActivePresetIndex();
        if (current < 0 && (e.key === "ArrowDown" || e.key === "Enter")) {
            current = 0;
            setActivePresetItem(0);
        }
        if (current < 0) return;

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setActivePresetItem(current + 1);
                break;
            case "ArrowUp":
                e.preventDefault();
                setActivePresetItem(current - 1);
                break;
            case "Home":
                e.preventDefault();
                setActivePresetItem(0);
                break;
            case "End":
                e.preventDefault();
                setActivePresetItem(items.length - 1);
                break;
            case "PageDown":
                e.preventDefault();
                setActivePresetItem(current + 10);
                break;
            case "PageUp":
                e.preventDefault();
                setActivePresetItem(current - 10);
                break;
            case "Enter":
                e.preventDefault();
                activatePresetItem(items[current]);
                break;
            case "ArrowLeft":
                if (collectionView) {
                    const back = presetListBody.querySelector(".rs-collection-back");
                    if (back) {
                        e.preventDefault();
                        activatePresetItem(back);
                    }
                }
                break;
            case "Delete":
            case "Backspace": {
                // 仅在「非 Backspace」或「自定义行」时触发，避免与文本编辑混淆
                const row = items[current];
                const isCustom = row && row.classList.contains("rs-preset-item")
                    && !row.classList.contains("rs-collection-back")
                    && !row.classList.contains("rs-load-more-item")
                    && row.querySelector(".rs-delete-icon") !== null;
                if (e.key === "Backspace" && !isCustom) break;
                if (isCustom) {
                    e.preventDefault();
                    const delBtn = row.querySelector(".rs-delete-icon");
                    if (delBtn) delBtn.click();
                }
                break;
            }
        }
    };
    presetListOverlay.addEventListener("keydown", handlePresetListKeydown);

    // 鼠标悬停时同步键盘活动行：用户用鼠标选中后，↑↓ 接着当前行走
    presetListBody.addEventListener("mousemove", (e) => {
        const row = e.target.closest(".rs-preset-item");
        if (!row) return;
        const items = getVisiblePresetItems();
        const idx = items.indexOf(row);
        if (idx >= 0 && idx !== presetActiveIndex) {
            items.forEach((el, i) => el.classList.toggle("rs-preset-active", i === idx));
            presetActiveIndex = idx;
        }
    });
    presetListBody.addEventListener("mouseleave", () => {
        // 鼠标移出列表不主动清空活动行，方便用户接着用键盘
    });

    // Create wrapper for custom textarea and buttons
    const customTextareaWrapper = mkEl("div", "rs-custom-textarea-wrapper");
    customTextareaWrapper.appendChild(customTextarea);

    // Markdown 预览层：覆盖在 textarea 区域，点 👁 切换显示（复用 skill.js 的 renderMarkdown）
    const mdPreview = mkEl("div", "rs-md-preview rs-prompt-md-preview");
    mdPreview.style.display = "none";
    customTextareaWrapper.appendChild(mdPreview);
    
    // Create button group wrapper
    const buttonGroup = mkEl("div", "rs-button-group");
    buttonGroup.appendChild(saveBtn);
    buttonGroup.appendChild(randomWrap);
    buttonGroup.appendChild(listBtn);

    // Markdown 预览切换按钮（👁）：默认随按钮组折叠，hover 展开，激活时常亮高亮
    const mdPreviewBtn = mkEl("button", "rs-action-btn rs-md-preview-btn");
    mdPreviewBtn.textContent = "👁";
    mdPreviewBtn.setAttribute("data-rs-tooltip", "Markdown 预览 / 编辑");
    buttonGroup.appendChild(mdPreviewBtn);

    customTextareaWrapper.appendChild(buttonGroup);

    // 切换 Markdown 预览 / 原始编辑；refreshMarkdownPreview 供流式更新时同步刷新
    let mdPreviewOn = false;
    // 渲染预览并把 GFM 任务列表复选框设为可交互（marked 默认输出 disabled，这里放开）
    function paintMdPreview() {
        mdPreview.innerHTML = renderMarkdown(customTextarea.value || "");
        for (const box of mdPreview.querySelectorAll('input[type="checkbox"]')) {
            box.disabled = false;
            box.style.cursor = "pointer";
        }
    }
    // 切换源码中第 boxIndex 个任务项的勾选（[ ]/[x]），未命中则原样返回
    function setTaskItemChecked(text, boxIndex, checked) {
        const lines = text.split("\n");
        let seen = -1;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/);
            if (!m) continue;
            seen++;
            if (seen === boxIndex) {
                lines[i] = m[1] + (checked ? "x" : " ") + m[3] + lines[i].slice(m[0].length);
                return lines.join("\n");
            }
        }
        return text;
    }
    function setMdPreview(on) {
        mdPreviewOn = on;
        if (on) {
            paintMdPreview();
            customTextarea.style.display = "none";
            mdPreview.style.display = "block";
            mdPreviewBtn.classList.add("rs-md-preview-active");
        } else {
            mdPreview.style.display = "none";
            customTextarea.style.display = "";
            mdPreviewBtn.classList.remove("rs-md-preview-active");
        }
    }
    function refreshMarkdownPreview() {
        if (mdPreviewOn) paintMdPreview();
    }
    // 生成/流式结束后调用：内容识别为 Markdown 则自动切到预览，否则同步刷新已开启的预览
    function refreshMarkdownPreviewAuto() {
        if (looksLikeMarkdown(customTextarea.value || "")) setMdPreview(true);
        else refreshMarkdownPreview();
    }
    mdPreviewBtn.addEventListener("click", () => setMdPreview(!mdPreviewOn));
    // 预览中的任务列表复选框可点击：回写 [ ]/[x] 到 textarea（经 input 事件同步 widget/storage），
    // 便于多轮技能把用户选择带入下一次生成；不重渲染，避免长列表滚动位置跳动
    mdPreview.addEventListener("click", (e) => {
        const box = e.target && e.target.closest ? e.target.closest('input[type="checkbox"]') : null;
        if (!box || !mdPreview.contains(box)) return;
        const boxes = Array.from(mdPreview.querySelectorAll('input[type="checkbox"]'));
        const next = setTaskItemChecked(customTextarea.value || "", boxes.indexOf(box), box.checked);
        if (next !== customTextarea.value) {
            customTextarea.value = next;
            triggerTextChange();
        }
    });

    // 轻量 Markdown 识别：仅当出现标题 / 代码块 / 列表 / 加粗等强信号才判定为 Markdown，避免普通提示词误判
    function looksLikeMarkdown(text) {
        if (!text) return false;
        let heading = 0, list = 0;
        for (const line of text.split("\n")) {
            if (/^#{1,6}\s/.test(line)) heading++;
            else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) list++;
        }
        return /```/.test(text) || heading >= 1 || list >= 2 || /\*\*[^*\n]+\*\*/.test(text);
    }

    // 多轮交互提示：每次生成只推进一个阶段，需补充返回的问询后再次运行
    const skillHint = mkEl("div", "rs-skill-hint");
    skillHint.textContent = "多轮交互技能：每次生成仅推进一个阶段，请补充返回的问询后再次点击 ✨ 继续。";
    
    root.appendChild(customTextareaWrapper);

    root.appendChild(skillHint);
    root.appendChild(buttonsWrapper);
    // quickInputWrapper at the bottom of the node
    root.appendChild(quickInputWrapper);

    // 挂 body 防节点边界裁剪（fixed 定位居中于视口）
    document.body.appendChild(presetNameInput);
    document.body.appendChild(deleteConfirmOverlay);

    presetListBody.style.scrollbarWidth = "thin";
    presetListBody.style.scrollbarColor = "#5090cc #1a1a1a";

    let pendingDeleteName = null;
    let pendingDeleteIsRecipe = false;
    let context = null;
    let isLoading = false;
    let isListOpen = false;


        function triggerTextChange() {
            if (customTextarea) {
                customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }

    function init(ctx) {
        context = ctx;
        const { node, graph, textWidget, allowRecipe } = ctx;

        // 流式生成时：内容识别为 Markdown 则自动切换为预览，否则保持同步刷新
        api.addEventListener("rs.prompt.auto_generate_update", (event) => {
            const uid = node.properties?.rs_instance_uid;
            if (uid && event.detail.instance_uid !== uid) return;
            refreshMarkdownPreviewAuto();
        });

        // 不再在这里触发，由 prompts.js 统一管理时序

        function handleSaveClick() {
            presetListOverlay.style.display = "none";
            deleteConfirmOverlay.style.display = "none";
            presetNameInput.style.display = "block";
            inputField.value = "";
            setTimeout(() => inputField.focus(), 50);

            inputRecipeOk.style.display = allowRecipe ? "" : "none";
            recipeResultsRow.style.display = allowRecipe ? "" : "none";

            selectedTags.clear();
            const tagButtons = tagsContainer.querySelectorAll(".rs-tag-btn");
            tagButtons.forEach(btn => {
                btn.classList.remove("rs-tag-selected");
            });

            const currentText = textWidget?.value || "";

            recipeHint.style.display = allowRecipe ? "block" : "none";
            if (allowRecipe) {
                recipeHint.textContent = "⏳ 正在收集工作流资源...";
                collectWorkflowAssets(node).then(assets => {
                    const p = (customTextarea?.value || currentText).trim();
                    recipeHint.textContent = `配方将包含 ${assets.length} 个资源（当前子图中已连线的 LoadImage/LoadVideo/LoadAudio）${p ? " + 当前提示词" : ""}。`;
                }).catch(e => {
                    console.error("[Neo Recipes] Collect failed:", e);
                    recipeHint.textContent = "⚠️ 工作流资源收集失败";
                });
            }

            if (currentText.trim()) {
                saveBtn.disabled = true;
                aiStatus.className = "rs-ai-status processing";
                aiStatus.innerHTML = "⏳ AI 正在分析提示词...";

                Promise.all([
                    extractTitle(currentText),
                    extractClassify(currentText)
                ]).then(([dataTitle, dataClassify]) => {
                    if (dataTitle.status === "success") {
                        inputField.value = dataTitle.title;
                    }

                    if (dataClassify.status === "success" && dataClassify.classify) {
                        const classifyText = dataClassify.classify.trim();
                        const classifyList = classifyText.split(/[,，]/).map(s => s.trim()).filter(s => s);

                        tagButtons.forEach(btn => {
                            const btnText = btn.textContent.trim();
                            if (classifyList.includes(btnText)) {
                                selectedTags.add(btnText);
                                btn.classList.add("rs-tag-selected");
                            }
                        });
                        aiStatus.className = "rs-ai-status success";
                        aiStatus.innerHTML = "✅ AI 分析完成";
                    } else {
                        aiStatus.className = "rs-ai-status error";
                        aiStatus.innerHTML = "❌ AI 分析失败，请手动填写";
                    }
                }).catch(e => {
                    console.error("Auto-extract error:", e);
                }).finally(() => {
                    saveBtn.disabled = false;
                });
            }
        }

        function performSave() {
            const name = inputField.value.trim();
            if (!name) return;
            presetNameInput.style.display = "none";
            const tags = Array.from(selectedTags);
            savePrompt(name, textWidget ? textWidget.value : "", tags);
        }

        function performRecipeSave() {
            const name = inputField.value.trim();
            if (!name) return;
            presetNameInput.style.display = "none";
            saveRecipeFromModal(name);
        }

        async function saveRecipeFromModal(name) {
            try {
                const assets = await collectWorkflowAssets(node);
                const results = recipeResultsCheck.checked ? collectWorkflowResults() : [];
                const loras = await collectWorkflowLoras(node);
                const promptText = customTextarea?.value || textWidget?.value || "";
                const result = await saveRecipe(name, promptText, assets, results, loras);
                if (result.success) {
                    const extra = result.sample_added ? ` + ${result.sample_added} 结果` : "";
                    app.extensionManager.toast.add({ severity: "success", summary: "配方已保存", detail: `${name}（${result.asset_count} 资源${extra}）`, life: 4000 });
                } else {
                    app.extensionManager.toast.add({ severity: "error", summary: "保存失败", detail: result.error || "Unknown error", life: 5000 });
                }
            } catch (e) {
                console.error("[Neo Recipes] Save failed:", e);
                app.extensionManager.toast.add({ severity: "error", summary: "保存失败", detail: e.message, life: 5000 });
            }
        }

        async function loadPresetDropdown() {
            if (isLoading) return;
            isLoading = true;
            presetActiveIndex = -1;

            presetListBody.innerHTML = "";

            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);

            try {
                const [list, recipes] = await Promise.all([listPrompts(), listRecipes()]);

                if (loadingDiv.parentNode) loadingDiv.remove();

                // 配方并入预设列表统一展示（立方体图标区分）；source 归一化为 presets/custom
                const recipeItems = (Array.isArray(recipes) ? recipes : []).map(r => ({
                    name: r.name,
                    tags: [],
                    source: r.source === "preset" ? "presets" : "custom",
                    _mtime: r.mtime || 0,
                    isRecipe: true,
                    prompt: r.prompt || "",
                    assetCount: r.asset_count || 0,
                    cover: r.cover || null,
                    assets: Array.isArray(r.assets) ? r.assets : [],
                }));
                const merged = [...list, ...recipeItems];

                if (!merged.length) {
                    presetListBody.textContent = "No presets found";
                    isLoading = false;
                    return;
                }

                // 集合（collections/）条目置顶展示，避免混在普通预设里被淹没；
                // 其余条目（提示词+配方）按来源分组、组内 mtime 降序统一排序
                const isCollection = item => isCollectionName(typeof item === 'string' ? item : item.name);
                const byMtime = (a, b) => (b._mtime || 0) - (a._mtime || 0);
                const ordered = [
                    ...merged.filter(isCollection),
                    ...merged.filter(item => !isCollection(item) && item.source !== "presets").sort(byMtime),
                    ...merged.filter(item => !isCollection(item) && item.source === "presets").sort(byMtime),
                ];

                // 配方行悬停浮出预览图：showPresetPreview / hidePresetPreview 由外层 createPromptManagerUI 提供。
                ordered.forEach(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    const source = typeof item === 'object' ? item.source : "custom";
                    const shown = isCollectionName(name) ? `\ud83d\udcda ${name}` : name;

                    const row = document.createElement("div");
                    row.className = "rs-preset-item";
                    row.dataset.name = name;

                    const leftDiv = mkEl("div", "rs-preset-left");
                    const contentSpan = mkEl("span", "rs-preset-content");
                    const displayText = shown;

                    if (tags && tags.length > 0) {
                        contentSpan.textContent = shown;
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    } else {
                        contentSpan.textContent = shown;
                    }

                    if (item.isRecipe) {
                        const icon = mkEl("span", "rs-recipe-icon");
                        icon.innerHTML = RECIPE_ICON_SVG;
                        contentSpan.prepend(icon);
                        contentSpan.title = `${name}（${source === "presets" ? "内置" : "自定义"}配方${item.assetCount ? ` · ${item.assetCount} 个资源` : ''}）`;

                        // 悬停浮出预览图：与侧边栏配方卡片用同一封面解析（_preview/_cover/首图）
                        const coverFile = item.cover || (Array.isArray(item.assets)
                            ? (item.assets.find(a => a && a.kind === "image") || {}).file
                            : null);
                        if (coverFile) {
                            row.addEventListener("mouseenter", () => showPresetPreview(row, item.name, coverFile));
                            row.addEventListener("mouseleave", hidePresetPreview);
                        }
                    }

                    const sourceBadge = mkEl("span", "rs-source-badge");
                    sourceBadge.textContent = source === "presets" ? "SYS" : "USR";
                    sourceBadge.title = source === "presets" ? "System preset (cannot delete)" : "User preset";
                    contentSpan.appendChild(sourceBadge);

                    contentSpan.dataset.original = displayText;
                    row.dataset.original = displayText;
                    leftDiv.appendChild(contentSpan);
                    row.appendChild(leftDiv);

                    row.onclick = async (e) => {
                        if (e.target.closest(".rs-delete-icon")) return;
                        hidePresetPreview();
                        presetActiveIndex = -1;

                        if (isCollectionName(name)) {
                            openCollection(name, source);
                            return;
                        }

                        if (item.isRecipe) {
                            fillFromEntry({ text: item.prompt || "" });
                            // 与侧边栏一键发送一致：同时按参数位还原资源；提示词已由 fillFromEntry 写入当前节点，
                            // 资产只还原到当前节点所在子图，与其他子图无关
                            applyRecipeToWorkflow({ name: item.name }, { fillPrompt: false, anchorNode: node });
                            return;
                        }

                        const data = await loadPrompt(name);

                        if (textWidget) {
                            textWidget.value = data.text || "";
                        }
                        if (customTextarea) {
                            customTextarea.value = data.text || "";
                            triggerTextChange();
                        }

                        const currentUid = node.properties.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                        // In-memory cache only - no localStorage

                        presetListOverlay.style.display = "none";
                        if (graph) graph.setDirtyCanvas(true, true);
                    };

                    if (source === "custom") {
                        const deleteBtn = mkEl("span", "rs-delete-icon");
                        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                        deleteBtn.setAttribute("aria-label", "Delete preset");
                        deleteBtn.onclick = async (e) => {
                            e.stopPropagation();
                            pendingDeleteName = name;
                            pendingDeleteIsRecipe = !!item.isRecipe;
                            deleteText.textContent = item.isRecipe ? `Delete recipe "${name}"?` : `Delete "${name}"?`;
                            deleteConfirmOverlay.style.display = "block";
                        };
                        row.appendChild(deleteBtn);
                    }

                    presetListBody.appendChild(row);
                });
            } catch (e) {
                presetListBody.textContent = "Error loading";
            } finally {
                isLoading = false;
                clearCollectionViewState();
            }
        }

        // 多行集合（collections/ 目录约定）浏览：分页加载，避免一次渲染上万条目
        const COLLECTION_PAGE_LIMIT = 200;
        let collectionView = null; // { name, source, total, shown, query }；null 表示文件级列表
        let collectionSearchTimer = null;
        let collectionSearchSeq = 0; // 聚合搜索过期结果丢弃用

        function isCollectionName(name) {
            return typeof name === "string" && name.startsWith("collections/");
        }

        function clearCollectionViewState() {
            collectionView = null;
            clearTimeout(collectionSearchTimer);
            collectionSearchSeq++;
            const matches = presetListBody.querySelector(".rs-collection-matches");
            if (matches) matches.remove();
        }

        function buildCollectionBackRow() {
            const row = mkEl("div", "rs-preset-item rs-collection-back");
            row.textContent = "← 返回预设列表";
            row.onclick = () => {
                clearCollectionViewState();
                presetSearchBar.value = "";
                loadPresetDropdown();
            };
            return row;
        }

        function applyCollectionRows(entries) {
            const frag = document.createDocumentFragment();
            entries.forEach(({ title, text }) => {
                const row = mkEl("div", "rs-preset-item");
                const leftDiv = mkEl("div", "rs-preset-left");
                const contentSpan = mkEl("span", "rs-preset-content");
                contentSpan.textContent = title;
                contentSpan.title = title;
                leftDiv.appendChild(contentSpan);
                row.appendChild(leftDiv);
                row.onclick = async (e) => {
                    if (e.target.closest(".rs-delete-icon")) return;

                    fillFromEntry({ text });
                };
                frag.appendChild(row);
            });
            presetListBody.appendChild(frag);
        }

        function fillFromEntry(entry) {
            if (textWidget) {
                textWidget.value = entry.text || "";
            }
            if (customTextarea) {
                customTextarea.value = entry.text || "";
                triggerTextChange();
            }

            presetListOverlay.style.display = "none";
            isListOpen = false;
            clearCollectionViewState();
            if (graph) graph.setDirtyCanvas(true, true);
        }

        function renderCollectionMatches(total, entries) {
            presetListBody.querySelector(".rs-collection-matches")?.remove();
            if (!entries.length) return;

            const box = mkEl("div", "rs-collection-matches");
            const head = mkEl("div", "rs-loading");
            head.textContent = `📚 集合内匹配 ${entries.length} / ${total} 条`;
            box.appendChild(head);

            entries.forEach(({ title, text, name, source }) => {
                const row = mkEl("div", "rs-preset-item");
                const leftDiv = mkEl("div", "rs-preset-left");
                const contentSpan = mkEl("span", "rs-preset-content");
                contentSpan.textContent = title;
                contentSpan.title = `${name}（${source}）`;
                leftDiv.appendChild(contentSpan);

                const originBadge = mkEl("span", "rs-tags-part");
                originBadge.textContent = ` @${String(name || "").replace("collections/", "")}`;
                contentSpan.appendChild(originBadge);

                row.appendChild(leftDiv);
                row.onclick = async (e) => {
                    if (e.target.closest(".rs-delete-icon")) return;
                    fillFromEntry({ text });
                };
                box.appendChild(row);
            });

            presetListBody.appendChild(box);
        }

        function updateCollectionTail() {
            const old = presetListBody.querySelector(".rs-load-more-item, .rs-list-end-item, .rs-match-note");
            if (old) old.remove();
            if (!collectionView) return;
            if (collectionView.shown < collectionView.total) {
                const more = mkEl("div", "rs-preset-item rs-load-more-item");
                more.textContent = `加载更多（已显示 ${collectionView.shown} / ${collectionView.total}）`;
                more.onclick = () => appendCollectionPage();
                presetListBody.appendChild(more);
            } else if (collectionView.total) {
                const end = mkEl("div", "rs-loading rs-list-end-item");
                end.textContent = `共 ${collectionView.total} 条`;
                presetListBody.appendChild(end);
            }
        }

        async function appendCollectionPage() {
            if (!collectionView) return;
            const view = collectionView;
            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);
            try {
                const data = await listPromptLines(view.name, view.shown, COLLECTION_PAGE_LIMIT, view.query, view.source);
                if (collectionView !== view) return; // 视图已切换，丢弃过期页
                if (loadingDiv.parentNode) loadingDiv.remove();
                view.total = data.total;
                view.shown += data.titles.length;
                applyCollectionRows(data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "" })));
                updateCollectionTail();
            } catch (e) {
                if (loadingDiv.parentNode) loadingDiv.remove();
                presetListBody.textContent = "Error loading";
            }
        }

        async function openCollection(name, source) {
            presetNameInput.style.display = "none";
            deleteConfirmOverlay.style.display = "none";

            collectionView = { name, source, total: 0, shown: 0, query: "" };
            presetSearchBar.value = "";
            presetListOverlay.style.display = "flex";
            placePresetOverlay();
            presetSearchBar.focus();
            isListOpen = true;

            presetListBody.innerHTML = "";
            presetListBody.appendChild(buildCollectionBackRow());
            await appendCollectionPage();
        }

        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            handleSaveClick();
        }, true);

        // Preset list search bar - 文件级列表本地过滤；集合视图改为服务端标题检索（防抖）
        presetSearchBar.addEventListener("input", () => {
            if (!collectionView) {
                const query = presetSearchBar.value.trim();
                const qLower = query.toLowerCase();
                const items = presetListBody.querySelectorAll(":scope > .rs-preset-item");
                items.forEach(item => {
                    const name = (item.querySelector(".rs-preset-content")?.textContent || "").toLowerCase();
                    item.style.display = !qLower || name.includes(qLower) ? "" : "none";
                });
                clearTimeout(collectionSearchTimer);
                if (!qLower) {
                    const oldMatches = presetListBody.querySelector(".rs-collection-matches");
                    if (oldMatches) oldMatches.remove();
                    return;
                }
                // 文件名过滤的同时，跨全部集合做标题聚合检索
                collectionSearchTimer = setTimeout(async () => {
                    const seq = ++collectionSearchSeq;
                    let data;
                    try {
                        data = await listPromptLines("*", 0, COLLECTION_PAGE_LIMIT, query, "custom");
                    } catch (e) {
                        return;
                    }
                    if (seq !== collectionSearchSeq || collectionView) return; // 输入已更新或已进入集合视图，丢弃过期结果
                    renderCollectionMatches(data.total,
                        data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "", name: data.names[i], source: data.sources[i] })));
                }, 200);
                return;
            }

            clearTimeout(collectionSearchTimer);
            collectionSearchTimer = setTimeout(async () => {
                const view = collectionView;
                if (!view) return;
                const query = presetSearchBar.value.trim();
                view.query = query;
                view.total = 0;
                view.shown = 0;

                presetListBody.innerHTML = "";
                presetListBody.appendChild(buildCollectionBackRow());
                try {
                    const data = await listPromptLines(view.name, 0, COLLECTION_PAGE_LIMIT, query, view.source);
                    if (collectionView !== view) return; // 视图已切换，丢弃过期结果
                    view.total = data.total;
                    view.shown = data.titles.length;
                    applyCollectionRows(data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "" })));
                    updateCollectionTail();
                    if (query && view.shown < view.total) {
                        const note = mkEl("div", "rs-loading rs-match-note");
                        note.textContent = `仅显示前 ${COLLECTION_PAGE_LIMIT} 条匹配，可继续输入缩小范围`;
                        const more = presetListBody.querySelector(".rs-load-more-item");
                        if (more) presetListBody.insertBefore(note, more);
                        else presetListBody.appendChild(note);
                    }
                } catch (e) {
                    presetListBody.textContent = "Error loading";
                }
            }, 200);
        });

        listBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (presetListOverlay.style.display === "flex") {
                presetListOverlay.style.display = "none";
                isListOpen = false;
                hidePresetPreview();
                presetActiveIndex = -1;
            } else {
                clearCollectionViewState();
                loadPresetDropdown();
                presetListOverlay.style.display = "flex";
                placePresetOverlay();
                presetSearchBar.focus();
                isListOpen = true;
            }
        });

        document.addEventListener("mousedown", (e) => {
            if (!buttonGroup.contains(e.target) && !presetListOverlay.contains(e.target)) {
                presetListOverlay.style.display = "none";
                isListOpen = false;
                clearCollectionViewState();
                hidePresetPreview();
                presetActiveIndex = -1;
            }
        });

        inputOk.addEventListener("click", performSave);
        inputRecipeOk.addEventListener("click", performRecipeSave);
        inputCancel.addEventListener("click", () => {
            presetNameInput.style.display = "none";
        });
        inputField.addEventListener("keydown", (e) => {
            if (e.key === "Enter") performSave();
            if (e.key === "Escape") presetNameInput.style.display = "none";
        });

        deleteOk.addEventListener("click", async () => {
            if (pendingDeleteName) {
                if (pendingDeleteIsRecipe) await deleteRecipe(pendingDeleteName);
                else await deletePrompt(pendingDeleteName);
                deleteConfirmOverlay.style.display = "none";
                if (!quickInput.value.trim()) {
                    loadPresetDropdown();
                }
                pendingDeleteName = null;
                pendingDeleteIsRecipe = false;
            }
        });

        deleteCancel.addEventListener("click", () => {
            deleteConfirmOverlay.style.display = "none";
            pendingDeleteName = null;
            pendingDeleteIsRecipe = false;
        });

        // ⚙️ 打开/关闭居中的技能管理弹窗（skill.js 提供：列表 / 编辑器 / 多文件 / 上传）
        settingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (skillModal.overlay.style.display === "flex") {
                skillModal.close();
            } else {
                skillModal.open();
            }
        });

        return {
            statusBar,
            quickInputWrapper,
            generateBtn,
            randomBtn,
            listBtn,
            quickInput,
            customTextarea,
            refreshMarkdownPreviewAuto,
            settingsBtn,
            toggleSwitch,
            localTab,
            externalTab,
            saveBtn,
            presetListOverlay,
            presetNameInput,
            deleteConfirmOverlay,
            tplSelector,
            populateTemplateSelector,
            autoGenerateCheckbox,
            attachedImages,
            addImageFile,
            clearImages,
            attachBtn,
            imageChipsRow,
            openAtImagePicker
        };
    }

    return {
        root,
        init
    };
}

export {
    mkEl,
    createPromptManagerUI
};
