/**
 * skill.js
 * Skill 模块（ES 模块：export API + UI；导入 marked/purify 用于 Markdown 渲染）
 * - API：listSkills / loadSkill / saveSkill / deleteSkill / uploadSkill
 *        listSkillFiles / loadSkillFile / saveSkillFile / deleteSkillFile
 * - UI ：createSkillDetailPopup()（单技能详情弹窗）+ createSkillDropdown()（技能下拉组装：管理入口）
 */

// Markdown 渲染复用 ComfyUI 内置同款库（marked + DOMPurify），breaks:true 保留单行换行
import "./marked.min.js";
import "./purify.min.js";
import { app } from "../../scripts/app.js";
import { attachComboBox } from "./combo-box.js";
import { mkEl } from "./dom-utils.js";
// 仅事件回调内调用（复制补带 workflow/config、画布导出为出图技能、每技能出图设置）；与 image-gen.js 的循环导入均为延迟使用，安全
import { copySkillFiles, saveWorkflowSkill, getSkillGenConfig, saveSkillGenConfig, listGenModels, createModelConfigSection, createGenSizeRows } from "./image-gen.js";

// ==========================================
// Skill API
// ==========================================

/** 列出所有 skill（任务 + 模板统一元数据，不含正文） */
async function listSkills() {
    try {
        const res = await fetch("/rs_prompts/skills");
        return await res.json();
    } catch (e) {
        console.error("Failed to list skills:", e);
        return [];
    }
}

/** 加载单个 skill 完整数据（元数据 + 拼接正文 + 文件列表） */
async function loadSkill(id) {
    try {
        const res = await fetch("/rs_prompts/load_skill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        if (!res.ok) return { error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to load skill:", e);
        return { error: e.message };
    }
}

/** 保存/更新 skill 主文件 skill.md（预设只读） */
async function saveSkill(skill) {
    try {
        const res = await fetch("/rs_prompts/save_skill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(skill)
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to save skill:", e);
        return { success: false, error: e.message };
    }
}

/** 删除整个 skill 目录（预设不可删） */
async function deleteSkill(id) {
    try {
        const res = await fetch("/rs_prompts/delete_skill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to delete skill:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 上传 skill。payload 二选一：
 *   - { zipFile: File }                         —— 单个 .zip
 *   - { files: [{ path, blob }], skillId? }     —— 目录清单（多个 .md）
 */
async function uploadSkill(payload) {
    const form = new FormData();
    if (payload.skillId) form.append("skill_id", payload.skillId);
    if (payload.zipFile) {
        form.append("file", payload.zipFile, payload.zipFile.name);
    } else if (payload.files && payload.files.length) {
        form.append("manifest", JSON.stringify(payload.files.map(f => f.path)));
        for (const f of payload.files) {
            const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob]);
            form.append("files", blob, f.path);
        }
    } else {
        return { success: false, error: "No upload payload" };
    }
    try {
        const res = await fetch("/rs_prompts/upload_skill", { method: "POST", body: form });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to upload skill:", e);
        return { success: false, error: e.message };
    }
}

/** 列出 skill 的文件（后端无独立接口，取自 load_skill.files） */
async function listSkillFiles(id) {
    const full = await loadSkill(id);
    if (!full || full.error) return [];
    return full.files || [];
}

/** 加载 skill 目录内某个 .md 文件内容（仅限扁平文件名） */
async function loadSkillFile(id, file) {
    try {
        const res = await fetch("/rs_prompts/load_skill_file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, file })
        });
        if (!res.ok) return { error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to load skill file:", e);
        return { error: e.message };
    }
}

/** 保存 skill 目录内某个 .md 文件（仅限扁平文件名） */
async function saveSkillFile(id, file, content) {
    try {
        const res = await fetch("/rs_prompts/save_skill_file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, file, content })
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to save skill file:", e);
        return { success: false, error: e.message };
    }
}

/** 删除 skill 目录内某个 .md 文件（skill.md 不可删） */
async function deleteSkillFile(id, file) {
    try {
        const res = await fetch("/rs_prompts/delete_skill_file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, file })
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to delete skill file:", e);
        return { success: false, error: e.message };
    }
}

// ==========================================
// Markdown 渲染：marked（GFM + breaks:true 保留换行）+ DOMPurify 消毒，防 LLM/用户内容注入
// ==========================================
function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
    const text = String(src == null ? "" : src);
    if (!text) return "";
    // 首选：marked（GFM + breaks:true 保留单行换行）+ DOMPurify 消毒，防止 LLM/用户内容注入 HTML
    if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }));
    }
    // 回退：ComfyUI 内置渲染器（已消毒，但不保留单行换行）
    const app = window.comfyAPI?.app;
    if (app?.extensionManager?.renderMarkdownToHtml) {
        return app.extensionManager.renderMarkdownToHtml(text);
    }
    // 最后兜底：转义纯文本 + 手动换行
    return escapeHtml(text).replace(/\n/g, "<br>");
}

