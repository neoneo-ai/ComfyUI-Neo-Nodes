/**
 * llm-chat.js
 * LLM 聊天域：快捷输入框、工具条、skill 下拉、附加图片 chips、提示语轮播，
 * 以及提示词输出区（textarea + Markdown 预览 + 清空 + 多轮技能提示）与 SSE 生成流程。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fileToBase64, imagesFromClipboard, sseStream, invokePromptStream } from "./prompt-service.js";
import { listSkills, populateSkillOptions, createSkillDropdown, renderMarkdown } from "./skill.js";
import { createModelConfigForm } from "./llm-setting.js";
import { mkEl } from "./dom-utils.js";
import { collectWorkflowContext } from "./workflow-context.js";
import { saveTextToStorage, markQuickInputConsumed } from "./node-behavior.js";
import { createAtImagePicker } from "./at-picker.js";

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
    // 组装（原生 select 数据源 + 可搜索下拉 + 底部管理工具栏 + 行内操作）已收敛到 skill.js 的
    // createSkillDropdown()；可见 UI 是返回的 combo.box（select 被移入其中），工具栏须挂载 box。
    const { selectEl: tplSelector, combo: tplCombo } = createSkillDropdown();

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

    // 图片选择按钮（+）
    const attachBtn = mkEl("button", "rs-attach-btn");
    attachBtn.textContent = "+";
    attachBtn.title = "附加图片（反推/多模态 skill）";
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        Array.from(fileInput.files || []).forEach(addImageFile);
        fileInput.value = "";
    });

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
                Promise.resolve(doPopulate()).then(resolve, resolve);
            }, 50));
        });
    }

    async function doPopulate() {
        const skills = await listSkills();
        const currentVal = tplSelector.value;
        tplSelector.innerHTML = "";

        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "默认";
        tplSelector.appendChild(defaultOpt);

        populateSkillOptions(tplSelector, skills);

        if (currentVal && [...tplSelector.options].some(o => o.value === currentVal)) {
            tplSelector.value = currentVal;
        }

        // Programmatic value assignment does not fire change events;
        // dispatch one so node listeners sync the template_id hidden input used by queue runs.
        tplSelector.dispatchEvent(new Event("change"));
    }
    
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
    const onRuntimeMenuKey = (e) => {
        if (e.key === "Escape" && runtimeMenuOpen) closeRuntimeMenu();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onRuntimeMenuKey);
    randomBtn._rsRuntime = {
        checkbox: runtimeCheckbox, countRow: runtimeCountRow, minusBtn: runtimeCountMinus, plusBtn: runtimeCountPlus, valueSpan: runtimeCountVal, wrap: randomWrap,
        destroy: () => {
            document.removeEventListener("pointerdown", onDocPointerDown, true);
            document.removeEventListener("mousedown", onDocPointerDown, true);
            document.removeEventListener("keydown", onRuntimeMenuKey);
            runtimeMenu.remove();
        }
    };

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
    const onAutoMenuKey = (e) => {
        if (e.key === "Escape" && autoMenuOpen) closeAutoMenu();
    };
    document.addEventListener("pointerdown", onAutoDocPointerDown, true);
    document.addEventListener("mousedown", onAutoDocPointerDown, true);
    document.addEventListener("keydown", onAutoMenuKey);
    autoGenerateCheckbox._rsAutoMenu = {
        destroy: () => {
            document.removeEventListener("pointerdown", onAutoDocPointerDown, true);
            document.removeEventListener("mousedown", onAutoDocPointerDown, true);
            document.removeEventListener("keydown", onAutoMenuKey);
            autoMenu.remove();
        }
    };

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

    const openAtImagePicker = createAtImagePicker({ quickInput, attachedImages, imageKey, addImageInput, inputViewUrl });

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

    return { statusBar, quickInputWrapper, randomBtn, randomWrap, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, toggleSwitch, localTab, externalTab, tplSelector, populateTemplateSelector, actionRow, autoGenerateCheckbox, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker };
}

// ==========================================
// LLM 生成：✨ / Enter 触发，三条流式分支共用同一 SSE 处理
// ==========================================
// @ 标记 -> skill id 路由（与后端 _SKILL_MARKERS 保持一致）
const AT_SKILL_MARKERS = {
    "图": "reverse_prompt",
    "图片": "reverse_prompt",
    "反推": "reverse_prompt",
    "image": "reverse_prompt",
    "img": "reverse_prompt",
    "全参考": "minimax_h3_ref",
    "参考": "minimax_h3_ref",
    "minimax": "minimax_h3_ref",
};

// 匹配文本中的 @ 标记，返回 skill id 或空串
// 注意：不能用 \b（JS 中中文字符不属于 \w，中文之间永远不存在词边界）
function matchSkillMarker(text) {
    if (!text) return "";
    const m = text.match(/@(图片|全参考|参考|反推|minimax|image|img|图)/);
    return m ? (AT_SKILL_MARKERS[m[1]] || "") : "";
}

// 去除文本中的 @ 标记（标记只用于路由，不进入提示词）
function stripSkillMarkers(text) {
    return (text || "").replace(/@(图片|全参考|参考|反推|minimax|image|img|图)/g, "").trim();
}

// 追踪节点 image 输入插槽的上游节点（如 LoadImage），取其图片文件名
// 返回 {kind:"input", value:"<filename>"} 或 null
function resolveConnectedImageSource(node) {
    try {
        const slot = node.inputs?.find(i => i.name === "image");
        if (!slot || slot.link == null) return null;
        const links = node.graph?.links;
        const link = typeof links?.get === "function" ? links.get(slot.link) : links?.[slot.link];
        if (!link) return null;
        const srcNode = node.graph.getNodeById(link.origin_id);
        if (!srcNode) return null;
        // 优先读实时 widget 值（换图立即生效）；widgets_values 仅在序列化时刷新，作为回退快照
        const candidates = [
            ...(srcNode.widgets || []).map(w => w?.value),
            ...(srcNode.widgets_values || []),
        ];
        // 图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
        for (const c of candidates) {
            let v = "";
            if (typeof c === "string") v = c.trim();
            else if (Array.isArray(c)) v = String(c[0] ?? "").trim();
            else if (c && typeof c === "object") v = String(c.name ?? c.filename ?? "").trim();
            if (v && /\.(png|jpe?g|webp|bmp|gif)$/i.test(v)) {
                return { kind: "input", value: v };
            }
        }
        console.warn("image input connected but no image filename found on upstream node:", srcNode.type);
    } catch (e) {
        console.warn("resolveConnectedImageSource failed:", e);
    }
    return null;
}

/**
 * 创建生成提示词的处理函数 - 使用选中的模板或 LLM 智能判断
 */
