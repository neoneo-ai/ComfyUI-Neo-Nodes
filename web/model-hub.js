/**
 * model-hub.js — 模型库（Comfy-Org 专区 · Hugging Face / ModelScope 双源）
 * 顶栏 🅝 → 📥 模型库：搜索仓库 → 文件清单（按 split_files 前缀自动归类 + 已存在标记）
 * → 流式下载（进度 / 速度 / 取消，.part 断点续传）。落盘子目录取类别目录下已有子目录成下拉
 * （默认自动探查，可选「＋ 新建子目录…」现填）。⚙ 面板管理默认源、HF 端点、两侧 Token、
 * LLM 子目录与超时。技能修复弹窗可用 openModelHub({ query, category }) 预填并定位下载目标。
 */
import { app } from "../../../../scripts/app.js";
import { showToast } from "./gallery-utils.js";

if (!document.getElementById("neo-hub-css")) {
    const link = document.createElement("link");
    link.id = "neo-hub-css";
    link.rel = "stylesheet";
    link.href = "/extensions/ComfyUI-Neo-Nodes/model-hub.css";
    document.head.appendChild(link);
}

const API = "/neo_model_hub";
const SOURCE_NAMES = { modelscope: "ModelScope", huggingface: "Hugging Face" };

let hub = null;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

async function req(path, body) {
    const resp = await fetch(API + path, body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
}

// ---------------------------------------------------------------------------
// 列表渲染
// ---------------------------------------------------------------------------

function sourceMark(entry) {
    if (entry.on_hf && entry.on_ms) return "双源";
    if (entry.on_ms) return "MS";
    if (entry.on_hf) return "HF";
    return "未探测";
}

function fillRepos(h) {
    const sel = h.ui.repoSel;
    sel.innerHTML = "";
    const byName = new Map(h.repos.map((r) => [r.repo, r]));
    const used = new Set();
    const addRepo = (parent, entry) => {
        const o = document.createElement("option");
        o.value = entry.repo;
        o.textContent = `${entry.repo}${entry.downloads ? ` · ${entry.downloads}` : ""} · ${sourceMark(entry)}`;
        parent.appendChild(o);
        used.add(entry.repo);
    };
    for (const group of h.registry.groups || []) {
        const members = (group.repos || []).map((name) => byName.get(name)).filter(Boolean);
        if (!members.length) continue;
        const grp = document.createElement("optgroup");
        grp.label = group.name || "分组";
        for (const entry of members) addRepo(grp, entry);
        sel.appendChild(grp);
    }
    const rest = h.repos.filter((r) => !used.has(r.repo));
    if (rest.length) {
        const grp = document.createElement("optgroup");
        grp.label = "其他";
        for (const entry of rest) addRepo(grp, entry);
        sel.appendChild(grp);
    }
    if (h.wantRepo && byName.has(h.wantRepo)) sel.value = h.wantRepo;
}

function fillCategories(h) {
    const sel = h.ui.catSel;
    sel.innerHTML = "";
    for (const c of h.categories) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        sel.appendChild(o);
    }
    if (h.wantCategory && h.categories.includes(h.wantCategory)) sel.value = h.wantCategory;
}

function fillFiles(h) {
    const sel = h.ui.fileList;
    sel.innerHTML = "";
    for (const f of h.files) {
        const o = document.createElement("option");
        o.value = f.path;
        o.dataset.category = f.category;
        o.dataset.filename = f.filename;
        o.dataset.existsSub = f.exists_sub || "";
        o.textContent = `${f.filename}  [${f.category}]  ${fmtSize(f.size)}${f.exists ? `  ✓ 已存在${f.exists_sub ? ` (${f.exists_sub})` : ""}` : ""}`;
        sel.appendChild(o);
    }
    updateTarget(h);
}

function selectedFile(h) {
    const opt = h.ui.fileList.selectedOptions[0];
    if (!opt || !opt.value) return null;
    return { path: opt.value, category: opt.dataset.category, filename: opt.dataset.filename,
             existsSub: opt.dataset.existsSub || "" };
}

