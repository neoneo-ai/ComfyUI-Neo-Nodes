/**
 * skill.js
 * Skill 模块（纯 ES 模块：仅 export，不 registerExtension，无副作用）
 * - API：listSkills / loadSkill / saveSkill / deleteSkill / uploadSkill
 *        listSkillFiles / loadSkillFile / saveSkillFile / deleteSkillFile
 * - UI ：createSkillManagerTab() —— 列表 + 编辑器（含多文件面板）+ 上传 zip/目录
 */

// ==========================================
// DOM 元素工厂（本地实现，避免与 prompt-manager.js 循环依赖）
// ==========================================
function mkEl(tag, className, styles = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (styles) el.style.cssText = styles;
    return el;
}

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
// UI：createSkillManagerTab()
// 返回 { el, refresh } —— el 为技能管理内容容器（由 createSkillManagerModal 挂入居中弹窗），
// refresh() 重新拉取列表（首次打开时由调用方触发）。
// ==========================================

// ==========================================
// 轻量级 Markdown 渲染（无第三方依赖）
// 先对原文逐段转义再套用格式，避免注入任意 HTML；链接 URL 仅放行 http(s)/mailto/#/相对路径。
// ==========================================
function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInline(text) {
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === "`") {
            const end = text.indexOf("`", i + 1);
            if (end !== -1) { out += "<code>" + escapeHtml(text.slice(i + 1, end)) + "</code>"; i = end + 1; continue; }
        }
        if (ch === "[") {
            const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
            if (m) {
                let url = m[2];
                if (!/^(https?:|mailto:|#|\/)/i.test(url)) url = "#";
                out += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + formatInline(m[1]) + "</a>";
                i += m[0].length; continue;
            }
        }
        if (text.startsWith("**", i)) {
            const end = text.indexOf("**", i + 2);
            if (end !== -1) { out += "<strong>" + formatInline(text.slice(i + 2, end)) + "</strong>"; i = end + 2; continue; }
        }
        if (ch === "*" || ch === "_") {
            const end = text.indexOf(ch, i + 1);
            if (end !== -1) { out += "<em>" + formatInline(text.slice(i + 1, end)) + "</em>"; i = end + 1; continue; }
        }
        let j = i;
        while (j < n && text[j] !== "`" && text[j] !== "[" && text[j] !== "*" && text[j] !== "_") j++;
        if (j === i) { out += escapeHtml(text[i]); i++; }   // 未匹配的特殊字符按字面输出，保证前进
        else { out += escapeHtml(text.slice(i, j)); i = j; }
    }
    return out;
}

