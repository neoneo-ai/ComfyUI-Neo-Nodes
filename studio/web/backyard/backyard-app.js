// Backyard 独立页面：hash 路由（#/config #/preprocess #/upload #/manage）+ 各视图挂载。
import { t, tf } from "../js/core/i18n.js";
const view = document.getElementById("by-view");
const views = new Map();

function $el(tag, opts = {}) {
    const el = document.createElement(tag);
    if (opts.className) el.className = opts.className;
    if (opts.textContent !== undefined) el.textContent = opts.textContent;
    if (opts.html) el.innerHTML = opts.html;
    for (const [k, v] of Object.entries(opts)) {
        if (["className", "textContent", "html"].includes(k)) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
    }
    return el;
}

function ensureView(name, build) {
    if (views.has(name)) return views.get(name);
    const el = $el("div", { className: "by-page by-hidden" });
    view.appendChild(el);
    views.set(name, el);
    build(el);
    return el;
}

function showView(name) {
    for (const [key, el] of views) el.classList.toggle("by-hidden", key !== name);
    document.querySelectorAll(".by-tabs a").forEach(a =>
        a.classList.toggle("active", a.dataset.tab === name));
}

// ====== SSE 请求 helper ======
async function ssePost(url, body, logEl, onDone) {
    logEl.textContent = "";
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        logEl.textContent = `[ERROR] ${err.error || resp.statusText}`;
        logEl.classList.add("err");
        return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = JSON.parse(line.slice(6));
            if (payload.done) { onDone?.(); return; }
            if (payload.msg) {
                logEl.textContent += payload.msg;
                logEl.scrollTop = logEl.scrollHeight;
            }
        }
    }
    onDone?.();
}

// ====== 配置页 ======
const DIR_PRESETS = {
    source_dir: [
        ["gallery/presets/", "gallery/presets/" + t("（预设素材）")],
        ["gallery/character/", "gallery/character/" + t("（角色素材）")],
        ["gallery/grid/", "gallery/grid/" + t("（宫格素材）")],
    ],
    output_dir: [
        ["gallery/presets_dist/", "gallery/presets_dist/" + t("（预处理输出）")],
        ["gallery/character_dist/", "gallery/character_dist/" + t("（角色输出）")],
        ["gallery/grid_dist/", "gallery/grid_dist/" + t("（宫格输出）")],
    ],
};

// 密钥字段只回掩码，回填进输入框会让用户以为「已填好」，改一个字符提交又被服务端丢掉。
const SECRET_KEYS = new Set(["access_key_id", "access_key_secret"]);