function updateTarget(h) {
    const file = selectedFile(h);
    if (!file) { h.ui.destText.textContent = ""; return; }
    if (h.categories.includes(file.category)) h.ui.catSel.value = file.category;
    const sub = currentSubfolder(h).replace(/^\/+|\/+$/g, "");
    const repoPart = file.category === "llm" ? `${repoBaseName(h.ui.repoSel.value)}/` : "";
    h.ui.destText.textContent = `→ models/${h.ui.catSel.value}/${sub ? `${sub}/` : ""}${repoPart}${file.filename}`;
}

// ---------------------------------------------------------------------------
// 落盘子目录：已有目录成列表 + 默认自动探查 + 新建子目录
// ---------------------------------------------------------------------------

const NEW_SUB = "__new__";

function repoBaseName(repo) {
    const name = String(repo || "").replace(/\\/g, "/").split("/").pop();
    return name === "." || name === ".." ? "" : name;
}

function currentSubfolder(h) {
    return h.ui.subSel.value === NEW_SUB ? h.ui.subNew.value.trim() : h.ui.subSel.value;
}

function syncNewSub(h) {
    const isNew = h.ui.subSel.value === NEW_SUB;
    h.ui.subNew.style.display = isNew ? "" : "none";
    if (isNew) h.ui.subNew.focus();
}

function fillSubfolders(h, subs, def, prefer) {
    const sel = h.ui.subSel;
    sel.innerHTML = "";
    const add = (value, text) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
    };
    add("", "（根目录）");
    for (const s of subs) add(s, s);
    add(NEW_SUB, "＋ 新建子目录…");
    // 已存在文件所在子目录 > 探查默认 > 根目录
    if (prefer && !subs.includes(prefer)) add(prefer, prefer);
    sel.value = prefer && subs.includes(prefer) ? prefer : (subs.includes(def) ? def : "");
    syncNewSub(h);
}

async function loadSubfolders(h, prefer) {
    try {
        const data = await req("/subfolders", { category: h.ui.catSel.value, repo: h.ui.repoSel.value });
        fillSubfolders(h, data.subfolders || [], data.default || "", prefer || "");
    } catch (e) {
        fillSubfolders(h, [], "", prefer || "");
    }
    updateTarget(h);
}

/** 已存在文件所在的子目录：同模型同类别的文件通常同目录，点文件即跟随。 */
function selectedSub(h) {
    const file = selectedFile(h);
    if (!file || !file.existsSub) return "";
    let sub = file.existsSub;
    if (file.category === "llm") {
        const repo = repoBaseName(h.ui.repoSel.value);
        if (repo && (sub === repo || sub.startsWith(`${repo}/`))) sub = sub.slice(repo.length + 1);
    }
    return sub;
}

function applySubfolder(h, sub) {
    if (!sub) return;
    const sel = h.ui.subSel;
    if (![...sel.querySelectorAll("option")].some((o) => o.value === sub)) {
        const o = el("option", "", sub);
        o.value = sub;
        sel.appendChild(o);
    }
    sel.value = sub;
}


// ---------------------------------------------------------------------------
// 弹窗结构
// ---------------------------------------------------------------------------

function field(labelText, input) {
    const wrap = el("label", "neo-hub-field");
    wrap.append(el("span", "neo-hub-field-label", labelText), input);
    return wrap;
}