// ==========================================
// skill 选择列表：分类标签 + 把 skills 填充进原生 <select>（combo-box 数据源）
// ==========================================
// image_gen 组排最前（仅次于 select 顶部的「默认」项，原生 option 恒在 optgroup 之前），
// 图像/视频提示词增强紧随其后，vision/task/custom 依次跟随；未知分类回落 image_enhance
const CATEGORY_LABELS = {
    "image_gen": { label: "⚡ 出图 (Krea2)", order: -1 },
    "image_enhance": { label: "🎨 图像提示词增强", order: 0 },
    "video_enhance": { label: "🎬 视频提示词增强", order: 1 },
    "vision": { label: "🖼️ 图像 / 反推", order: 2 },
    "task": { label: "⚙️ 任务", order: 3 },
    "custom": { label: "📝 自定义", order: 4 }
};

/** 把 skills 元数据填充进原生 <select>：按 category 分组为 optgroup，option 带 📷(需图) 徽标与 multiTurn 标记 */
function populateSkillOptions(selectEl, skills) {
    if (!skills || !skills.length) return;
    const groups = {};
    skills.forEach(s => {
        const cat = CATEGORY_LABELS[s.category] ? s.category : "image_enhance";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(s);
    });
    Object.keys(groups).sort((a, b) =>
        (CATEGORY_LABELS[a]?.order ?? 99) - (CATEGORY_LABELS[b]?.order ?? 99)
    ).forEach(cat => {
        const optgroup = mkEl("optgroup");
        optgroup.label = CATEGORY_LABELS[cat].label;
        groups[cat].forEach(s => {
            const opt = mkEl("option");
            opt.value = s.id;
            opt.dataset.multiTurn = s.multi_turn ? "1" : "";
            opt.dataset.source = s.source || "";
            // 出图 skill 元数据：genImage 走后端出图分支，
            // requiresRef 标记四视图（必须带参考图，缺图在预览区底部报错）
            opt.dataset.genImage = s.gen_image ? "1" : "";
            opt.dataset.requiresRef = s.requires_ref ? "1" : "";
            const imgBadge = s.needs_image ? "📷 " : "";
            opt.textContent = `${imgBadge}${s.name || s.id}`;
            optgroup.appendChild(opt);
        });
        selectEl.appendChild(optgroup);
    });
}

// ==========================================
// UI：createSkillDetailPopup() —— 单技能详情弹窗（查看 / 编辑 / 删除 / 复制为自定义 / 新建）
// 由技能下拉的行内操作与底部工具栏打开；overlay 挂到 document.body，跨节点共享一个实例。
// 返回 { overlay, openExisting(id, source), openNew(), close }。
// ==========================================