function buildConfig(el) {
    const form = $el("div", { className: "by-form" });
    // 目录字段单独存：文本框自带 select() 方法，用 inputs[key].select 判目录字段会把
    // Access Key 框当目录框，解构出的 select 是函数、select.options 是 undefined。
    const inputs = {};
    const dirInputs = {};

    // 普通字段
    const plainFields = [
        ["access_key_id", "Access Key ID"],
        ["access_key_secret", "Access Key Secret"],
        ["endpoint", "Endpoint"],
        ["bucket", "Bucket"],
        ["prefix", t("Prefix (OSS 路径前缀)")],
    ];
    for (const [key, label] of plainFields) {
        const row = $el("div", { className: "by-form-row" });
        row.appendChild($el("label", { textContent: label }));
        const input = $el("input", { type: key === "access_key_secret" ? "password" : "text", placeholder: key });
        inputs[key] = input;
        row.appendChild(input);
        form.appendChild(row);
    }

    // 目录字段：下拉预设 + 自定义
    for (const [key, label] of [["source_dir", t("源目录（预设素材）")], ["output_dir", t("输出目录（预处理产物）")]]) {
        const row = $el("div", { className: "by-form-row" });
        row.appendChild($el("label", { textContent: label }));
        const select = $el("select", { className: "by-dir-select" });
        for (const [val, text] of DIR_PRESETS[key]) {
            select.appendChild($el("option", { value: val, textContent: text }));
        }
        const customOpt = $el("option", { value: "__custom__", textContent: t("自定义路径...") });
        select.appendChild(customOpt);
        const customInput = $el("input", { type: "text", placeholder: t("输入绝对路径"), className: "by-dir-custom" });
        customInput.style.display = "none";
        select.addEventListener("change", () => {
            customInput.style.display = select.value === "__custom__" ? "" : "none";
        });
        dirInputs[key] = { select, customInput };
        row.appendChild(select);
        row.appendChild(customInput);
        form.appendChild(row);
    }

    const btnRow = $el("div", { className: "by-form-row" });
    const saveBtn = $el("button", { className: "by-btn", textContent: t("保存配置") });
    const statusEl = $el("span", { className: "by-status" });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(statusEl);
    form.appendChild(btnRow);

    const section = $el("div", { className: "by-section" });
    section.appendChild($el("h3", { textContent: t("OSS 配置") }));
    section.appendChild(form);
    el.appendChild(section);

    function getDirValue(key) {
        const { select, customInput } = dirInputs[key];
        return select.value === "__custom__" ? customInput.value.trim() : select.value;
    }

    // 加载现有配置
    fetch("/neo_backyard/config").then(r => r.json()).then(data => {
        if (!data.success) return;
        for (const [key, val] of Object.entries(data.config)) {
            if (dirInputs[key]) {
                // 目录字段：匹配预设或设为自定义
                const { select, customInput } = dirInputs[key];
                const matched = Array.from(select.options).find(o => o.value === val);
                if (matched) {
                    select.value = val;
                } else {
                    select.value = "__custom__";
                    customInput.value = val || "";
                    customInput.style.display = "";
                }
            } else if (!inputs[key]) {
                continue;
            } else if (SECRET_KEYS.has(key)) {
                inputs[key].placeholder = val ? t("已保存（留空沿用）") : key;
            } else {
                inputs[key].value = val || "";
            }
        }
    });

    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        statusEl.textContent = t("保存中...");
        statusEl.className = "by-status";
        const body = {};
        for (const key of Object.keys(inputs)) body[key] = inputs[key].value;
        for (const key of Object.keys(dirInputs)) body[key] = getDirValue(key);
        try {
            const resp = await fetch("/neo_backyard/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (data.success) {
                statusEl.textContent = t("✓ 已保存");
                statusEl.className = "by-status ok";
                for (const key of SECRET_KEYS) {
                    if (data.config[key]) inputs[key].placeholder = t("已保存（留空沿用）");
                }
            } else {
                statusEl.textContent = `✗ ${data.error}`;
                statusEl.className = "by-status err";
            }
        } catch (e) {
            statusEl.textContent = `✗ ${e.message}`;
            statusEl.className = "by-status err";
        }
        saveBtn.disabled = false;
    });
}


// ====== 预处理页 ======
function buildPreprocess(el) {
    const section = $el("div", { className: "by-section" });
    section.appendChild($el("h3", { textContent: t("Gallery 预处理") }));

    // 目录信息（来自配置）
    const infoRow1 = $el("div", { className: "by-form-row" });
    const srcLabel = $el("span", { className: "by-dir-path-label", textContent: "" });
    infoRow1.appendChild($el("label", { textContent: t("源目录") }));
    infoRow1.appendChild(srcLabel);
    section.appendChild(infoRow1);

    const infoRow2 = $el("div", { className: "by-form-row" });
    const outLabel = $el("span", { className: "by-dir-path-label", textContent: "" });
    infoRow2.appendChild($el("label", { textContent: t("输出目录") }));
    infoRow2.appendChild(outLabel);
    section.appendChild(infoRow2);

    // 操作选项
    const form = $el("div", { className: "by-form" });
    const dirsInput = $el("input", { type: "text", placeholder: t("留空=全量扫描；填写=只处理这些子目录（空格分隔）") });
    const sizeInput = $el("input", { type: "number", value: "320", min: "64", max: "1024" });
    const copyCb = $el("input", { type: "checkbox", checked: "true" });

    const r_dirs = $el("div", { className: "by-form-row" });
    r_dirs.appendChild($el("label", { textContent: t("增量目录") }));
    r_dirs.appendChild(dirsInput);
    form.appendChild(r_dirs);

    const r3 = $el("div", { className: "by-form-row" });
    r3.appendChild($el("label", { textContent: t("缩略图尺寸") }));
    r3.appendChild(sizeInput);
    r3.appendChild($el("label", { textContent: t("拷贝媒体文件"), style: "min-width:auto;margin-left:16px;" }));
    r3.appendChild(copyCb);
    form.appendChild(r3);

    const btnRow = $el("div", { className: "by-form-row" });
    const runBtn = $el("button", { className: "by-btn", textContent: t("🚀 执行预处理") });
    btnRow.appendChild(runBtn);
    form.appendChild(btnRow);
    section.appendChild(form);

    const logEl = $el("div", { className: "by-log" });
    logEl.textContent = t("等待执行...");
    section.appendChild(logEl);
    el.appendChild(section);

    let sourceDir = "", outputDir = "";

    fetch("/neo_backyard/config").then(r => r.json()).then(data => {
        if (!data.success) return;
        sourceDir = data.config.source_dir || "";
        outputDir = data.config.output_dir || "";
        srcLabel.textContent = sourceDir || t("（未设置）");
        outLabel.textContent = outputDir || t("（未设置）");
    });

    runBtn.addEventListener("click", async () => {
        if (!sourceDir || !outputDir) { logEl.textContent = t("请先在配置页设置源目录和输出目录"); return; }
        runBtn.disabled = true;
        const dirs = dirsInput.value.trim();
        await ssePost("/neo_backyard/preprocess", {
            source_dir: sourceDir,
            output_dir: outputDir,
            size: parseInt(sizeInput.value) || 320,
            copy_media: copyCb.checked,
            dirs: dirs ? dirs.split(/\s+/) : null,
        }, logEl, () => { runBtn.disabled = false; });
    });
}