function buildUI(h) {
    const overlay = el("div", "neo-hub-overlay");
    const box = el("div", "neo-hub-box");

    const head = el("div", "neo-hub-head");
    const srcWrap = el("div", "neo-hub-src");
    const srcBtns = {};
    for (const [key, label] of Object.entries(SOURCE_NAMES)) {
        const b = el("button", "neo-hub-src-btn", label);
        b.type = "button";
        b.dataset.source = key;
        b.addEventListener("click", () => {
            if (h.source === key) return;
            h.source = key;
            syncSource(h);
            loadRepos(h, false);
        });
        srcBtns[key] = b;
        srcWrap.appendChild(b);
    }
    const refreshBtn = el("button", "neo-hub-icon-btn", "⟳");
    refreshBtn.type = "button";
    refreshBtn.title = "跳过缓存重新拉取仓库与文件清单";
    refreshBtn.addEventListener("click", () => loadRepos(h, true));
    const settingsBtn = el("button", "neo-hub-icon-btn", "⚙");
    settingsBtn.type = "button";
    settingsBtn.title = "模型库设置（源 / 端点 / Token / LLM 子目录 / 超时）";
    const closeBtn = el("button", "neo-hub-icon-btn", "✕");
    closeBtn.type = "button";
    head.append(el("span", "neo-hub-title", "📥 模型库 · Comfy-Org"), srcWrap, refreshBtn, settingsBtn, closeBtn);

    const searchRow = el("div", "neo-hub-row");
    const searchInput = el("input", "neo-hub-input neo-hub-search");
    searchInput.type = "text";
    searchInput.placeholder = "搜索仓库名（Comfy-Org 内子串匹配 + 跨组织搜索）";
    const searchBtn = el("button", "neo-hub-btn", "搜索");
    searchBtn.type = "button";
    searchBtn.addEventListener("click", () => loadRepos(h, false));
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadRepos(h, false); });
    searchRow.append(searchInput, searchBtn);

    const repoRow = el("div", "neo-hub-row");
    const repoSel = el("select", "neo-hub-input neo-hub-repo");
    const repoInfo = el("span", "neo-hub-info", "");
    repoRow.append(repoSel, repoInfo);

    const fileList = el("select", "neo-hub-input neo-hub-files");
    fileList.size = 8;

    const targetRow = el("div", "neo-hub-row");
    const catSel = el("select", "neo-hub-input neo-hub-cat");
    const subSel = el("select", "neo-hub-input neo-hub-sub");
    const subNew = el("input", "neo-hub-input neo-hub-sub-new");
    subNew.type = "text";
    subNew.placeholder = "新建子目录名（可含 / 分层）";
    subNew.style.display = "none";
    const destText = el("span", "neo-hub-info neo-hub-dest", "");
    targetRow.append(el("span", "neo-hub-label", "落盘类别"), catSel,
        el("span", "neo-hub-label", "子目录"), subSel, subNew, destText);

    const actRow = el("div", "neo-hub-row");
    const dlBtn = el("button", "neo-hub-btn neo-hub-dl", "⬇ 下载");
    dlBtn.type = "button";
    const cancelBtn = el("button", "neo-hub-btn neo-hub-cancel", "取消");
    cancelBtn.type = "button";
    cancelBtn.disabled = true;
    const statusText = el("span", "neo-hub-status", "空闲");
    actRow.append(dlBtn, cancelBtn, statusText);

    const bar = el("div", "neo-hub-bar");
    const barFill = el("i");
    bar.appendChild(barFill);
    const progText = el("div", "neo-hub-prog", "");

    const panel = el("div", "neo-hub-settings");
    panel.style.display = "none";
    const inputs = {};
    const mkInput = (key, label, type) => {
        const input = el("input", "neo-hub-input");
        input.type = type || "text";
        inputs[key] = input;
        panel.appendChild(field(label, input));
    };
    const srcSel = el("select", "neo-hub-input");
    for (const key of Object.keys(SOURCE_NAMES)) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = SOURCE_NAMES[key];
        srcSel.appendChild(o);
    }
    inputs.source = srcSel;
    panel.appendChild(field("默认下载源", srcSel));
    mkInput("hf_endpoint", "HF 端点（镜像站根地址）");
    mkInput("hf_token", "HF Token（受限仓库需要）", "password");
    mkInput("ms_token", "ModelScope Token（受限仓库下载用，可留空）", "password");
    mkInput("llm_subdir", "LLM 子目录（models/ 下，GGUF 落此处）");
    mkInput("timeout_total", "下载总超时（秒）", "number");
    mkInput("sock_read", "读超时（秒）", "number");
    const saveBtn = el("button", "neo-hub-btn neo-hub-save", "保存设置");
    saveBtn.type = "button";
    panel.appendChild(saveBtn);

    box.append(head, searchRow, repoRow, fileList, targetRow, actRow, bar, progText, panel);
    overlay.appendChild(box);

    h.ui = {
        srcBtns, repoSel, repoInfo, fileList, catSel, subSel, subNew, destText, dlBtn, cancelBtn,
        statusText, barFill, progText, panel, inputs, searchInput, settingsBtn, closeBtn,
    };
    return overlay;
}