function createSkillDetailPopup() {
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-detail");

    // ---- 头部：标题 + 来源徽标 + 关闭 ----
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = "📝 Skill";
    const sourceBadge = mkEl("span", "rs-source-badge rs-skill-detail-badge");
    header.append(titleSpan, sourceBadge);
    const closeBtn = mkEl("button", "rs-skill-modal-close");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.appendChild(closeBtn);

    // ---- 内容：名称行 + 正文区（多文件下拉 + 预览/编辑切换）----
    const content = mkEl("div", "rs-skill-modal-content");

    const nameRow = mkEl("div", "rs-config-row");
    const nameLabel = mkEl("label", "rs-form-label");
    nameLabel.textContent = "Skill Name";
    const nameInput = mkEl("input", "rs-form-input rs-tpl-name");
    nameInput.placeholder = "Enter skill name...";
    nameRow.append(nameLabel, nameInput);

    // multi_turn 勾选：每次生成仅推进一个阶段（节点底部会显示多轮提示）
    const multiTurnRow = mkEl("div", "rs-skill-multiturn-row");
    const multiTurnChk = document.createElement("input");
    multiTurnChk.type = "checkbox";
    multiTurnChk.className = "rs-skill-multiturn-chk";
    const multiTurnLabel = mkEl("label", "rs-skill-multiturn-label");
    multiTurnLabel.textContent = "Multi-turn (multi_turn)";
    multiTurnLabel.title = "每次生成仅推进一个阶段，需补充返回的问询后再次点击 ✨ 继续";
    multiTurnRow.append(multiTurnChk, multiTurnLabel);

    const contentRow = mkEl("div", "rs-config-row");
    const contentHeader = mkEl("div", "rs-content-header");
    const contentLeft = mkEl("div", "rs-content-left");
    const contentLabel = mkEl("label", "rs-form-label");
    contentLabel.textContent = "System Prompt Content";
    contentLeft.appendChild(contentLabel);
    // 多文件切换下拉（skill 含多个 .md 时显示）
    const fileSelect = document.createElement("select");
    fileSelect.className = "rs-file-select";
    fileSelect.style.display = "none";
    contentLeft.appendChild(fileSelect);
    // 附属 .md 的新增 / 删除（仅自定义 skill）
    const fileTools = mkEl("div", "rs-content-mode");
    const addFileBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    addFileBtn.type = "button";
    addFileBtn.textContent = "+ File";
    addFileBtn.title = "Add a .md file to this skill";
    const delFileBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-content-mode-btn");
    delFileBtn.type = "button";
    delFileBtn.textContent = "🗑";
    delFileBtn.title = "Delete the selected file";
    fileTools.append(addFileBtn, delFileBtn);
    contentLeft.appendChild(fileTools);
    const modeBtns = mkEl("div", "rs-content-mode");
    const previewBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    previewBtn.type = "button";
    previewBtn.textContent = "👁 Preview";
    const editBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    editBtn.type = "button";
    editBtn.textContent = "✎ Edit";
    modeBtns.append(previewBtn, editBtn);
    contentHeader.appendChild(contentLeft);
    contentHeader.appendChild(modeBtns);
    const contentTextarea = document.createElement("textarea");
    contentTextarea.className = "rs-form-input rs-tpl-content";
    contentTextarea.style.resize = "vertical";
    contentTextarea.placeholder = "Enter the system prompt content...";
    const contentPreview = mkEl("div", "rs-md-preview");
    contentPreview.style.display = "none";
    contentRow.append(contentHeader, contentTextarea, contentPreview);

    // ---- 出图设置（仅 gen_image 技能显示）：复用全局出图设置的共享控件区，读写该技能的 config.json 覆盖 ----
    const genSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-gen-settings");
    genSettingsWrap.style.display = "none";
    const genSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const genSettingsTitle = mkEl("label", "rs-form-label");
    genSettingsTitle.textContent = "🖼️ 出图设置（本技能覆盖）";
    genSettingsTitle.title = "仅对本技能生效，未填项回落全局出图设置";
    const genReadOnlyHint = mkEl("span", "rs-gen-readonly-hint");
    genReadOnlyHint.textContent = "预设/任务技能只读：点下方「⧉ Copy as custom」复制后可编辑";
    genReadOnlyHint.style.display = "none";
    genSettingsHeader.append(genSettingsTitle, genReadOnlyHint);
    const genModelSection = createModelConfigSection();
    const genSizeSection = createGenSizeRows();
    // Text Encoder / VAE / 出图张数 / 输出前缀 很少改动：收进可折叠「高级选项」（默认收起），放到最底部
    let advEl = null;
    {
        const advRows = [
            ...genModelSection.el.querySelectorAll(".rs-gen-adv-row"),
            ...genSizeSection.el.querySelectorAll(".rs-gen-adv-row"),
        ];
        if (advRows.length) {
            const adv = mkEl("details", "rs-gen-advanced");
            const advSummary = mkEl("summary", "rs-gen-advanced-summary");
            advSummary.textContent = "Text Encoder / VAE / 出图张数 / 输出前缀（高级）";
            adv.appendChild(advSummary);
            for (const r of advRows) adv.appendChild(r);
            advEl = adv;
        }
    }
    genSettingsWrap.append(genSettingsHeader, genModelSection.el, genSizeSection.el);
    if (advEl) genSettingsWrap.appendChild(advEl);

    // readOnly（预设/任务技能）时禁用全部控件；config 缺失按空对象回落默认。
    // 禁用必须在 load() 之后：load 会动态新建 LoRA 行，新建元素不会被前面的禁用循环覆盖
    async function loadGenSettings(readOnly) {
        if (!currentSkillId) return;
        const config = await getSkillGenConfig(currentSkillId);
        let models = {};
        try { models = await listGenModels(); } catch (e) { console.warn("Failed to load gen models:", e); }
        genModelSection.load(config || {}, models);
        genSizeSection.load(config || {});
        for (const el of genSettingsWrap.querySelectorAll("select, input, button")) el.disabled = readOnly;
        genReadOnlyHint.style.display = readOnly ? "block" : "none";
    }

    // ---- 底部按钮：随状态显隐（Save / Copy-as-custom / Delete / Close）----
    const footerBtns = mkEl("div", "rs-modal-btns rs-skill-detail-actions");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = "💾 Save";
    const copyBtn = mkEl("button", "rs-btn rs-btn-local");
    copyBtn.textContent = "⧉ Copy as custom";
    copyBtn.title = "Copy this built-in skill into a new editable custom skill";
    const deleteBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    deleteBtn.textContent = "🗑 Delete";
    const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-tpl-cancel-btn");
    cancelBtn.textContent = "✕ Close";
    footerBtns.append(saveBtn, copyBtn, deleteBtn, cancelBtn);

    content.append(nameRow, multiTurnRow, contentRow, genSettingsWrap, footerBtns);
    modal.append(header, content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ---- 状态 ----
    let currentSkillId = null;
    let currentSource = "custom";
    let currentFiles = [];   // [{ name, size }]（递归 .md/.txt 相对路径，含主文件 skill.md）
    let selectedFile = null;
    let editorMode = "preview";
    const isCustom = () => currentSource === "custom";
    const isMainFile = (name) => String(name || "").toLowerCase() === "skill.md";

    // 客户端剥离 skill.md 的 YAML frontmatter（与后端对标准 --- 块的解析一致）
    function stripFrontmatter(text) {
        let t = String(text || "");
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        const lines = t.split("\n");
        if ((lines[0] || "").replace(/\r$/, "") !== "---") return text;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].replace(/\r$/, "") === "---") {
                return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
            }
        }
        return text;
    }

    function setEditorMode(mode) {
        editorMode = mode;
        const previewing = mode === "preview";
        // 预览与编辑保持等高：进入预览时按当前编辑框像素高度锁定（长内容各自内部滚动）
        contentPreview.style.height = previewing && contentTextarea.offsetHeight ? contentTextarea.offsetHeight + "px" : "";
        contentTextarea.style.display = previewing ? "none" : "block";
        contentPreview.style.display = previewing ? "block" : "none";
        if (previewing) contentPreview.innerHTML = renderMarkdown(contentTextarea.value);
        previewBtn.classList.toggle("rs-content-mode-active", previewing);
        editBtn.classList.toggle("rs-content-mode-active", !previewing);
    }
    previewBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("preview"); });
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("edit"); });

    function populateFileSelect(defaultName) {
        fileSelect.innerHTML = "";
        if (currentFiles.length <= 1) { fileSelect.style.display = "none"; return; }
        currentFiles.forEach(f => {
            const opt = document.createElement("option");
            opt.value = f.name;
            opt.textContent = f.name;
            fileSelect.appendChild(opt);
        });
        if (defaultName) fileSelect.value = defaultName;
        fileSelect.style.display = "inline-block";
    }

    // 依据当前来源 + 选中文件，更新名称/正文/各按钮的可用性与显隐
    function updateControls() {
        const readOnly = !isCustom();
        const mainSel = isMainFile(selectedFile);
        nameInput.disabled = readOnly || (currentFiles.length > 0 && !mainSel);
        contentTextarea.disabled = readOnly;
        multiTurnChk.disabled = readOnly;
        saveBtn.style.display = readOnly ? "none" : "inline-block";
        copyBtn.style.display = readOnly ? "inline-block" : "none";
        deleteBtn.style.display = isCustom() ? "inline-block" : "none";
        addFileBtn.style.display = isCustom() ? "inline-block" : "none";
        const canDeleteFile = isCustom() && currentFiles.length > 1 && !!selectedFile && !mainSel;
        delFileBtn.style.display = canDeleteFile ? "inline-block" : "none";
    }

    function setBadge() {
        if (currentSource === "presets") { sourceBadge.textContent = "SYS"; sourceBadge.title = "System preset (read-only)"; }
        else if (currentSource === "tasks") { sourceBadge.textContent = "TASK"; sourceBadge.title = "Built-in task skill (read-only)"; }
        else { sourceBadge.textContent = "USR"; sourceBadge.title = "User custom"; }
    }

    async function selectFile(name) {
        if (!currentSkillId || !name) return;
        selectedFile = name;
        const data = await loadSkillFile(currentSkillId, name);
        if (data && data.error) { alert("Failed to load file: " + data.error); return; }
        let text = (data && data.content) || "";
        if (isMainFile(name)) text = stripFrontmatter(text);
        contentTextarea.value = text;
        setEditorMode(/\.md$/i.test(name) ? editorMode : "edit");
        updateControls();
    }
    fileSelect.addEventListener("change", () => selectFile(fileSelect.value));

    // ---- 打开：查看/编辑已有 skill ----
    async function openExisting(id, source) {
        overlay.style.display = "flex";
        titleSpan.textContent = "📝 Skill";
        currentSkillId = id;
        currentSource = source || "custom";
        setBadge();
        nameInput.value = "";
        contentTextarea.value = "";
        contentPreview.innerHTML = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        selectedFile = null;
        const full = await loadSkill(id);
        if (full && full.error) { alert("Failed to load skill: " + full.error); close(); return; }
        const nm = (full && full.name) || id;
        nameInput.value = nm;
        titleSpan.textContent = "📝 " + nm;
        titleSpan.title = nm;
        multiTurnChk.checked = !!(full && full.multi_turn);
        currentFiles = (full && full.files) || [];
        let mainName = null;
        for (const f of currentFiles) { if (isMainFile(f.name)) { mainName = f.name; break; } }
        if (!mainName && currentFiles.length) mainName = currentFiles[0].name;
        populateFileSelect(mainName);
        setEditorMode("preview");
        if (mainName) await selectFile(mainName);
        else { selectedFile = null; contentTextarea.value = ""; }
        // 出图技能显示 config.json 覆盖区（预设/任务只读）；其余技能隐藏。
        // multi_turn 是文本多轮概念，出图技能用不到 → 一并隐藏
        if (full && full.gen_image) {
            genSettingsWrap.style.display = "block";
            multiTurnRow.style.display = "none";
            await loadGenSettings(!isCustom());
        } else {
            genSettingsWrap.style.display = "none";
            multiTurnRow.style.display = "";
        }
        updateControls();
    }

    // ---- 打开：新建空表单 ----
    function openNew() {
        overlay.style.display = "flex";
        titleSpan.textContent = "✨ New Skill";
        titleSpan.removeAttribute("title");
        currentSkillId = null;
        currentFiles = [];
        currentSource = "custom";
        setBadge();
        nameInput.value = "";
        contentTextarea.value = "";
        contentPreview.innerHTML = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        selectedFile = null;
        multiTurnChk.checked = false;
        multiTurnRow.style.display = "";
        nameInput.disabled = false;
        contentTextarea.disabled = false;
        setEditorMode("edit");
        updateControls();
        nameInput.focus();
    }

    function close() { overlay.style.display = "none"; }

    // ---- 保存（新建主文件 / 已有 skill 的当前选中文件）----
    // 出图设置区可见且可编辑时随主 Save 一起写入该技能 config.json（弹窗内只有一个保存入口）
    async function persistGenSettings() {
        if (!currentSkillId || !isCustom() || genSettingsWrap.style.display === "none") return;
        try {
            await saveSkillGenConfig(currentSkillId, { ...genModelSection.collect(), ...genSizeSection.collect() });
        } catch (err) {
            alert("Save gen settings failed: " + err.message);
        }
    }

    async function handleSave() {
        const name = nameInput.value.trim();
        if (!name) { alert("Skill name is required"); return; }
        if (!currentSkillId) {
            const id = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
            if (!id) return;
            const result = await saveSkill({ id, name, content: contentTextarea.value, tags: [], source: "custom", multi_turn: multiTurnChk.checked });
            if (result.success) { document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
            else alert("Save failed: " + (result.error || "Unknown error"));
            return;
        }
        if (isMainFile(selectedFile)) {
            const result = await saveSkill({ id: currentSkillId, name, content: contentTextarea.value, tags: [], source: "custom", multi_turn: multiTurnChk.checked });
            if (result.success) { await persistGenSettings(); document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
            else alert("Save failed: " + (result.error || "Unknown error"));
        } else {
            const r = await saveSkillFile(currentSkillId, selectedFile, contentTextarea.value);
            if (r.success) { await persistGenSettings(); document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
            else alert("Save failed: " + (r.error || ""));
        }
    }
    saveBtn.addEventListener("click", (e) => { e.stopPropagation(); handleSave(); });

    // ---- 删除（仅自定义）----
    deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !isCustom()) return;
        const nm = nameInput.value.trim() || currentSkillId;
        if (!confirm(`Delete skill "${nm}"?`)) return;
        const result = await deleteSkill(currentSkillId);
        if (result.success) { document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
        else alert(`Delete failed: ${result.error || "Unknown error"}`);
    });

    // ---- 复制为自定义（仅内置；客户端 loadSkill + saveSkill，无后端接口）----
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || isCustom()) return;
        const full = await loadSkill(currentSkillId);
        if (full && full.error) { alert("Failed to load skill: " + full.error); return; }
        const newId = currentSkillId + "_copy_" + Date.now();
        await saveSkill({
            id: newId,
            name: ((full && full.name) || nameInput.value.trim() || currentSkillId) + " (Copy)",
            content: (full && full.content) || "",
            tags: [...((full && full.tags) || [])],
            source: "custom",
            multi_turn: !!(full && full.multi_turn),
            // 保留 frontmatter 元数据：出图技能复制后仍是 image_gen 分类且设置区可见
            category: (full && full.category) || "",
            gen_image: !!(full && full.gen_image),
            requires_ref: !!(full && full.requires_ref)
        });
        await copySkillFiles(currentSkillId, newId); // 出图技能连同 workflow.json / config.json 一起复制（失败静默）
        document.dispatchEvent(new CustomEvent("rs.skills.updated"));
        close();
    });

    // ---- 附属 .md：新增 / 删除（仅自定义）----
    addFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !isCustom()) return;
        const fname = prompt("New file name (.md or .txt; use / for subfolders):", "notes.md");
        if (!fname || !fname.trim()) return;
        const r = await saveSkillFile(currentSkillId, fname.trim(), "");
        if (r.success) { await openExisting(currentSkillId, currentSource); document.dispatchEvent(new CustomEvent("rs.skills.updated")); }
        else alert("Add failed: " + (r.error || ""));
    });

    delFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !selectedFile || isMainFile(selectedFile)) return;
        if (!confirm(`Delete file "${selectedFile}"?`)) return;
        const r = await deleteSkillFile(currentSkillId, selectedFile);
        if (r.success) { await openExisting(currentSkillId, currentSource); document.dispatchEvent(new CustomEvent("rs.skills.updated")); }
        else alert("Delete failed: " + (r.error || ""));
    });

    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });

    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同预设列表浮层）
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        modal.addEventListener(t, (e) => e.stopPropagation());
    });
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); close(); });
    const onKey = (e) => { if (e.key === "Escape" && overlay.style.display !== "none") close(); };
    document.addEventListener("keydown", onKey);

    return { overlay, openExisting, openNew, close };
}