// ====== OSS 上传页 ======
function buildUpload(el) {
    const section = $el("div", { className: "by-section" });
    section.appendChild($el("h3", { textContent: t("OSS 上传") }));

    const infoRow = $el("div", { className: "by-form-row" });
    const pathLabel = $el("span", { className: "by-dir-path-label", textContent: "" });
    infoRow.appendChild($el("label", { textContent: t("上传源目录") }));
    infoRow.appendChild(pathLabel);
    section.appendChild(infoRow);

    const form = $el("div", { className: "by-form" });
    const dryCb = $el("input", { type: "checkbox" });
    const r2 = $el("div", { className: "by-form-row" });
    r2.appendChild($el("label", { textContent: t("Dry Run（只列出）"), style: "min-width:auto;" }));
    r2.appendChild(dryCb);
    form.appendChild(r2);

    const btnRow = $el("div", { className: "by-form-row" });
    const runBtn = $el("button", { className: "by-btn", textContent: t("📤 执行上传") });
    btnRow.appendChild(runBtn);
    form.appendChild(btnRow);
    section.appendChild(form);

    const logEl = $el("div", { className: "by-log" });
    logEl.textContent = t("等待执行...");
    section.appendChild(logEl);
    el.appendChild(section);

    let outputDir = "";

    fetch("/neo_backyard/config").then(r => r.json()).then(data => {
        if (!data.success) return;
        outputDir = data.config.output_dir || "";
        pathLabel.textContent = outputDir || t("（未设置）");
    });

    runBtn.addEventListener("click", async () => {
        if (!outputDir) { logEl.textContent = t("请先在配置页设置输出目录"); return; }
        runBtn.disabled = true;
        await ssePost("/neo_backyard/upload", {
            source_dir: outputDir,
            dry_run: dryCb.checked,
        }, logEl, () => { runBtn.disabled = false; });
    });
}