function syncSource(h) {
    for (const [key, btn] of Object.entries(h.ui.srcBtns)) {
        btn.classList.toggle("neo-hub-src-active", key === h.source);
    }
}

function renderProgress(h, d) {
    const total = Number(d.total) || 0;
    const done = Number(d.done) || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    h.ui.barFill.style.width = `${pct.toFixed(1)}%`;
    h.ui.progText.textContent =
        `${pct.toFixed(1)}% · ${fmtSize(done)} / ${fmtSize(total)} · ${fmtSize(d.speed || 0)}/s`;
    h.ui.statusText.textContent = d.state === "running" ? `下载中：${d.filename}` : (d.state || "idle");
}

// ---------------------------------------------------------------------------
// 数据流
// ---------------------------------------------------------------------------

async function loadRepos(h, refresh) {
    h.ui.repoInfo.textContent = "仓库列表加载中…";
    try {
        const data = await req("/repos", {
            source: h.source, query: h.ui.searchInput.value.trim(), refresh: !!refresh,
        });
        h.repos = data.repos || [];
        fillRepos(h);
        h.ui.repoInfo.textContent = `${h.repos.length} 个仓库`;
        await loadFiles(h, !!refresh);
    } catch (e) {
        h.ui.repoInfo.textContent = "仓库列表加载失败";
        h.ui.fileList.innerHTML = "";
        showToast(app, "error", "仓库列表加载失败", String(e.message || e));
    }
}

async function loadFiles(h, refresh) {
    const repo = h.ui.repoSel.value;
    h.ui.fileList.innerHTML = "";
    h.ui.destText.textContent = "";
    if (!repo) return;
    h.ui.fileList.disabled = true;
    try {
        const data = await req("/files", { source: h.source, repo, refresh: !!refresh });
        h.files = data.files || [];
        if (data.categories && data.categories.length) { h.categories = data.categories; fillCategories(h); }
        fillFiles(h);
        await loadSubfolders(h);
    } catch (e) {
        const opt = document.createElement("option");
        opt.textContent = `文件清单加载失败：${e.message || e}`;
        h.ui.fileList.appendChild(opt);
        showToast(app, "error", "文件清单加载失败", String(e.message || e));
    } finally {
        h.ui.fileList.disabled = false;
    }
}

function fillSettingsForm(h, settings) {
    for (const [key, input] of Object.entries(h.ui.inputs)) {
        const value = settings[key];
        if (value === undefined || value === null) continue;
        input.value = input.type === "number" ? Number(value) : String(value);
    }
}

async function saveSettings(h) {
    const payload = {};
    for (const [key, input] of Object.entries(h.ui.inputs)) payload[key] = input.value;
    try {
        const data = await req("/settings", payload);
        fillSettingsForm(h, data.settings || {});
        h.source = (data.settings && data.settings.source) || h.source;
        syncSource(h);
        showToast(app, "success", "模型库设置已保存");
        await loadRepos(h, true);
    } catch (e) {
        showToast(app, "error", "设置保存失败", String(e.message || e));
    }
}

function stopPoll(h) {
    if (h.timer) clearInterval(h.timer);
    h.timer = null;
}