// ==========================================
// 单例：详情弹窗 / 上传隐藏 input（跨节点共享；createSkillDropdown 的管理入口都走这里）
// ==========================================

let _skillDetailPopup = null;
function getSkillDetailPopup() {
    if (!_skillDetailPopup) _skillDetailPopup = createSkillDetailPopup();
    return _skillDetailPopup;
}

// 共享的 ZIP / 目录上传隐藏 input：多个节点的技能下拉共用同一对，change 时上传并广播刷新
let _skillUploadInputs = null;
function getSkillUploadInputs() {
    if (_skillUploadInputs) return _skillUploadInputs;
    const zipInput = document.createElement("input");
    zipInput.type = "file";
    zipInput.accept = ".zip";
    zipInput.style.display = "none";
    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.setAttribute("webkitdirectory", "");
    dirInput.style.display = "none";
    document.body.appendChild(zipInput);
    document.body.appendChild(dirInput);

    zipInput.addEventListener("change", async () => {
        const f = zipInput.files[0];
        zipInput.value = "";
        if (!f) return;
        const r = await uploadSkill({ zipFile: f });
        if (r.success) { alert(`Uploaded skill "${r.id}"`); document.dispatchEvent(new CustomEvent("rs.skills.updated")); }
        else alert("Upload failed: " + (r.error || ""));
    });
    dirInput.addEventListener("change", async () => {
        const all = Array.from(dirInput.files || []);
        dirInput.value = "";
        const textFiles = all.filter(f => /\.(md|txt)$/i.test(f.name));
        if (!textFiles.length) { alert("No .md/.txt files in the selected folder"); return; }
        const tops = [...new Set(textFiles.map(f => (f.webkitRelativePath || f.name).split("/")[0]))];
        const payload = { files: textFiles.map(f => ({ path: f.webkitRelativePath || f.name, blob: f })) };
        if (tops.length === 1) payload.skillId = tops[0];
        const r = await uploadSkill(payload);
        if (r.success) { alert(`Uploaded skill "${r.id}"`); document.dispatchEvent(new CustomEvent("rs.skills.updated")); }
        else alert("Upload failed: " + (r.error || ""));
    });

    _skillUploadInputs = { zipInput, dirInput };
    return _skillUploadInputs;
}