function createGenerateHandler(promptUI) {
    return async () => {
        const { generateBtn, quickInput, customTextarea, textWidget, node, graph, tplSelector, attachedImages = [], refreshMarkdownPreviewAuto } = promptUI;

        const quickText = quickInput.value.trim();
        const currentPrompt = customTextarea?.value?.trim() || "";

        // If quickInput is empty, use customTextarea content as the message
        const messageToLLM = quickText || currentPrompt;

        // @ 标记、附加图片、节点 image 输入连接 -> skill 路由（反推等 vision skill）
        const slotImage = resolveConnectedImageSource(node);
        const imagesPayload = [
            ...(slotImage ? [slotImage] : []),
            ...attachedImages.map(img => img.input
                ? { kind: "input", value: img.input }
                : { kind: "data", data: img.data }),
        ];
        const hasImages = imagesPayload.length > 0;
        const markerSkillId = matchSkillMarker(messageToLLM);

        if (!messageToLLM && !hasImages) {
            alert("Please enter a quick description or attach an image first.");
            return;
        }

        // 工作流上下文（MiniMax H3 参数 + 叶子媒体清单）：探测图片尺寸有超时上限，失败静默降级
        let workflowContext = null;
        try {
            workflowContext = await collectWorkflowContext(graph);
        } catch (e) {
            console.warn("collectWorkflowContext failed:", e);
        }

        // 检查是否选择了 skill（模板/任务统一选择器，值为 skill id）
        const selectedSkillId = tplSelector?.value || "";

        generateBtn.disabled = true;
        generateBtn.textContent = "⏳";

        let rafId = null;
        let accumulated = "";
        // 三条流式分支共用的 SSE 处理：chunk 先攒进 accumulated，rAF 到点才刷 UI，避免逐 token 重排
        const streamHandlers = (errorLabel) => ({
            onChunk: (chunk) => {
                if (!chunk.text) return;
                accumulated += chunk.text;
                if (rafId) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    customTextarea.value = accumulated;
                    customTextarea.scrollTop = customTextarea.scrollHeight;
                    refreshMarkdownPreviewAuto?.();
                });
            },
            // onDone 取消了尚未执行的合并帧，必须先把 accumulated 落进 textarea，
            // 否则 saveTextToStorage 读到旧的空 textarea，会把 widget 里的提示词冲掉
            onDone: () => {
                if (rafId) cancelAnimationFrame(rafId);
                if (accumulated) customTextarea.value = accumulated;
                saveTextToStorage(node, textWidget, customTextarea, true);
                markQuickInputConsumed(node);
            },
            onError: (err) => {
                console.error(errorLabel, err);
                alert("Failed to process prompt: " + err);
            }
        });
        try {
            if (hasImages || markerSkillId) {
                // 图片 / @ 标记 -> skill 路由（反推等 vision skill，流式）
                if (markerSkillId && !hasImages) {
                    alert("该 skill 需要图片：输入 @ 从工作流图片中选择、连接 image 输入或粘贴图片后再生成。");
                    return;
                }

                generateBtn.textContent = "⏳"; // 统一短反馈，而非长串处理文案

                const skillId = markerSkillId || selectedSkillId || "reverse_prompt";

                const payload = {
                    text: stripSkillMarkers(messageToLLM),
                    skillId,
                    images: imagesPayload,
                    description: quickText || currentPrompt,
                    context: workflowContext
                };
                await invokePromptStream(payload, streamHandlers("Skill invoke error:"));
            } else if (selectedSkillId) {
                // 使用选中的模板进行生成（流式）
                generateBtn.textContent = "⏳"; // 统一短反馈

                // If quickInput has content, combine with currentPrompt; otherwise use currentPrompt alone
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;

                // 使用流式API，传入skillId
                await sseStream("/rs_prompts/stream_generate_prompt", streamHandlers("Skill stream error:"), { 
                    text: userPrompt, 
                    skillId: selectedSkillId,
                    description: quickText || currentPrompt,
                    context: workflowContext 
                });
            } else {
                // 使用 LLM 智能判断（流式）：LLM 直接判断用户意图并生成/改写
                generateBtn.textContent = "⏳"; // 统一短反馈
                // 拼接 currentPrompt 和 quickText（与选择了模版时保持一致）
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;
                await sseStream("/rs_prompts/stream_generate_prompt", streamHandlers("Smart prompt stream error:"), {
                    text: userPrompt,
                    description: quickText || currentPrompt,
                    context: workflowContext
                });
            }
        } catch (e) {
            console.error("Network Error:", e);
            alert("Network error during processing: " + e.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "✨";
            if (accumulated) {
                customTextarea.value = accumulated;
                refreshMarkdownPreviewAuto?.();
            }
        }
    };
}

