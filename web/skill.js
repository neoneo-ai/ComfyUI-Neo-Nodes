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
// 返回 { el, refresh } —— el 作为设置弹窗的 "Prompt Templates" 标签内容，
// refresh() 重新拉取列表（首次打开时由调用方触发）。
// ==========================================

function createSkillManagerTab() {
    const el = mkEl("div", "rs-tab-content");

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
    const contentLabel = mkEl("label", "rs-form-label");
    contentLabel.textContent = "System Prompt Content (skill.md)";
    const contentTextarea = document.createElement("textarea");
    contentTextarea.className = "rs-form-input rs-tpl-content";
    contentTextarea.style.minHeight = "360px";
    contentTextarea.style.resize = "vertical";
    contentTextarea.placeholder = "Enter the system prompt content...";
    contentRow.append(contentLabel, contentTextarea);

    // ---- 多文件面板（仅当 skill 含额外 .md 时显示）----
    const filePanel = mkEl("div", "");
    filePanel.style.cssText = "display:none; margin-top:10px; padding:8px 10px; border:1px solid #444; border-radius:6px;";
    const fileHeaderRow = mkEl("div", "");
    fileHeaderRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;";
    const fileHeaderLabel = mkEl("label", "rs-form-label");
    fileHeaderLabel.textContent = "Files (.md)";
    fileHeaderRow.appendChild(fileHeaderLabel);
    const addFileBtn = mkEl("button", "rs-btn rs-btn-local");
    addFileBtn.textContent = "+ Add File";
    fileHeaderRow.appendChild(addFileBtn);
    const fileListBody = mkEl("div", "");
    fileListBody.style.cssText = "display:flex; flex-direction:column; gap:4px;";

    // 子文件编辑器（编辑某个 .md 时显示）
    const fileEditorArea = mkEl("div", "");
    fileEditorArea.style.cssText = "display:none; margin-top:8px; padding:8px; border:1px dashed #555; border-radius:6px;";
    const fileNameInput = mkEl("input", "rs-form-input");
    fileNameInput.placeholder = "file.md (flat name, no subfolders)";
    const fileContentTextarea = document.createElement("textarea");
    fileContentTextarea.className = "rs-form-input";
    fileContentTextarea.style.minHeight = "160px";
    fileContentTextarea.style.resize = "vertical";
    fileContentTextarea.placeholder = "File content...";
    const fileEditorBtns = mkEl("div", "rs-modal-btns");
    const fileSaveBtn = mkEl("button", "rs-btn rs-btn-local");
    fileSaveBtn.textContent = "💾 Save File";
    const fileDeleteBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    fileDeleteBtn.textContent = "🗑 Delete File";
    const fileCancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    fileCancelBtn.textContent = "✕ Cancel";
    fileEditorBtns.append(fileSaveBtn, fileDeleteBtn, fileCancelBtn);
    fileEditorArea.append(fileNameInput, fileContentTextarea, fileEditorBtns);

    filePanel.append(fileHeaderRow, fileListBody, fileEditorArea);

    // ---- 编辑区按钮 ----
    const editorBtns = mkEl("div", "rs-modal-btns");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = "💾 Save";
    const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-tpl-cancel-btn");
    cancelBtn.textContent = "✕ Cancel";
    editorBtns.append(saveBtn, cancelBtn);

    editorArea.append(nameRow, contentRow, filePanel, editorBtns);
    el.append(toolbar, listBody, editorArea);

    // ---- 状态 ----
    let currentSkillId = null;
    let currentSkillSource = "custom";
    let currentFiles = [];   // [{ name, size }]（含 skill.md）
    const isCustom = () => currentSkillSource === "custom";

    function hideFileEditor() {
        fileEditorArea.style.display = "none";
        fileNameInput.value = "";
        fileContentTextarea.value = "";
    }

    // ---- 多文件面板渲染（扁平文件可编辑；子目录文件只读）----
    async function renderFileList() {
        fileListBody.innerHTML = "";
        if (!currentFiles.length) {
            const empty = mkEl("div", "");
            empty.textContent = "(no extra files)";
            empty.style.cssText = "color:#888; font-size:12px;";
            fileListBody.appendChild(empty);
            return;
        }
        currentFiles.forEach(f => {
            const flat = !String(f.name).includes("/");
            const row = mkEl("div", "");
            row.style.cssText = "display:flex; align-items:center; gap:6px;";

            const nameSpan = mkEl("span", "");
            nameSpan.textContent = f.name;
            nameSpan.style.cssText = "flex:1; font-size:12px; color:#ccc;" + (flat && isCustom() ? " cursor:pointer;" : "");
            if (!flat) nameSpan.title = "Subfolder file (read-only via this UI)";

            const sizeSpan = mkEl("span", "");
            sizeSpan.textContent = f.size ? `${f.size} B` : "";
            sizeSpan.style.cssText = "font-size:11px; color:#777;";

            row.appendChild(nameSpan);
            if (flat && isCustom()) {
                const editBtn = mkEl("button", "rs-btn rs-btn-local");
                editBtn.textContent = "✎";
                editBtn.title = "Edit file";
                editBtn.style.cssText = "padding:1px 6px; font-size:12px;";
                editBtn.addEventListener("click", (e) => { e.stopPropagation(); openFileEditor(f.name); });
                const delBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
                delBtn.textContent = "🗑";
                delBtn.title = "Delete file";
                delBtn.style.cssText = "padding:1px 6px; font-size:12px;";
                delBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete file "${f.name}"?`)) return;
                    const r = await deleteSkillFile(currentSkillId, f.name);
                    if (r.success) await reloadEditor();
                    else alert("Delete failed: " + (r.error || ""));
                });
                row.append(editBtn, delBtn);
            }
            row.appendChild(sizeSpan);
            if (flat && isCustom()) {
                nameSpan.addEventListener("click", () => openFileEditor(f.name));
            }
            fileListBody.appendChild(row);
        });
    }

    async function openFileEditor(fileName) {
        const data = await loadSkillFile(currentSkillId, fileName);
        if (data && data.error) { alert("Failed to load file: " + data.error); return; }
        fileNameInput.value = fileName;
        fileContentTextarea.value = (data && data.content) || "";
        fileEditorArea.style.display = "block";
    }

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
        contentTextarea.value = (full && full.content) || "";
        currentFiles = (full && full.files) || [];

        const readOnly = !isCustom();
        const multiFile = currentFiles.length > 1;
        // 多文件 skill 的正文是拼接结果，主编辑框只读；单文件才可直接编辑并保存到 skill.md
        nameInput.disabled = readOnly;
        contentTextarea.disabled = readOnly || multiFile;
        saveBtn.style.display = (readOnly || multiFile) ? "none" : "inline-block";

        filePanel.style.display = (readOnly || !multiFile) ? "none" : "block";
        addFileBtn.style.display = (readOnly || !multiFile) ? "none" : "inline-block";
        hideFileEditor();
        await renderFileList();

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

            const leftDiv = mkEl("div", "rs-preset-left");
            const contentSpan = mkEl("span", "rs-preset-content");
            contentSpan.textContent = tpl.name || tpl.id;
            contentSpan.style.cursor = "pointer";
            contentSpan.addEventListener("mousedown", (e) => {
                e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
                loadEditor(tpl);
            }, true);

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
        nameInput.value = "";
        contentTextarea.value = "";
        nameInput.disabled = false;
        contentTextarea.disabled = false;
        saveBtn.style.display = "inline-block";
        filePanel.style.display = "none";
        hideFileEditor();
        editorArea.style.display = "block";
        nameInput.focus();
    };
    newBtn.addEventListener("mousedown", handleNewClick, true);
    newBtn.addEventListener("click", handleNewClick, true);

    const handleSaveClick = async (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
        const name = nameInput.value.trim();
        if (!name) { alert("Skill name is required"); return; }
        const content = contentTextarea.value;
        let id = currentSkillId || name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
        if (!id) return;
        const result = await saveSkill({ id, name, content, tags: [], source: "custom" });
        if (result.success) {
            nameInput.value = "";
            contentTextarea.value = "";
            currentSkillId = null;
            refresh();
            document.dispatchEvent(new CustomEvent("rs.templates.updated"));
        } else {
            alert("Save failed: " + (result.error || "Unknown error"));
        }
    };
    saveBtn.addEventListener("mousedown", handleSaveClick, true);
    saveBtn.addEventListener("click", handleSaveClick, true);

    const handleCancelClick = (e) => {
        e.stopPropagation(); e.stopImmediatePropagation();
        nameInput.value = "";
        contentTextarea.value = "";
        currentSkillId = null;
        editorArea.style.display = "none";
    };
    cancelBtn.addEventListener("mousedown", handleCancelClick, true);
    cancelBtn.addEventListener("click", handleCancelClick, true);

    // ---- 多文件：新增 / 保存 / 删除子文件 ----
    addFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId) { alert("Open or create a skill first"); return; }
        const fname = prompt("New file name (flat, .md):", "notes.md");
        if (!fname || !fname.trim()) return;
        const r = await saveSkillFile(currentSkillId, fname.trim(), "");
        if (r.success) await reloadEditor();
        else alert("Add failed: " + (r.error || ""));
    });

    fileSaveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const fname = fileNameInput.value.trim();
        if (!fname) { alert("File name required"); return; }
        const r = await saveSkillFile(currentSkillId, fname, fileContentTextarea.value);
        if (r.success) { hideFileEditor(); await reloadEditor(); }
        else alert("Save failed: " + (r.error || ""));
    });

    fileDeleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const fname = fileNameInput.value.trim();
        if (!fname || !confirm(`Delete file "${fname}"?`)) return;
        const r = await deleteSkillFile(currentSkillId, fname);
        if (r.success) { hideFileEditor(); await reloadEditor(); }
        else alert("Delete failed: " + (r.error || ""));
    });

    fileCancelBtn.addEventListener("click", (e) => { e.stopPropagation(); hideFileEditor(); });

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
        const mdFiles = all.filter(f => f.name.toLowerCase().endsWith(".md"));
        if (!mdFiles.length) { alert("No .md files in the selected folder"); return; }
        // 若所有文件共享同一顶层目录，用它作为 skill_id
        const tops = [...new Set(mdFiles.map(f => (f.webkitRelativePath || f.name).split("/")[0]))];
        const payload = { files: mdFiles.map(f => ({ path: f.webkitRelativePath || f.name, blob: f })) };
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
    createSkillManagerTab
};