// ====== 目录管理页 ======
function buildManage(el) {
    const section = $el("div", { className: "by-section" });
    section.appendChild($el("h3", { textContent: t("Gallery 数据 & 文件管理") }));

    // --- OSS 数据概览 ---
    const indexEl = $el("div", { className: "by-index-summary" });
    section.appendChild(indexEl);

    // --- 文件管理 ---
    const fileHeader = $el("h4", { textContent: t("输出目录文件"), style: "margin:18px 0 8px;" });
    section.appendChild(fileHeader);

    const infoRow = $el("div", { className: "by-form-row" });
    const pathLabel = $el("span", { className: "by-dir-path-label", textContent: "" });
    const refreshBtn = $el("button", { className: "by-btn", textContent: t("🔄 刷新") });
    infoRow.appendChild($el("label", { textContent: t("输出目录") }));
    infoRow.appendChild(pathLabel);
    infoRow.appendChild(refreshBtn);
    section.appendChild(infoRow);

    const listEl = $el("div", { className: "by-dir-list" });
    section.appendChild(listEl);
    el.appendChild(section);

    let outputDir = "";

    async function loadIndex() {
        indexEl.innerHTML = `<div class="by-status">${t("加载索引...")}</div>`;
        try {
            const resp = await fetch("/neo_backyard/index");
            const data = await resp.json();
            if (!data.success) {
                indexEl.innerHTML = `<div class="by-status err">${data.error}</div>`;
                return;
            }
            if (!data.exists) {
                indexEl.innerHTML = `<div class="by-status">${t("尚无 index.json（未执行过预处理）")}</div>`;
                return;
            }
            indexEl.innerHTML = "";
            const summary = $el("div", { className: "by-index-stats" });
            summary.textContent = tf("📊 {dirs} 个目录 / {items} 个条目", { dirs: data.total_dirs, items: data.total_items }) +
                (data.base_url ? ` | ${data.base_url}` : "");
            indexEl.appendChild(summary);

            const dirList = $el("div", { className: "by-dir-list" });
            for (const [name, info] of Object.entries(data.directories)) {
                const item = $el("div", { className: "by-dir-item" });
                item.appendChild($el("span", { className: "by-dir-icon", textContent: "📁" }));
                item.appendChild($el("span", { className: "by-dir-name", textContent: name }));
                const meta = tf("{count} 项 ({images}🖼 {videos}🎬)", { count: info.count, images: info.images, videos: info.videos });
                item.appendChild($el("span", { className: "by-dir-meta", textContent: meta }));
                dirList.appendChild(item);
            }
            indexEl.appendChild(dirList);
        } catch (e) {
            indexEl.innerHTML = `<div class="by-status err">${e.message}</div>`;
        }
    }

    async function loadFiles() {
        if (!outputDir) {
            listEl.innerHTML = `<div class="by-status">${t("请先在配置页设置输出目录")}</div>`;
            return;
        }
        listEl.innerHTML = `<div class="by-status">${t("加载中...")}</div>`;
        try {
            const resp = await fetch(`/neo_backyard/dirs?path=${encodeURIComponent(outputDir)}`);
            const data = await resp.json();
            if (!data.success) {
                listEl.innerHTML = `<div class="by-status err">${data.error}</div>`;
                return;
            }
            listEl.innerHTML = "";
            for (const entry of data.entries) {
                const item = $el("div", { className: "by-dir-item" });
                item.appendChild($el("span", { className: "by-dir-icon", textContent: entry.is_dir ? "📁" : "📄" }));
                item.appendChild($el("span", { className: "by-dir-name", textContent: entry.name }));
                const meta = entry.is_dir ? tf("{n} 个文件", { n: entry.file_count }) : formatSize(entry.size);
                item.appendChild($el("span", { className: "by-dir-meta", textContent: meta }));
                const delBtn = $el("button", { className: "by-dir-del", textContent: "✕", title: t("删除") });
                delBtn.addEventListener("click", async () => {
                    if (!confirm(tf("确认删除 {name}？", { name: entry.name }))) return;
                    const resp = await fetch("/neo_backyard/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ output_dir: outputDir, name: entry.name }),
                    });
                    const result = await resp.json();
                    if (result.success) { loadFiles(); loadIndex(); }
                    else alert(result.error);
                });
                item.appendChild(delBtn);
                listEl.appendChild(item);
            }
        } catch (e) {
            listEl.innerHTML = `<div class="by-status err">${e.message}</div>`;
        }
    }

    refreshBtn.addEventListener("click", () => { loadFiles(); loadIndex(); });

    // 从配置读取输出目录，自动加载
    fetch("/neo_backyard/config").then(r => r.json()).then(data => {
        if (!data.success) return;
        outputDir = data.config.output_dir || "";
        pathLabel.textContent = outputDir || t("（未设置）");
        loadIndex();
        loadFiles();
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}


// ====== Hash 路由 ======
const tabBuilders = {
    config: buildConfig,
    preprocess: buildPreprocess,
    upload: buildUpload,
    manage: buildManage,
};

function route() {
    const hash = location.hash.slice(2) || "config";
    const name = tabBuilders[hash] ? hash : "config";
    ensureView(name, tabBuilders[name]);
    showView(name);
}

window.addEventListener("hashchange", route);
route();