// ==========================================
// Backend streaming sync (auto-generate during execution)
// ==========================================

/**
 * 后端执行期自动生成（prompts.py 两条 auto-generate 路径）按块推送
 * rs.prompt.auto_generate_update：先写回 textarea/widget，再刷新 Markdown 预览，
 * 保证预览与输入框内容同帧（此前两处监听分开注册，预览总落后一个事件）。
 * 返回注销函数，节点移除时调用，避免残留监听持有已销毁节点的 DOM。
 */
function wireBackendStreamUpdate(promptUI) {
    const { customTextarea, textWidget, node, graph, refreshMarkdownPreviewAuto } = promptUI;
    const handler = (event) => {
        const currentUid = node.properties?.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
        if (event.detail.instance_uid !== currentUid) return;
        const promptText = event.detail.prompt || "";
        customTextarea.value = promptText;
        customTextarea.scrollTop = customTextarea.scrollHeight;
        saveTextToStorage(node, textWidget, customTextarea);
        if (graph) graph.setDirtyCanvas(true, true);
        refreshMarkdownPreviewAuto?.();
    };
    api.addEventListener("rs.prompt.auto_generate_update", handler);
    return () => api.removeEventListener("rs.prompt.auto_generate_update", handler);
}

// ==========================================
// Prompt output area (textarea + Markdown preview)
// ==========================================