async function pollProgress(h) {
    let data;
    try {
        data = await req("/progress");
    } catch (e) {
        return;
    }
    const d = data.download || {};
    if (d.state === "running") {
        h.ui.cancelBtn.disabled = false;
        renderProgress(h, d);
        return;
    }
    stopPoll(h);
    h.ui.cancelBtn.disabled = true;
    h.ui.dlBtn.disabled = false;
    if (d.state === "done") {
        renderProgress(h, d);
        showToast(app, "success", "下载完成", `${d.category} / ${d.filename}`);
        loadFiles(h, true);
    } else if (d.state === "paused") {
        h.ui.statusText.textContent = d.error || "已取消（断点保留）";
        showToast(app, "info", "已取消", "断点已保留，再次下载同一文件可续传");
    } else if (d.state === "error") {
        h.ui.statusText.textContent = d.error || "下载失败";
        showToast(app, "error", "下载失败", d.error || "");
    }
}

function startPoll(h) {
    stopPoll(h);
    h.timer = setInterval(() => pollProgress(h), 800);
    pollProgress(h);
}

function bindActions(h) {
    h.ui.dlBtn.addEventListener("click", async () => {
        const file = selectedFile(h);
        if (!file) { showToast(app, "info", "未选择文件"); return; }
        h.ui.dlBtn.disabled = true;
        try {
            await req("/download", {
                source: h.source,
                repo: h.ui.repoSel.value,
                path: file.path,
                category: h.ui.catSel.value,
                subfolder: currentSubfolder(h),
                filename: file.filename,
            });
            startPoll(h);
        } catch (e) {
            h.ui.dlBtn.disabled = false;
            showToast(app, "error", "下载启动失败", String(e.message || e));
        }
    });
    h.ui.cancelBtn.addEventListener("click", async () => {
        h.ui.cancelBtn.disabled = true;
        try {
            await req("/cancel", {});
        } catch (e) {
            showToast(app, "error", "取消失败", String(e.message || e));
        }
    });
    h.ui.repoSel.addEventListener("change", () => loadFiles(h, false));
    h.ui.catSel.addEventListener("change", () => loadSubfolders(h));
    h.ui.fileList.addEventListener("change", () => {
        const prevCat = h.ui.catSel.value;
        updateTarget(h);
        const prefer = selectedSub(h);
        if (h.ui.catSel.value !== prevCat) { loadSubfolders(h, prefer); return; }
        applySubfolder(h, prefer);
        updateTarget(h);
    });
    h.ui.subSel.addEventListener("change", () => { syncNewSub(h); updateTarget(h); });
    h.ui.subNew.addEventListener("input", () => updateTarget(h));
    h.ui.settingsBtn.addEventListener("click", () => {
        h.ui.panel.style.display = h.ui.panel.style.display === "none" ? "block" : "none";
    });
    h.ui.panel.querySelector(".neo-hub-save").addEventListener("click", () => saveSettings(h));
    h.ui.closeBtn.addEventListener("click", closeModelHub);
}

async function loadSettings(h) {
    try {
        const data = await req("/settings");
        h.registry = data.registry || {};
        h.categories = data.categories || [];
        fillCategories(h);
        fillSettingsForm(h, data.settings || {});
        if (!h.wantSource) h.source = (data.settings && data.settings.source) || h.source;
        syncSource(h);
    } catch (e) {
        showToast(app, "error", "模型库设置读取失败", String(e.message || e));
    }
}

/**
 * 打开模型库弹窗。
 * @param {{query?: string, category?: string, source?: string, repo?: string}} opts
 *   query 预填搜索框；category 预选落盘类别；source 覆盖本次下载源；repo 预选仓库。
 */
export function openModelHub(opts = {}) {
    closeModelHub();
    const h = {
        source: opts.source || "modelscope", repos: [], files: [], registry: {}, categories: [],
        timer: null, ui: {}, wantCategory: opts.category || "", wantRepo: opts.repo || "",
        wantSource: opts.source || "",
    };
    const overlay = buildUI(h);
    h.overlay = overlay;
    hub = h;
    document.body.appendChild(overlay);
    bindActions(h);
    syncSource(h);
    if (opts.query) h.ui.searchInput.value = opts.query;
    loadSettings(h).then(() => loadRepos(h, false));
    return overlay;
}

export function closeModelHub() {
    if (!hub) return;
    stopPoll(hub);
    hub.overlay.remove();
    hub = null;
}
