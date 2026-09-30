/**
 * top-menu.js — 顶栏 🅝 菜单（插件统一入口）
 * 把插件入口收敛为顶栏一个动作按钮（🅝 图标），点击展开下拉菜单：
 *   🎬 Neo Studio / 🎥 新建导演配方 / 🧩 创建节点（子菜单，往画布添加各 Neo 节点）
 *   ⚙️ 设置（统一设置弹窗：LLM / 生图默认 / 生视频模型三 tab）
 *   🔧 修复工作流（右键 = 修复映射管理）/ 📜 修复记录 / ℹ️ 关于插件。
 * 修复红点提示由 workflow.js 的 setRepairHint 驱动，本模块只提供 .neo-n-menu-btn 按钮与样式。
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { showToast } from "./gallery-utils.js";
import { openDirectorEditor } from "./director.js";
import { createModelConfigForm } from "./llm-setting.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "./image-gen.js";
import { runRepair, showRepairLogDialog, showRepairMappingsDialog } from "./workflow.js";
import { openSkillManager } from "./skill.js";

const STUDIO_URL = "/neo-studio";
const REPO_URL = "https://github.com/neoneo-ai/ComfyUI-Neo-Nodes";
const TOOLTIP = "Neo Nodes — 🅝 菜单（Studio / 导演 / 建节点 / 设置 / 技能 / 修复 / 关于）";

// 创建节点子菜单：主节点；运行时按 LiteGraph.registeredNodes 过滤（模块加载失败自动隐藏）
// NeoH3SegmentRun 为内部节点（/neo_video_gen/run_segment 组装 prompt 用），不列进菜单
const NODE_ITEMS = [
    { type: "NeoPromptAgent", label: "⚡ Neo Prompt Agent（提示词智能体）" },
    { type: "NeoPromptEncoder", label: "📝 Neo Prompt Encoder（提示词编码器）" },
    { type: "NeoImageGenEdit", label: "🎨 Neo Image Gen & Edit（图像生成与编辑）" },
    { type: "NeoH3VideoDirector", label: "🎞️ Neo H3 Video Director（视频导演）" },
    { type: "NeoBundleExpand", label: "📦 Neo Bundle Expand（Bundle 展开）" },
    { type: "NeoRefGrid", label: "🔲 Neo Reference Grid（参考图宫格）" },
    { type: "NeoGridSplit", label: "🧩 Neo Grid Split（宫格图拆分）" },
];

let menuEl = null;
let _outsideHandler = null;
let _escHandler = null;
let _ctxMenuBound = false;
let _nodeCascade = 0;   // 连续建节点时的级联偏移，防重叠

function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("pointerdown", _outsideHandler, true);
    document.removeEventListener("keydown", _escHandler);
    _outsideHandler = null;
    _escHandler = null;
}

// 菜单项：点击后先收起菜单再执行动作
function menuItem(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "neo-n-menu-item";
    btn.textContent = label;
    btn.onclick = (e) => { e.stopPropagation(); closeMenu(); onClick(); };
    return btn;
}

function separator() {
    const sep = document.createElement("div");
    sep.className = "neo-n-menu-sep";
    return sep;
}

// 往画布创建节点：视口中心定位 + 级联偏移（canvasPosToGraph 换算同 image-gen.js）
function addNodeToCanvas(type) {
    const L = globalThis.LiteGraph;
    if (!L?.createNode) { showToast(app, "error", "无法创建节点", "LiteGraph 未就绪"); return; }
    if (!app.graph) { showToast(app, "info", "画布为空", "请先打开一个工作流"); return; }
    const node = L.createNode(type);
    app.graph.add(node);
    try {
        const cv = app.canvas;
        const cRect = cv?.canvas?.getBoundingClientRect?.() || { width: 0, height: 0 };
        const localX = cRect.width / 2 - (node.size?.[0] || 200) / 2 + _nodeCascade;
        const localY = cRect.height / 2 - 60 + _nodeCascade;
        node.pos = cv?.canvasPosToGraph ? cv.canvasPosToGraph([localX, localY]) : [localX, localY];
    } catch {
        node.pos = [200, 200];
    }
    _nodeCascade = (_nodeCascade + 24) % 240;
    app.graph.setDirtyCanvas(true);
}

function buildNodeSubmenu(subEl) {
    const L = globalThis.LiteGraph;
    for (const it of NODE_ITEMS) {
        if (L?.registeredNodes && !L.registeredNodes[it.type]) continue;   // 节点模块加载失败 → 隐藏该项
        subEl.appendChild(menuItem(it.label, () => addNodeToCanvas(it.type)));
    }
}

function showAboutDialog() {
    const existing = document.querySelector(".neo-n-about-dialog");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "neo-n-about-dialog";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10003;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:480px;max-width:92vw;display:flex;flex-direction:column;gap:10px;font-size:13px;";
    const close = () => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);

    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;font-size:15px;color:#8cf;";
    title.textContent = "ComfyUI-Neo-Nodes";
    box.appendChild(title);

    const verRow = document.createElement("div");
    verRow.style.cssText = "color:#999;font-size:12px;";
    verRow.textContent = "版本信息加载中…";
    box.appendChild(verRow);

    const srcRow = document.createElement("div");
    srcRow.style.cssText = "line-height:1.7;";
    const ghLink = document.createElement("a");
    ghLink.href = REPO_URL;
    ghLink.target = "_blank";
    ghLink.rel = "noopener";
    ghLink.style.cssText = "color:#60a5fa;text-decoration:none;";
    ghLink.textContent = REPO_URL;
    srcRow.append("源码：", ghLink);
    box.appendChild(srcRow);

    const installRow = document.createElement("div");
    installRow.style.cssText = "color:#bbb;line-height:1.7;white-space:pre-line;";
    installRow.textContent = "安装方式：\n· ComfyUI Manager 搜索 \"Neo Nodes\" 一键安装\n· 或 git clone 到 ComfyUI/custom_nodes/ 后重启";
    box.appendChild(installRow);

    const licRow = document.createElement("div");
    licRow.style.cssText = "color:#999;font-size:12px;";
    licRow.textContent = "License: Apache-2.0";
    box.appendChild(licRow);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = "align-self:flex-end;padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;background:#444;color:#ddd;";
    closeBtn.onclick = close;
    box.appendChild(closeBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // 版本信息（复用 Studio 版本端点）
    api.fetchApi("/neo_studio/version")
        .then((resp) => (resp.ok ? resp.json() : null))
        .then((data) => {
            if (!data?.success) return;
            verRow.textContent = `插件 v${data.plugin_version || "unknown"} · ComfyUI v${data.comfyui_version || "unknown"}`;
        })
        .catch(() => { verRow.textContent = "版本信息不可用"; });
}


// ---- 统一设置弹窗（全局单例，与具体节点无关）：LLM / 生图默认 / 生视频模型三 tab。
// 复用 .neo-director-llm-* 弹窗样式（recipes.css）与 .rs-auto-tabs tab 样式（prompts.css）。
// 打开即三个表单后台 load、全部落定前关闭不判脏；有未保存修改时 ✕/点遮罩/Esc 先出确认条
// （💾 保存并关闭 / 放弃修改 / 继续编辑）。幂等：已打开时重复调用不叠加。
let _settingsModal = null;

function openSettingsModal() {
    if (_settingsModal && !_settingsModal.parentNode) _settingsModal = null;   // 浮层已被清除（外部/测试重置 body）→ 丢弃过期状态
    if (_settingsModal) return;   // 已打开：忽略，避免叠加

    const forms = [
        { key: "llm", label: "🤖 LLM Settings", form: createModelConfigForm() },
        { key: "gen", label: "🖼️ 生图默认设置", form: createImageGenSettingsForm() },
        { key: "video", label: "🎬 生视频模型", form: createVideoGenSettingsForm() },
    ];
    const tabs = document.createElement("div");
    tabs.className = "rs-auto-tabs";
    for (const f of forms) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rs-auto-tab";
        btn.textContent = f.label;
        const panel = document.createElement("div");
        panel.className = "neo-settings-panel";
        panel.appendChild(f.form.el);
        f.btn = btn;
        f.panel = panel;
        tabs.appendChild(btn);
    }
    // 三张表单都常驻 DOM：切 tab 只切显隐，隐藏面板的输入值照常读写、不丢状态
    const setTab = (key) => {
        for (const f of forms) {
            f.btn.classList.toggle("rs-auto-tab-active", f.key === key);
            f.panel.style.display = f.key === key ? "" : "none";
        }
    };
    forms.forEach((f) => { f.btn.onclick = () => setTab(f.key); });
    setTab("llm");

    const saveCloseBtn = document.createElement("button");
    saveCloseBtn.type = "button";
    saveCloseBtn.className = "neo-director-llm-btn-save";
    saveCloseBtn.textContent = "💾 保存并关闭";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "neo-director-llm-btn-discard";
    discardBtn.textContent = "放弃修改";
    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "neo-director-llm-btn-keep";
    keepBtn.textContent = "继续编辑";
    const dirtyConfirm = document.createElement("div");
    dirtyConfirm.className = "neo-director-llm-dirty";
    dirtyConfirm.hidden = true;
    dirtyConfirm.append(
        Object.assign(document.createElement("span"), { textContent: "⚠ 有未保存的修改" }),
        (() => { const a = document.createElement("div"); a.className = "neo-director-llm-dirty-actions"; a.append(saveCloseBtn, discardBtn, keepBtn); return a; })(),
    );

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "neo-director-llm-close";
    closeBtn.title = "关闭（Esc）";
    closeBtn.textContent = "✕";
    const head = document.createElement("div");
    head.className = "neo-director-llm-head";
    head.append(Object.assign(document.createElement("span"), { textContent: "⚙️ 设置" }), closeBtn);
    const bodyEl = document.createElement("div");
    bodyEl.className = "neo-director-llm-body";
    bodyEl.append(tabs, ...forms.map((f) => f.panel));
    const panel = document.createElement("div");
    panel.className = "neo-director-llm-panel";
    panel.append(head, bodyEl, dirtyConfirm);
    const overlay = document.createElement("div");
    overlay.className = "neo-director-llm-overlay";
    overlay.appendChild(panel);

    let ready = false;   // load 全部落定前关闭不判脏（初始化回填不算用户改动）
    const hideConfirm = () => { dirtyConfirm.hidden = true; };
    const performClose = () => {
        hideConfirm();
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        _settingsModal = null;
    };
    const requestClose = () => {
        if (!ready) { performClose(); return; }
        if (forms.some((f) => f.form.isDirty())) { dirtyConfirm.hidden = false; return; }
        performClose();
    };
    closeBtn.onclick = (e) => { e.stopPropagation(); requestClose(); };
    overlay.onclick = (e) => { if (e.target === overlay) requestClose(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); requestClose(); } };

    saveCloseBtn.onclick = async () => {
        saveCloseBtn.disabled = true;
        const results = await Promise.all(forms.map((f) => f.form.save()));   // 保存失败留在弹窗重试
        saveCloseBtn.disabled = false;
        if (results.every(Boolean)) performClose();
    };
    discardBtn.onclick = () => performClose();
    keepBtn.onclick = () => hideConfirm();

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    Promise.all(forms.map((f) => f.form.load()))
        .catch(() => {})   // 单侧 load 失败不阻断就绪标记（表单内部已兜底记录）
        .then(() => { ready = true; });
    _settingsModal = overlay;
}

function openMenu(anchor) {
    if (menuEl) return;
    menuEl = document.createElement("div");
    menuEl.className = "neo-n-menu";

    menuEl.appendChild(menuItem("🎬 Neo Studio", () => window.open(STUDIO_URL, "_blank")));
    menuEl.appendChild(menuItem("🎥 新建导演配方", () => openDirectorEditor(null)));

    // 创建节点：手风琴子菜单（点击行展开/收起）
    const nodeRow = document.createElement("button");
    nodeRow.type = "button";
    nodeRow.className = "neo-n-menu-item neo-n-node-row";
    const nodeLabel = document.createElement("span");
    nodeLabel.textContent = "🧩 创建节点";
    const caret = document.createElement("span");
    caret.className = "neo-n-caret";
    caret.textContent = "▸";
    nodeRow.append(nodeLabel, caret);
    const subEl = document.createElement("div");
    subEl.className = "neo-n-submenu";
    subEl.style.display = "none";
    buildNodeSubmenu(subEl);
    nodeRow.onclick = (e) => {
        e.stopPropagation();
        const open = subEl.style.display !== "none";
        subEl.style.display = open ? "none" : "";
        nodeRow.classList.toggle("open", !open);
    };
    menuEl.append(nodeRow, subEl);

    menuEl.appendChild(menuItem("⚙️ 设置", openSettingsModal));
    menuEl.appendChild(menuItem("🗂 技能管理", openSkillManager));

    menuEl.appendChild(separator());
    const repairItem = menuItem("🔧 修复工作流", runRepair);
    repairItem.classList.add("neo-n-menu-item-repair");   // 右键 → 修复映射管理
    menuEl.appendChild(repairItem);
    menuEl.appendChild(menuItem("📜 修复记录", showRepairLogDialog));
    menuEl.appendChild(separator());
    menuEl.appendChild(menuItem("ℹ️ 关于插件", showAboutDialog));

    document.body.appendChild(menuEl);

    const rect = anchor.getBoundingClientRect();
    menuEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 250)) + "px";
    menuEl.style.top = (rect.bottom + 6) + "px";

    _outsideHandler = (e) => {
        if (!menuEl) return;
        // 点在菜单内或 🅝 按钮上（由 onClick 负责 toggle）→ 不关
        if (e.target instanceof Element && (menuEl.contains(e.target) || e.target.closest(".neo-n-menu-btn"))) return;
        closeMenu();
    };
    _escHandler = (e) => { if (e.key === "Escape") closeMenu(); };
    // 用 pointerdown 而非 mousedown：LiteGraph 画布 touch-action:none，pointerdown 上
    // preventDefault 会按规范抑制后续兼容鼠标事件，画布点击的 mousedown 到不了 document
    document.addEventListener("pointerdown", _outsideHandler, true);
    document.addEventListener("keydown", _escHandler);
}

app.registerExtension({
    name: "comfy.neo.topMenu",
    setup() {
        // 🅝 图标：前端把 icon 字段渲染为 <i class=...>，用 ::before 出 emoji 字符（构建期 Tailwind 不保证自定义类）
        const styleId = "neo-n-menu-style";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            style.textContent =
                // 🅝 胶囊按钮：图标放大 + “Neo” 文字标签（标签放 .neo-n-menu-icon::after，按钮 ::after 留给红点）
                ".neo-n-menu-icon{display:inline-flex;align-items:center;width:auto;height:auto;font-size:13px;line-height:1;color:#ddd;}" +
                ".neo-n-menu-icon::before{content:\"🅝\";display:inline-block;font-size:15px;line-height:1;}" +
                ".neo-n-menu-icon::after{content:\"Neo\";margin-left:6px;font-weight:600;letter-spacing:.3px;}" +
                ".neo-n-menu-btn{position:relative;display:flex;align-items:center;padding:4px 12px;border-radius:999px;background:#262626;border:1px solid #3a3a3a;transition:background .2s,border-color .2s,box-shadow .2s;}" +
                ".neo-n-menu-btn:hover{background:#2e2e2e;border-color:#4a4a4a;}" +
                // 修复红点提示（workflow.js setRepairHint 驱动）：红框 + 右上角红点
                ".neo-n-menu-btn.neo-repair-hint{border-color:var(--error-red,#f87171);box-shadow:0 0 0 1px rgba(248,113,113,.3);}" +
                ".neo-n-menu-btn.neo-repair-hint::after{content:\"\";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--error-red,#f87171);box-shadow:0 0 0 2px rgba(0,0,0,.25);}" +
                ".neo-n-menu{position:fixed;z-index:10002;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:8px;padding:6px;min-width:240px;box-shadow:0 8px 24px rgba(0,0,0,.5);}" +
                ".neo-n-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;background:transparent;color:#ddd;font-size:13px;text-align:left;border-radius:6px;cursor:pointer;}" +
                ".neo-n-menu-item:hover{background:#2a2a2a;color:#fff;}" +
                ".neo-n-caret{margin-left:auto;font-size:10px;color:#888;transition:transform .15s;}" +
                ".neo-n-node-row.open .neo-n-caret{transform:rotate(90deg);}" +
                ".neo-n-submenu{padding:2px 0 2px 14px;}" +
                ".neo-n-menu-sep{height:1px;background:#3a3a3a;margin:5px 8px;}";
            document.head.appendChild(style);
        }
        // 右键「🔧 修复工作流」菜单项 → 修复映射管理（actionBarButtons 是声明式渲染，按类名在 document 层拦截）
        if (!_ctxMenuBound) {
            _ctxMenuBound = true;
            document.addEventListener("contextmenu", (e) => {
                if (e.target instanceof Element && e.target.closest(".neo-n-menu-item-repair")) {
                    e.preventDefault();
                    showRepairMappingsDialog();
                }
            });
        }
    },
    actionBarButtons: [
        {
            icon: "neo-n-menu-icon size-5",
            tooltip: TOOLTIP,
            onClick: (e) => (menuEl ? closeMenu() : openMenu(e.currentTarget)),
            class: "neo-n-menu-btn",
        },
    ],
});

// 测试用：收起残留菜单
export function resetTopMenu() { closeMenu(); }