function triggerTextChange(textareaEl) {
    textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 提示词输出区：textarea + Markdown 预览层 + 清空按钮 + 多轮技能提示。
 * actions 是宿主自己的动作按钮（保存/随机/列表），按传入顺序组合进按钮组，
 * 👁 预览按钮始终排最后；写入 textarea 时派发原生 input 事件供外部同步 widget。
 */
function createPromptOutputArea({ customTextarea, tplSelector, actions = [] }) {
    // Create wrapper for custom textarea and buttons
    const customTextareaWrapper = mkEl("div", "rs-custom-textarea-wrapper");
    customTextareaWrapper.appendChild(customTextarea);

    // Markdown 预览层：覆盖在 textarea 区域，点 👁 切换显示（复用 skill.js 的 renderMarkdown）
    const mdPreview = mkEl("div", "rs-md-preview rs-prompt-md-preview");
    mdPreview.style.display = "none";
    customTextareaWrapper.appendChild(mdPreview);
    
    // Create button group wrapper
    const buttonGroup = mkEl("div", "rs-button-group");
    for (const action of actions) buttonGroup.appendChild(action);

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
    // 一键清除按钮：定位在 custom area 右上角，清空提示词并同步 widget/storage（无确认，直接清）
    const clearBtn = mkEl("button", "rs-clear-btn");
    clearBtn.textContent = "✕";
    clearBtn.setAttribute("data-rs-tooltip", "Clear prompt / 清空");
    clearBtn.addEventListener("click", () => {
        customTextarea.value = "";
        triggerTextChange(customTextarea);
        if (mdPreviewOn) paintMdPreview();
    });
    customTextareaWrapper.appendChild(clearBtn);
    // 预览中的任务列表复选框可点击：回写 [ ]/[x] 到 textarea（经 input 事件同步 widget/storage），
    // 便于多轮技能把用户选择带入下一次生成；不重渲染，避免长列表滚动位置跳动
    mdPreview.addEventListener("click", (e) => {
        const box = e.target && e.target.closest ? e.target.closest('input[type="checkbox"]') : null;
        if (!box || !mdPreview.contains(box)) return;
        const boxes = Array.from(mdPreview.querySelectorAll('input[type="checkbox"]'));
        const next = setTaskItemChecked(customTextarea.value || "", boxes.indexOf(box), box.checked);
        if (next !== customTextarea.value) {
            customTextarea.value = next;
            triggerTextChange(customTextarea);
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
    skillHint.textContent = "多轮技能：每次仅推进一阶段，补充问询后再点 ✨";
    // 按需显示：仅当前选中的 skill 声明了 multi_turn 时才出现（默认隐藏）
    skillHint.style.display = "none";
    function updateSkillHint() {
        const opt = [...tplSelector.options].find(o => o.value === tplSelector.value);
        skillHint.style.display = (opt && opt.dataset.multiTurn === "1") ? "" : "none";
    }
    tplSelector.addEventListener("change", updateSkillHint);

    return {
        el: customTextareaWrapper,
        actionGroupEl: buttonGroup,
        skillHintEl: skillHint,
        refreshMarkdownPreviewAuto
    };
}

export {
    createStatusBars,
    createPromptOutputArea,
    triggerTextChange,
    createGenerateHandler,
    wireBackendStreamUpdate
};