function renderMarkdown(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    let html = "";
    let i = 0;
    const n = lines.length;
    while (i < n) {
        const line = lines[i];
        if (/^```/.test(line)) {
            const buf = [];
            i++;
            while (i < n && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            html += '<pre class="rs-md-pre"><code>' + escapeHtml(buf.join("\n")) + "</code></pre>";
            continue;
        }
        if (/^\s*$/.test(line)) { i++; continue; }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) { html += "<h" + h[1].length + ">" + formatInline(h[2].trim()) + "</h" + h[1].length + ">"; i++; continue; }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += "<hr>"; i++; continue; }
        if (/^\s*>/.test(line)) {
            const buf = [];
            while (i < n && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
            html += "<blockquote>" + renderMarkdown(buf.join("\n")) + "</blockquote>";
            continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
            const items = [];
            while (i < n && /^\s*[-*+]\s+/.test(lines[i])) { items.push("<li>" + formatInline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>"); i++; }
            html += "<ul>" + items.join("") + "</ul>";
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (i < n && /^\s*\d+\.\s+/.test(lines[i])) { items.push("<li>" + formatInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++; }
            html += "<ol>" + items.join("") + "</ol>";
            continue;
        }
        const buf = [];
        while (i < n && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) &&
               !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
               !/^\s*>/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
            buf.push(lines[i]); i++;
        }
        if (buf.length) html += "<p>" + formatInline(buf.join(" ")) + "</p>";
    }
    return html;
}

function createSkillManagerTab() {
    const el = mkEl("div", "rs-skill-tab");

    // ---- Toolbar：搜索 + New + 上传(ZIP/目录) ----
    const toolbar = mkEl("div", "rs-tpl-toolbar");
    const searchInput = mkEl("input", "rs-form-input rs-tpl-search");
    searchInput.placeholder = "🔍 Search skills...";

    const newBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-new-btn");
    newBtn.textContent = "+ New Skill";

    const zipInput = document.createElement("input");
    zipInput.type = "file";
    zipInput.accept = ".zip";
    zipInput.style.display = "none";
    const zipBtn = mkEl("button", "rs-btn rs-btn-local");
    zipBtn.textContent = "⬆ ZIP";
    zipBtn.title = "Upload a .zip skill package";

    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.setAttribute("webkitdirectory", "");
    dirInput.style.display = "none";
    const dirBtn = mkEl("button", "rs-btn rs-btn-local");
    dirBtn.textContent = "⬆ Folder";
    dirBtn.title = "Upload a skill folder (all .md files)";

    toolbar.append(searchInput, newBtn, zipBtn, dirBtn);

    // ---- 列表区 ----
    const listBody = mkEl("div", "rs-tpl-list-body");
    listBody.style.maxHeight = "200px";
    listBody.style.overflowY = "auto";

    // ---- 编辑区 ----
    const editorArea = mkEl("div", "rs-tpl-editor-area");

    const nameRow = mkEl("div", "rs-config-row");
    const nameLabel = mkEl("label", "rs-form-label");
    nameLabel.textContent = "Skill Name";
    const nameInput = mkEl("input", "rs-form-input rs-tpl-name");
    nameInput.placeholder = "Enter skill name...";
    nameRow.append(nameLabel, nameInput);

    const contentRow = mkEl("div", "rs-config-row");
    const contentHeader = mkEl("div", "rs-content-header");
    const contentLeft = mkEl("div", "rs-content-left");
    const contentLabel = mkEl("label", "rs-form-label");
    contentLabel.textContent = "System Prompt Content";
    contentLeft.appendChild(contentLabel);
    // 多文件切换下拉（skill 含多个 .md 时显示，用于在正文区切换查看/编辑的文件）
    const fileSelect = document.createElement("select");
    fileSelect.className = "rs-file-select";
    fileSelect.style.display = "none";
    contentLeft.appendChild(fileSelect);
    // 文件工具：新增 / 删除当前选中的附属 .md（替代原先底部展开编辑面板）
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
    contentHeader.appendChild(contentLeft);
    const modeBtns = mkEl("div", "rs-content-mode");
    const previewBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    previewBtn.type = "button";
    previewBtn.textContent = "👁 Preview";
    const editBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    editBtn.type = "button";
    editBtn.textContent = "✎ Edit";
    modeBtns.append(previewBtn, editBtn);
    contentHeader.appendChild(modeBtns);
    const contentTextarea = document.createElement("textarea");
    contentTextarea.className = "rs-form-input rs-tpl-content";
    contentTextarea.style.minHeight = "360px";
    contentTextarea.style.resize = "vertical";
    contentTextarea.placeholder = "Enter the system prompt content...";
    const contentPreview = mkEl("div", "rs-md-preview");
    contentPreview.style.display = "none";
    contentRow.append(contentHeader, contentTextarea, contentPreview);

    // ---- 编辑区按钮 ----
    const editorBtns = mkEl("div", "rs-modal-btns");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = "💾 Save";
    const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-tpl-cancel-btn");
    cancelBtn.textContent = "✕ Cancel";
    editorBtns.append(saveBtn, cancelBtn);

    editorArea.append(nameRow, contentRow, editorBtns);
    el.append(toolbar, listBody, editorArea);

    // ---- 状态 ----
    let currentSkillId = null;
    let currentSkillSource = "custom";
    let currentFiles = [];   // [{ name, size }]（递归的 .md/.txt 相对路径，含主文件 skill.md）
    let selectedFile = null;     // 当前在正文区查看/编辑的文件名
    let editorMode = "preview";  // preview / edit
    const isCustom = () => currentSkillSource === "custom";
    const isMainFile = (name) => String(name || "").toLowerCase() === "skill.md";

    // 客户端剥离 skill.md 的 YAML frontmatter（与后端对标准 --- 块的解析一致）：
    // 仅当文件以 --- 开头且能定位到下一行独立的 --- 时剥离，否则原样返回。
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

    // 内容区两种模式：preview（渲染 Markdown，默认查看态）/ edit（原始 textarea）
    function setEditorMode(mode) {
        editorMode = mode;
        const previewing = mode === "preview";
        contentTextarea.style.display = previewing ? "none" : "block";
        contentPreview.style.display = previewing ? "block" : "none";
        if (previewing) contentPreview.innerHTML = renderMarkdown(contentTextarea.value);
        previewBtn.classList.toggle("rs-content-mode-active", previewing);
        editBtn.classList.toggle("rs-content-mode-active", !previewing);
    }
    previewBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("preview"); });
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("edit"); });

    // ---- 多文件：下拉切换 + 工具按钮（替代底部展开面板）----
    function populateFileSelect(defaultName) {
        fileSelect.innerHTML = "";
        if (currentFiles.length <= 1) {
            fileSelect.style.display = "none";
            return;
        }
        currentFiles.forEach(f => {
            const opt = document.createElement("option");
            opt.value = f.name;
            opt.textContent = f.name;
            fileSelect.appendChild(opt);
        });
        if (defaultName) fileSelect.value = defaultName;
        fileSelect.style.display = "inline-block";
    }

    // 依据当前选中文件 + 只读状态，更新名称/正文/保存/删除的可用性与显隐
    function updateEditorControls() {
        const readOnly = !isCustom();
        const mainSel = isMainFile(selectedFile);
        nameInput.disabled = readOnly || (currentFiles.length > 0 && !mainSel);
        contentTextarea.disabled = readOnly;
        saveBtn.style.display = readOnly ? "none" : "inline-block";
        addFileBtn.style.display = isCustom() ? "inline-block" : "none";
        const canDelete = isCustom() && currentFiles.length > 1 && !!selectedFile && !mainSel;
        delFileBtn.style.display = canDelete ? "inline-block" : "none";
    }

    // 在正文区加载某个文件：主文件显示正文（剥离 frontmatter），其余文件显示原始内容
    async function selectFile(name) {
        if (!currentSkillId || !name) return;
        selectedFile = name;
        const data = await loadSkillFile(currentSkillId, name);
        if (data && data.error) { alert("Failed to load file: " + data.error); return; }
        let text = (data && data.content) || "";
        if (isMainFile(name)) text = stripFrontmatter(text);
        contentTextarea.value = text;
        // 非 Markdown（如 .txt 引用文件）默认用原始编辑态展示，避免被当成 Markdown 渲染
        setEditorMode(/\.md$/i.test(name) ? editorMode : "edit");
        updateEditorControls();
    }
    fileSelect.addEventListener("change", () => selectFile(fileSelect.value));

    // ---- 打开/重载编辑器（按当前 id）----
    async function reloadEditor() {
        if (!currentSkillId) return;
        const skills = await listSkills();
        const tpl = (skills || []).find(s => s.id === currentSkillId);
        if (tpl) await loadEditor(tpl);
    }

    async function loadEditor(tpl) {
        currentSkillId = tpl.id;
        currentSkillSource = tpl.source || "custom";
        const full = await loadSkill(tpl.id);
        if (full && full.error) { alert("Failed to load skill: " + full.error); return; }
        nameInput.value = (full && full.name) || tpl.name || tpl.id;
        currentFiles = (full && full.files) || [];

        // 默认选中主文件（skill.md，忽略大小写）；无则第一个文件
        let mainName = null;
        for (const f of currentFiles) { if (isMainFile(f.name)) { mainName = f.name; break; } }
        if (!mainName && currentFiles.length) mainName = currentFiles[0].name;

        populateFileSelect(mainName);
        setEditorMode("preview");
        if (mainName) {
            await selectFile(mainName);
        } else {
            selectedFile = null;
            contentTextarea.value = "";
            updateEditorControls();
        }
        editorArea.style.display = "block";
    }

    async function copyAsCustom(tpl) {
        const full = await loadSkill(tpl.id);
        if (full && full.error) { alert("Failed to load skill: " + full.error); return; }
        const newId = tpl.id + "_copy_" + Date.now();
        await saveSkill({
            id: newId,
            name: ((full && full.name) || tpl.name || tpl.id) + " (Copy)",
            content: (full && full.content) || "",
            tags: [...((full && full.tags) || tpl.tags || [])],
            source: "custom"
        });
        refresh();
        document.dispatchEvent(new CustomEvent("rs.templates.updated"));
    }

    // ---- 列表渲染 ----
    async function refresh() {
        listBody.innerHTML = "";
        const skills = await listSkills();
        if (!skills || !skills.length) {
            listBody.textContent = "No skills found";
            return;
        }
        skills.forEach(tpl => {
            const row = document.createElement("div");
            row.className = "rs-tpl-item";
            row.dataset.id = tpl.id;
            // 整行可点击打开编辑器；右侧图标各自 stopPropagation，不会误触发
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                loadEditor(tpl);
            });

            const leftDiv = mkEl("div", "rs-preset-left");
            const contentSpan = mkEl("span", "rs-preset-content");
            contentSpan.textContent = tpl.name || tpl.id;

            const sourceBadge = mkEl("span", "rs-source-badge");
            if (tpl.source === "presets") { sourceBadge.textContent = "SYS"; sourceBadge.title = "System preset (read-only)"; }
            else if (tpl.source === "tasks") { sourceBadge.textContent = "TASK"; sourceBadge.title = "Built-in task skill (read-only)"; }
            else { sourceBadge.textContent = "USR"; sourceBadge.title = "User custom"; }
            contentSpan.appendChild(sourceBadge);
            leftDiv.appendChild(contentSpan);
            row.appendChild(leftDiv);

            if (tpl.tags && tpl.tags.length > 0) {
                const tagsSpan = document.createElement("span");
                tagsSpan.className = "rs-tags-part";
                tagsSpan.textContent = ` [${tpl.tags.join(", ")}]`;
                contentSpan.appendChild(document.createTextNode(" "));
                contentSpan.appendChild(tagsSpan);
            }

            const viewBtn = mkEl("span", "rs-delete-icon");
            viewBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
            viewBtn.title = "View skill";
            viewBtn.style.cssText = "cursor:pointer; display:inline-block; pointer-events:auto; margin-right:8px;";
            viewBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
                loadEditor(tpl);
            }, true);
            row.appendChild(viewBtn);

            if (tpl.source === "custom") {
                const deleteBtn = mkEl("span", "rs-delete-icon");
                deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                deleteBtn.title = "Delete skill";
                deleteBtn.style.cssText = "cursor:pointer; display:inline-block; pointer-events:auto; z-index:1000;";
                deleteBtn.addEventListener("mousedown", async (e) => {
                    e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
                    if (!confirm(`Delete skill "${tpl.name}"?`)) return;
                    const result = await deleteSkill(tpl.id);
                    if (result.success) { refresh(); document.dispatchEvent(new CustomEvent("rs.templates.updated")); }
                    else alert(`Delete failed: ${result.error || "Unknown error"}`);
                }, true);
                row.appendChild(deleteBtn);
            } else {
                const copyBtn = mkEl("span", "rs-delete-icon");
                copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                copyBtn.title = "Copy as custom skill";
                copyBtn.style.cssText = "cursor:pointer; display:inline-block; pointer-events:auto;";
                copyBtn.addEventListener("mousedown", (e) => {
                    e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
                    copyAsCustom(tpl);
                }, true);
                row.appendChild(copyBtn);
            }

            listBody.appendChild(row);
        });
    }

    // ---- 搜索 ----
    searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim().toLowerCase();
        listBody.querySelectorAll(".rs-tpl-item").forEach(item => {
            const name = (item.querySelector(".rs-preset-content")?.textContent || "").toLowerCase();
            item.style.display = (!query || name.includes(query)) ? "flex" : "none";
        });
    });

    // ---- New / Save / Cancel ----
    const handleNewClick = (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
        currentSkillId = null;
        currentSkillSource = "custom";
        currentFiles = [];
        selectedFile = null;
        nameInput.value = "";
        contentTextarea.value = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        nameInput.disabled = false;
        contentTextarea.disabled = false;
        saveBtn.style.display = "inline-block";
        addFileBtn.style.display = "none";
        delFileBtn.style.display = "none";
        setEditorMode("edit");
        editorArea.style.display = "block";
        nameInput.focus();
    };
    newBtn.addEventListener("mousedown", handleNewClick, true);
    newBtn.addEventListener("click", handleNewClick, true);

    const handleSaveClick = async (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
        const savingMain = !currentSkillId || isMainFile(selectedFile);
        const name = nameInput.value.trim();
        if (savingMain && !name) { alert("Skill name is required"); return; }

        // 新建 skill：创建主文件（正文）
        if (!currentSkillId) {
            const id = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
            if (!id) return;
            const result = await saveSkill({ id, name, content: contentTextarea.value, tags: [], source: "custom" });
            if (result.success) {
                handleNewClick(e);   // 复位到“新建”态
                refresh();
                document.dispatchEvent(new CustomEvent("rs.templates.updated"));
            } else {
                alert("Save failed: " + (result.error || "Unknown error"));
            }
            return;
        }

        // 已有 skill：保存当前选中文件（主文件走 saveSkill 保留元数据，附属文件走 saveSkillFile）
        if (savingMain) {
            const result = await saveSkill({ id: currentSkillId, name, content: contentTextarea.value, tags: [], source: "custom" });
            if (result.success) {
                refresh();
                document.dispatchEvent(new CustomEvent("rs.templates.updated"));
            } else {
                alert("Save failed: " + (result.error || "Unknown error"));
            }
        } else {
            const r = await saveSkillFile(currentSkillId, selectedFile, contentTextarea.value);
            if (r.success) {
                refresh();
                document.dispatchEvent(new CustomEvent("rs.templates.updated"));
            } else {
                alert("Save failed: " + (r.error || "Unknown error"));
            }
        }
    };
    saveBtn.addEventListener("mousedown", handleSaveClick, true);
    saveBtn.addEventListener("click", handleSaveClick, true);

    const handleCancelClick = (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
        nameInput.value = "";
        contentTextarea.value = "";
        currentSkillId = null;
        selectedFile = null;
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        editorArea.style.display = "none";
    };
    cancelBtn.addEventListener("mousedown", handleCancelClick, true);
    cancelBtn.addEventListener("click", handleCancelClick, true);

    // ---- 多文件：新增 / 删除（正文区下拉切换的文件）----
    addFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId) { alert("Save the skill first, then add files"); return; }
        const fname = prompt("New file name (.md or .txt; use / for subfolders):", "notes.md");
        if (!fname || !fname.trim()) return;
        const r = await saveSkillFile(currentSkillId, fname.trim(), "");
        if (r.success) { await reloadEditor(); document.dispatchEvent(new CustomEvent("rs.templates.updated")); }
        else alert("Add failed: " + (r.error || ""));
    });

    delFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !selectedFile || isMainFile(selectedFile)) return;
        if (!confirm(`Delete file "${selectedFile}"?`)) return;
        const r = await deleteSkillFile(currentSkillId, selectedFile);
        if (r.success) { await reloadEditor(); document.dispatchEvent(new CustomEvent("rs.templates.updated")); }
        else alert("Delete failed: " + (r.error || ""));
    });

    // ---- 上传：ZIP / 目录 ----
    zipInput.addEventListener("change", async () => {
        const f = zipInput.files[0];
        zipInput.value = "";
        if (!f) return;
        const r = await uploadSkill({ zipFile: f });
        if (r.success) { alert(`Uploaded skill "${r.id}"`); refresh(); document.dispatchEvent(new CustomEvent("rs.templates.updated")); }
        else alert("Upload failed: " + (r.error || ""));
    });

    dirInput.addEventListener("change", async () => {
        const all = Array.from(dirInput.files || []);
        dirInput.value = "";
        const textFiles = all.filter(f => /\.(md|txt)$/i.test(f.name));
        if (!textFiles.length) { alert("No .md/.txt files in the selected folder"); return; }
        // 若所有文件共享同一顶层目录，用它作为 skill_id
        const tops = [...new Set(textFiles.map(f => (f.webkitRelativePath || f.name).split("/")[0]))];
        const payload = { files: textFiles.map(f => ({ path: f.webkitRelativePath || f.name, blob: f })) };
        if (tops.length === 1) payload.skillId = tops[0];
        const r = await uploadSkill(payload);
        if (r.success) { alert(`Uploaded skill "${r.id}"`); refresh(); document.dispatchEvent(new CustomEvent("rs.templates.updated")); }
        else alert("Upload failed: " + (r.error || ""));
    });

    zipBtn.addEventListener("click", (e) => { e.stopPropagation(); zipInput.click(); });
    dirBtn.addEventListener("click", (e) => { e.stopPropagation(); dirInput.click(); });

    return { el, refresh };
}

// ==========================================
// UI：createSkillManagerModal() —— 文档居中的技能管理弹窗（比原设置浮层更大，便于编辑 skill）
// 内部复用 createSkillManagerTab() 的内容；open()/close() 控制显隐，首次 open 时拉取列表。
// overlay 自动挂到 document.body（fixed 全屏遮罩 + 居中面板），避免被节点边界裁剪。
// 返回 { overlay, open, close }。
// ==========================================

function createSkillManagerModal() {
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal");

    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = "📝 Skills & Prompt Templates";
    header.appendChild(titleSpan);
    const closeBtn = mkEl("button", "rs-skill-modal-close");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.appendChild(closeBtn);

    const content = mkEl("div", "rs-skill-modal-content");
    const tab = createSkillManagerTab();
    content.appendChild(tab.el);

    modal.append(header, content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let loaded = false;
    const open = () => {
        overlay.style.display = "flex";
        if (!loaded) {
            tab.refresh().then(() => { loaded = true; });
        }
    };
    const close = () => { overlay.style.display = "none"; };

    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同预设列表浮层）
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        modal.addEventListener(t, (e) => e.stopPropagation());
    });
    // 点遮罩空白处关闭；✕ 关闭
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); close(); });
    const onKey = (e) => { if (e.key === "Escape" && overlay.style.display !== "none") close(); };
    document.addEventListener("keydown", onKey);

    return { overlay, open, close };
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
    createSkillManagerTab,
    createSkillManagerModal
};