// ==========================================
// 技能下拉组装：原生 select（数据源）+ 可搜索组件 + 底部管理工具栏 + 行内操作一体创建。
// prompt-manager 只需 const { selectEl, combo } = createSkillDropdown() 并挂载 combo.box；
// 选项填充仍走 populateSkillOptions(selectEl, skills)，combo 自动跟随（选项带 data-source 供行内操作判断）。
// ==========================================

function createSkillDropdown() {
    const selectEl = mkEl("select", "rs-tpl-selector");
    selectEl.title = "Select a skill";

    // 底部工具栏：+ New Skill / ⬆ ZIP / ⬆ Folder —— 管理入口（替代原 ⚙️ 设置弹窗）
    const skillFooter = mkEl("div", "rs-skill-dropdown-footer");
    const makeFooterBtn = (label, title) => {
        const b = mkEl("button", "rs-btn rs-btn-local rs-skill-footer-btn");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };
    const footerNewBtn = makeFooterBtn("+ New Skill", "Create a new custom skill");
    footerNewBtn.addEventListener("click", (e) => { e.stopPropagation(); combo.close(); getSkillDetailPopup().openNew(); });
    const footerZipBtn = makeFooterBtn("⬆ ZIP", "Upload a .zip skill package");
    footerZipBtn.addEventListener("click", (e) => { e.stopPropagation(); combo.close(); getSkillUploadInputs().zipInput.click(); });
    const footerDirBtn = makeFooterBtn("⬆ Folder", "Upload a skill folder (all .md files)");
    footerDirBtn.addEventListener("click", (e) => { e.stopPropagation(); combo.close(); getSkillUploadInputs().dirInput.click(); });
    // 把当前画布工作流（API prompt）导出为出图技能：后端自动抽模板占位符 + LoRA 槽位
    const footerCanvasBtn = makeFooterBtn("📋 From Canvas", "Export the current canvas workflow as an image-gen skill");
    footerCanvasBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        combo.close();
        try {
            const { output, error } = (await app.graphToPrompt()) || {};
            if (error || !output || !Object.keys(output).length) {
                alert("Cannot export: no valid workflow on canvas" + (error?.message ? " (" + error.message + ")" : ""));
                return;
            }
            const name = prompt("Skill name:", "my-workflow");
            if (!name || !name.trim()) return;
            const description = prompt("Description (optional):", "") ?? "";
            const tagsRaw = prompt("Tags, comma separated (optional):", "") ?? "";
            const r = await saveWorkflowSkill({
                name: name.trim(),
                description,
                tags: String(tagsRaw).split(",").map((t) => t.trim()).filter(Boolean),
                workflow: output,
            });
            alert(`Saved image-gen skill "${r.id}"` + (r.warnings?.length ? "\n" + r.warnings.join("\n") : ""));
            document.dispatchEvent(new CustomEvent("rs.skills.updated"));
        } catch (err) {
            alert("Save failed: " + err.message);
        }
    });
    skillFooter.append(footerNewBtn, footerZipBtn, footerDirBtn, footerCanvasBtn);

    // 行内操作：自定义 skill → ✎ Edit；内置 SYS/TASK → 👁 查看。点击先关下拉再开详情弹窗，
    // mousedown 上 preventDefault + stopPropagation 避免触发整行的选中(pickValue)。
    const renderItemExtra = (itemEl, value, o) => {
        const source = (o && o.dataset && o.dataset.source) || "custom";
        const isCustomSkill = source === "custom";
        const btn = mkEl("button", "rs-skill-row-action");
        btn.type = "button";
        btn.textContent = isCustomSkill ? "✎ Edit" : "👁 查看";
        btn.title = isCustomSkill ? "Edit this skill" : "View this skill (read-only)";
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            combo.close();
            getSkillDetailPopup().openExisting(value, source);
        });
        itemEl.appendChild(btn);
    };

    // combo 声明在其后：footer/行内操作闭包只在用户交互时执行，届时 combo 已赋值
    const combo = attachComboBox(selectEl, {
        placeholder: "🔍 输入过滤 skill...",
        emptyText: "无匹配 skill",
        listMinWidth: 306,
        footerEl: skillFooter,
        renderItemExtra,
    });

    return { selectEl, combo };
}

// ==========================================
// 导出（纯 ES 模块，无副作用）
// ==========================================
export {
    listSkills,
    loadSkill,
    saveSkill,
    deleteSkill,
    uploadSkill,
    listSkillFiles,
    loadSkillFile,
    saveSkillFile,
    deleteSkillFile,
    populateSkillOptions,
    renderMarkdown,
    createSkillDetailPopup,
    createSkillDropdown
};