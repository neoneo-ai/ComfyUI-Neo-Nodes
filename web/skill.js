/**
 * skill.js
 * Skill 模块（ES 模块：export API + UI；导入 marked/purify 用于 Markdown 渲染）
 * - API：listSkills / loadSkill / saveSkill / deleteSkill / uploadSkill
 *        listSkillFiles / loadSkillFile / saveSkillFile / deleteSkillFile
 * - UI ：createSkillDetailPopup()（单技能详情弹窗）+ createSkillDropdown()（技能下拉组装：管理入口 + 浮动预览卡）
 */

// Markdown 渲染复用 ComfyUI 内置同款库（marked + DOMPurify），breaks:true 保留单行换行
import "./marked.min.js";
import "./purify.min.js";
import { app } from "../../scripts/app.js";
import { attachComboBox } from "./combo-box.js";
import { mkEl } from "./dom-utils.js";
import { checkWorkflow, renderWorkflowGraph, applyWorkflowParams, validateWorkflow, injectRuntimeLoras } from "./workflow-graph.js";
// 仅事件回调内调用（复制补带 workflow/config、画布导出为生图技能、每技能生图设置、选择窗预览卡自动默认值）；与 image-gen.js 的循环导入均为延迟使用，安全
import { copySkillFiles, saveWorkflowSkill, getSkillGenConfig, saveSkillGenConfig, listGenModels, createModelConfigSection, createGenSizeRows, createVideoModelConfigSection, listVideoGenModels, shortModelName, videoSuggestion, videoAudioVaeSuggestion, videoVideoVaeSuggestion } from "./image-gen.js";
import { showToast } from "./gallery-utils.js";

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

/** 加载技能工作流模板（API prompt，/neo_image_gen/skill_workflow）；缺失返回 null */
async function loadSkillWorkflow(id) {
    try {
        const res = await fetch(`/neo_image_gen/skill_workflow?skill_id=${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return (data && data.workflow) || null;
    } catch (e) {
        console.error("Failed to load skill workflow:", e);
        return null;
    }
}

// 工作流模板预渲染的已知参数：设置显式值优先，空值回落自动建议模型（与设置区「自动」项一致）；
// 运行时变量（提示词/种子/参考图）不填。genInfo = { config, models }，来自设置区加载结果。
function workflowParamValues(isVideo, genInfo) {
    const cfg = (genInfo && genInfo.config) || {};
    const models = (genInfo && genInfo.models) || {};
    const values = {};
    if (isVideo) {
        values.MODEL = cfg.model || videoSuggestion(models.diffusion_models || []);
        values.TEXT_ENCODER = cfg.text_encoder || videoSuggestion(models.text_encoders || []);
        values.VAE = cfg.vae || videoVideoVaeSuggestion(models.vae || []);
        values.AUDIO_VAE = cfg.audio_vae || videoAudioVaeSuggestion(models.vae || []);
        values.STEPS = cfg.steps ?? 20;
        values.WIDTH = cfg.width ?? 1344;
        values.HEIGHT = cfg.height ?? 768;
        values.LENGTH = cfg.length ?? 124;
    } else {
        values.MODEL = cfg.model || models.suggested_diffusion_models;
        values.TEXT_ENCODER = cfg.text_encoder || models.suggested_text_encoders;
        values.VAE = cfg.vae || models.suggested_vae;
        values.COUNT = cfg.count ?? 1;
        values.PREFIX = cfg.output_prefix || "NeoAgent";
        const [w, h] = defaultSizeFromConfig(cfg);
        values.WIDTH = w;
        values.HEIGHT = h;
    }
    for (const [i, entry] of (cfg.loras || []).entries()) {
        const name = typeof entry === "string" ? entry : (entry && entry.name);
        if (!name) continue;
        values[`LORA_${i + 1}_NAME`] = name;
        values[`LORA_${i + 1}_STRENGTH`] = String(typeof entry === "string" ? 1.0 : (entry.strength ?? 1.0));
    }
    return values;
}

// 默认宽高：长边 base_resolution、比例 default_ratio（与后端 resolve_dimensions 一致，对齐 16）
function defaultSizeFromConfig(cfg) {
    const round16 = (v) => Math.max(16, Math.round(v / 16 + 0.5) * 16);
    const longSide = Math.max(256, parseInt(cfg.base_resolution, 10) || 1280);
    let ratio = 1.0;
    const text = String(cfg.default_ratio || "1:1").trim();
    const m = text.match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i);
    if (m && parseFloat(m[2]) > 0) ratio = parseFloat(m[1]) / parseFloat(m[2]);
    else { const f = parseFloat(text); if (f > 0) ratio = f; }
    return ratio >= 1.0 ? [round16(longSide), round16(longSide / ratio)] : [round16(longSide * ratio), round16(longSide)];
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

/** 预设技能生图/生视频设置恢复默认（删除本地覆盖文件） */
async function resetSkillGenConfig(id) {
    try {
        const res = await fetch("/rs_prompts/reset_skill_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to reset skill config:", e);
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
// image_gen / video_gen 生成类排最前（仅次于 select 顶部的「默认」项，原生 option 恒在 optgroup 之前），
// 图像/视频提示词增强紧随其后，vision/task/custom 依次跟随；未知分类回落 image_enhance
const CATEGORY_LABELS = {
    "image_gen": { label: "🖼️ 生图 (Krea2)", order: 0 },
    "video_gen": { label: "🎬 生视频 (H3)", order: 1 },
    "image_enhance": { label: "🎨 图像提示词增强", order: 2 },
    "video_enhance": { label: "🎬 视频提示词增强", order: 3 },
    "vision": { label: "⚡ 图像 / 反推", order: 4 },
    "task": { label: "⚙️ 任务", order: 5 },
    "custom": { label: "📝 自定义", order: 6 }
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
            // 生图 skill 元数据：genImage 走后端生图分支，
            // requiresRef 标记四视图（必须带参考图，缺图在预览区底部报错）
            opt.dataset.genImage = s.gen_image ? "1" : "";
            opt.dataset.requiresRef = s.requires_ref ? "1" : "";
            // tags（含后端追加的中文拼音/首字母缩写）供 combo box 搜索匹配
            opt.dataset.tags = (s.tags || []).join(" ");
            opt.__skillMeta = s; // 完整元数据（gen_config / 分类 / 名称）供浮动预览卡读取
            const imgBadge = s.needs_image ? "📷 " : "";
            opt.textContent = `${imgBadge}${s.name || s.id}`;
            optgroup.appendChild(opt);
        });
        selectEl.appendChild(optgroup);
    });
}

// ==========================================
// 节点级 Skill 有效性检测：选完 skill 后在节点底部提前提示「缺模型/缺节点」，可一键进详情修复
// - 节点的 skill 下拉 value 是技能「名称」（见 image_gen_edit/h3_video_gen 的 schema；旧工作流可能存的是
//   目录名/id）→ resolveSkillId 按与后端 _resolve_skill_id 同规则反查真实 skill，再取模板校验。
// - validateSkillForNode(skill, isVideo)：复用 checkWorkflow（对照 /object_info + /models/*），
//   只检测带 workflow.json 的生图/生视频 skill；结果按 (类型 + 真实 skill) 会话级缓存（TTL）+ 在途去重，检测失败不误报。
// - createSkillStatusRow({ getSkills, isVideo })：节点底部状态条 DOM 工厂（无问题隐藏、不占高），
//   聚合多个 skill 的缺失项显示「N 个模型缺失 · M 个节点未安装 → 查看详情/修复」，点击打开首个有问题的 skill 详情。
// - openSkillDetailById(skillId)：按 id 解析 source 后打开单技能详情弹窗（供节点状态条复用）。
// ==========================================

const SKILL_VALIDATION_TTL = 60_000; // 检测结果会话级缓存有效期（模型/节点可用性极少变化，过期自动重检）
const _skillValidationCache = new Map();    // key(类型: skill) -> { t, data }
const _skillValidationInflight = new Map(); // key -> Promise
let _skillNameLookup = { image: { t: 0, map: null }, video: { t: 0, map: null } }; // 技能名称 → 真实 skill（按生图/生视频各自建表）

const SKILL_CHANGED_EVENT = "neo.skillChanged"; // 详情弹窗保存/修复后派发，节点状态条据此即时重检
function dispatchSkillChanged(skillId) {
    window.dispatchEvent(new CustomEvent(SKILL_CHANGED_EVENT, { detail: { skillId: String(skillId || "") } }));
}

/** 把节点下拉的 skill 名称（或旧工作流里存的 id）解析成真实 skill；名称表不可用时原样返回（按 id 兜底）。
 *  与后端 _resolve_skill_id 同规则：只认带 workflow.json 的同类型技能（名称取列表最后一个同名项），
 *  下拉 value 就是技能名称，所以校验前必须先反查，否则 /neo_image_gen/skill_workflow 拿不到模板。 */
async function resolveSkillId(skill, isVideo) {
    const ref = String(skill || "").trim();
    if (!ref) return "";
    const entry = _skillNameLookup[isVideo ? "video" : "image"];
    if (!entry.map || Date.now() - entry.t > SKILL_VALIDATION_TTL) {
        const list = await listSkills();
        const map = new Map();
        for (const s of Array.isArray(list) ? list : []) {
            if (s && s.id && (isVideo ? s.gen_video : s.gen_image)) map.set(String(s.name || s.id), s.id);
        }
        if (map.size) { entry.map = map; entry.t = Date.now(); }
    }
    return (entry.map && entry.map.get(ref)) || ref;
}

/** 全量失效：技能可能已改名/新增/修复 → 下次重新反查名称并重校验（缓存很小，整体清比按名逐条准）。 */
function invalidateSkillValidation() {
    _skillValidationCache.clear();
    _skillNameLookup.image.t = 0;
    _skillNameLookup.video.t = 0;
}

/** 检测某个生图/生视频 skill（下拉里是技能名称，旧工作流可能是目录名/id）在本机是否可用（缺模型/缺节点）。
 *  返回 { ok, id, noWorkflow, missingNodes:[], missingModels:[] }，id 为反查出的真实 skill（供打开详情用）。 */
async function validateSkillForNode(skill, isVideo) {
    const id = await resolveSkillId(skill, isVideo);
    if (!id) return { ok: true, id: "", empty: true, missingNodes: [], missingModels: [] };
    const key = (isVideo ? "vid:" : "img:") + id;
    const hit = _skillValidationCache.get(key);
    if (hit && Date.now() - hit.t < SKILL_VALIDATION_TTL) return hit.data;
    if (_skillValidationInflight.has(key)) return _skillValidationInflight.get(key);

    const p = (async () => {
        let data;
        try {
            const workflow = await loadSkillWorkflow(id);
            if (!workflow) {
                data = { ok: true, id, noWorkflow: true, missingNodes: [], missingModels: [] }; // 无 workflow.json → 无模型依赖可查
            } else {
                const [config, models] = await Promise.all([
                    getSkillGenConfig(id).catch(() => ({})),
                    (isVideo ? listVideoGenModels() : listGenModels()).catch(() => ({})),
                ]);
                const cfg = config || {};
                const genInfo = { config: cfg, models: models || {} };
                const rendered = applyWorkflowParams(injectRuntimeLoras(workflow, cfg.loras), workflowParamValues(isVideo, genInfo));
                const validation = await checkWorkflow(rendered);
                const c = validation.counts || {};
                const missingNodes = [], missingModels = [];
                for (const list of Object.values(validation.issues || {})) {
                    for (const i of list) {
                        if (i.kind === "missing_node" && i.value && !missingNodes.includes(i.value)) missingNodes.push(i.value);
                        else if (i.kind === "missing_model" && i.value && !missingModels.includes(i.value)) missingModels.push(i.value);
                    }
                }
                data = { ok: !(c.missingNodes || 0) && !(c.missingModels || 0), id, noWorkflow: false, missingNodes, missingModels };
            }
        } catch (e) {
            console.warn("[Neo Nodes] validateSkillForNode failed", e);
            data = { ok: true, id, noWorkflow: false, error: String(e), missingNodes: [], missingModels: [] }; // 检测失败不误报
        }
        _skillValidationCache.set(key, { t: Date.now(), data });
        return data;
    })();
    _skillValidationInflight.set(key, p);
    try { return await p; } finally { _skillValidationInflight.delete(key); }
}

/** 按 id 解析 source 后打开单技能详情弹窗（跨节点单例）。 */
async function openSkillDetailById(skillId) {
    const id = String(skillId || "").trim();
    if (!id) return;
    let source = "custom";
    try {
        const list = await listSkills();
        const hit = (list || []).find((s) => s.id === id);
        if (hit && hit.source) source = hit.source;
    } catch (_) {}
    getSkillDetailPopup().openExisting(id, source);
}

/** 节点底部 Skill 有效性状态条：返回 { el, refresh, destroy }。getSkills() 返回要检测的 skill 引用（下拉 value
 *  即技能名称，旧工作流可能是目录名/id），内部先反查真实 skill 再校验（重复项去重）。
 *  无问题/无 workflow 时隐藏（不占高），有缺失显示聚合告警并可点开首个有问题的 skill 详情；节点移除时调 destroy() 注销监听。 */
function createSkillStatusRow(opts) {
    const isVideo = !!opts.isVideo;
    const getSkills = opts.getSkills || (() => []);
    const el = document.createElement("div");
    el.className = "neo-skill-status";
    el.style.display = "none";

    let seq = 0;
    let currentKey = "";

    function render(agg) {
        el.innerHTML = "";
        const show = agg && agg.hasWorkflow && ((agg.missingModels || []).length || (agg.missingNodes || []).length);
        if (!show) { el.style.display = "none"; return; }
        el.style.display = "";
        el.classList.add("neo-skill-status-warn");
        const parts = [];
        if (agg.missingModels.length) parts.push(`${agg.missingModels.length} 个模型缺失`);
        if (agg.missingNodes.length) parts.push(`${agg.missingNodes.length} 个节点未安装`);
        const label = document.createElement("span");
        label.className = "neo-skill-status-label";
        label.textContent = "⚠️ " + parts.join(" · ");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-skill-status-open";
        btn.textContent = "查看详情/修复 →";
        btn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
        btn.addEventListener("click", (e) => { e.stopPropagation(); openSkillDetailById(agg.firstBadId); });
        el.append(label, btn);
    }

    const refresh = async (force = false) => {
        const s = ++seq;
        const skills = [...new Set((getSkills() || []).map((v) => String(v || "").trim()).filter(Boolean))];
        currentKey = skills.join("\u0000");
        if (!skills.length) { render({ hasWorkflow: false }); return; }
        if (force) invalidateSkillValidation(); // 事件（保存/修复/改名）后全量失效，重新反查名称与校验
        render(null); // 检测中先清旧告警，避免闪现过期红条
        const missingModels = [], missingNodes = [];
        let hasWorkflow = false, firstBadId = null;
        for (const skill of skills) { // 顺序检测：把 /object_info·/models/* 的并发压到 1，同 skill 由在途去重兜住
            const d = await validateSkillForNode(skill, isVideo);
            if (d.noWorkflow) continue;
            hasWorkflow = true;
            for (const v of d.missingModels || []) if (!missingModels.includes(v)) missingModels.push(v);
            for (const v of d.missingNodes || []) if (!missingNodes.includes(v)) missingNodes.push(v);
            if (!firstBadId && ((d.missingModels || []).length || (d.missingNodes || []).length)) firstBadId = d.id;
        }
        if (s === seq && currentKey === skills.join("\u0000")) render({ hasWorkflow, missingModels, missingNodes, firstBadId });
    };

    // 整行不触发节点拖拽/选中；详情弹窗保存/修复后即时重检（force 绕过缓存）
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    const onSkillChanged = () => refresh(true);
    window.addEventListener(SKILL_CHANGED_EVENT, onSkillChanged);
    const destroy = () => window.removeEventListener(SKILL_CHANGED_EVENT, onSkillChanged);

    return { el, refresh, destroy };
}

// ==========================================
// UI：createSkillDetailPopup() —— 单技能详情弹窗（查看 / 编辑 / 删除 / 复制为自定义 / 新建）
// 由技能下拉的行内操作与底部工具栏打开；overlay 挂到 document.body，跨节点共享一个实例。
// 返回 { overlay, openExisting(id, source), openNew(), close }。
// ==========================================

function createSkillDetailPopup() {
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-detail");

    // ---- 头部：标题 + 来源徽标 + Copy as custom + 关闭 ----
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = "📝 Skill";
    const sourceBadge = mkEl("span", "rs-source-badge rs-skill-detail-badge");
    header.append(titleSpan, sourceBadge);
    // Copy as custom 放标题栏（仅预设/任务技能显示），在 ✕ 左侧
    const copyBtn = mkEl("button", "rs-btn rs-btn-local");
    copyBtn.type = "button";
    copyBtn.textContent = "⧉ Copy as custom";
    copyBtn.title = "Copy this built-in skill into a new editable custom skill";
    copyBtn.style.display = "none";
    const closeBtn = mkEl("button", "rs-skill-modal-close");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.append(copyBtn, closeBtn);

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
    // Enhance Prompt 开关（仅生图技能显示）：LLM 提示词增强，指令即上方正文；放在标题右侧便于就近理解
    const enhancePromptWrap = mkEl("div", "rs-content-enhance");
    enhancePromptWrap.style.display = "none";
    const enhancePromptChk = document.createElement("input");
    enhancePromptChk.type = "checkbox";
    enhancePromptChk.className = "rs-gen-enhance-chk";
    const enhancePromptLabel = mkEl("label", "rs-form-label");
    enhancePromptLabel.textContent = "Enhance Prompt";
    enhancePromptLabel.title = "使用 LLM 自动扩写生图提示词（指令即上方正文，需已配置 LLM）";
    enhancePromptWrap.append(enhancePromptChk, enhancePromptLabel);
    contentLeft.appendChild(enhancePromptWrap);
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

    // ---- 生图设置（仅 gen_image 技能显示）：复用全局生图设置的共享控件区，读写该技能的 config.json 覆盖 ----
    const genSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-gen-settings");
    genSettingsWrap.style.display = "none";
    const genSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const genSettingsTitle = mkEl("label", "rs-form-label");
    genSettingsTitle.textContent = "🖼️ 生图设置（优先于默认设置）";
    genSettingsTitle.title = "仅对本技能生效，未填项回落全局生图设置";
    const genLocalHint = mkEl("span", "rs-gen-readonly-hint");
    genLocalHint.textContent = "预设的设置改动保存为本地覆盖，不修改预设文件";
    genLocalHint.title = "模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除";
    genLocalHint.style.display = "none";
    const genSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    genSaveCfgBtn.type = "button";
    genSaveCfgBtn.textContent = "💾 Save";
    genSaveCfgBtn.title = "保存本技能生图设置（预设技能存为本地覆盖）";
    genSaveCfgBtn.style.display = "none";
    const genRestoreCfgBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    genRestoreCfgBtn.type = "button";
    genRestoreCfgBtn.textContent = "↺ 恢复默认";
    genRestoreCfgBtn.title = "清除本技能本地覆盖设置，恢复预设默认值";
    genRestoreCfgBtn.style.display = "none";
    const genCfgBtns = mkEl("div", "rs-gen-cfg-btns");
    genCfgBtns.append(genSaveCfgBtn, genRestoreCfgBtn);
    genSettingsHeader.append(genSettingsTitle, genLocalHint, genCfgBtns);
    const genModelSection = createModelConfigSection();
    const genSizeSection = createGenSizeRows();
    // Text Encoder / VAE / 生图张数 / 输出前缀 很少改动：收进可折叠「高级选项」（默认收起），放到最底部
    // 可折叠「高级选项」组（默认收起）：勾选开头复选框展开、取消勾选收起；点标题其余部分不触发（防误点）。纯原生 checkbox + CSS :checked，无 JS 逻辑
    function makeAdvGroup(label) {
        const adv = mkEl("div", "rs-gen-advanced");
        const chk = mkEl("input", "rs-gen-adv-check");
        chk.type = "checkbox";
        chk.setAttribute("aria-label", label);
        const lbl = mkEl("span", "rs-gen-adv-label");
        lbl.textContent = label;
        const advContent = mkEl("div", "rs-gen-adv-content");
        adv.append(chk, lbl, advContent);
        return { adv, content: advContent };
    }
    let advEl = null;
    {
        const advRows = [
            ...genModelSection.el.querySelectorAll(".rs-gen-adv-row"),
            ...genSizeSection.el.querySelectorAll(".rs-gen-adv-row"),
        ];
        if (advRows.length) {
            const g = makeAdvGroup("Text Encoder / VAE / 生图张数 / 输出前缀（高级）");
            for (const r of advRows) g.content.appendChild(r);
            advEl = g.adv;
        }
    }
    genSettingsWrap.append(genSettingsHeader, genModelSection.el, genSizeSection.el);
    if (advEl) genSettingsWrap.appendChild(advEl);

    // ---- 生视频设置（仅 gen_video 技能显示）：读写该技能 config.json 覆盖（model/text_encoder/vae/audio_vae），未填项回落全局「生视频模型」----
    const videoGenSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-video-gen-settings");
    videoGenSettingsWrap.style.display = "none";
    const videoGenSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const videoGenSettingsTitle = mkEl("label", "rs-form-label");
    videoGenSettingsTitle.textContent = "🎬 生视频设置（优先于默认设置）";
    videoGenSettingsTitle.title = "仅对本技能生效，未填项回落全局「生视频模型」设置";
    const videoLocalHint = mkEl("span", "rs-gen-readonly-hint");
    videoLocalHint.textContent = "预设的设置改动保存为本地覆盖，不修改预设文件";
    videoLocalHint.title = "模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除";
    videoLocalHint.style.display = "none";
    const videoSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    videoSaveCfgBtn.type = "button";
    videoSaveCfgBtn.textContent = "💾 Save";
    videoSaveCfgBtn.title = "保存本技能生视频设置（预设技能存为本地覆盖）";
    videoSaveCfgBtn.style.display = "none";
    const videoRestoreCfgBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    videoRestoreCfgBtn.type = "button";
    videoRestoreCfgBtn.textContent = "↺ 恢复默认";
    videoRestoreCfgBtn.title = "清除本技能本地覆盖设置，恢复预设默认值";
    videoRestoreCfgBtn.style.display = "none";
    const videoCfgBtns = mkEl("div", "rs-gen-cfg-btns");
    videoCfgBtns.append(videoSaveCfgBtn, videoRestoreCfgBtn);
    videoGenSettingsHeader.append(videoGenSettingsTitle, videoLocalHint, videoCfgBtns);
    const videoModelSection = createVideoModelConfigSection();
    // Text Encoder / VAE（视频）/ VAE（音频）很少改动：收进可折叠「高级选项」（默认收起），放到最底部
    let videoAdvEl = null;
    {
        const advRows = [...videoModelSection.el.querySelectorAll(".rs-gen-adv-row")];
        if (advRows.length) {
            const g = makeAdvGroup("Text Encoder / VAE（视频）/ VAE（音频）（高级）");
            for (const r of advRows) g.content.appendChild(r);
            videoAdvEl = g.adv;
        }
    }
    videoGenSettingsWrap.append(videoGenSettingsHeader, videoModelSection.el);
    if (videoAdvEl) videoGenSettingsWrap.appendChild(videoAdvEl);

    // ---- 工作流流程图（仅 gen_image/gen_video 技能显示）：workflow.json 模板自动布局为只读 SVG，
    //      红框 = 节点未安装/模型缺失，蓝框 = 含 {{模板变量}}；无 workflow.json 时隐藏
    const workflowWrap = mkEl("div", "rs-skill-workflow");
    workflowWrap.style.display = "none";
    const workflowHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const workflowTitle = mkEl("label", "rs-form-label");
    workflowTitle.textContent = "🔀 工作流（节点流程图）";
    workflowTitle.title = "技能 workflow.json 模板的自动布局；红框 = 节点未安装/模型缺失，蓝框 = 含待替换模板变量";
    const workflowBody = mkEl("div", "rs-wf-body");
    const workflowSummary = mkEl("div", "rs-wf-summary");
    workflowHeader.appendChild(workflowTitle);
    workflowWrap.append(workflowHeader, workflowBody, workflowSummary);

    // 失效模型路径修复：复用后端 /neo_nodes/skill_model_suggest（与工作流修复同款 match_model_file），
    // 弹窗列出 config 里所有失效字段与候选/置信度，批量套用后回填对应设置区，用户再点 Save 写入 config.json。
    // 「🔧 修复失效路径」+「📋 修复记录」并排放在各设置区头部（随 gen/video 设置区显隐）。config.json 恒可编辑（模型路径因机器而异、无统一预设），设置区无只读态。
    let genRepairBtn = null, videoRepairBtn = null;   // 各设置区「修复」按钮引用：检测/应用后切换红框+右上角红点告警态
    const makeSectionRepairBtns = () => {
        const group = mkEl("div", "rs-model-repair-group");
        const repairBtn = mkEl("button", "rs-btn rs-model-repair-btn");
        repairBtn.type = "button";
        repairBtn.textContent = "🔧 修复失效路径";
        repairBtn.title = "检测本技能 config 里失效的模型路径，给出候选并批量套用（复用工作流修复匹配）";
        repairBtn.addEventListener("click", (e) => { e.stopPropagation(); openModelRepairDialog(); });
        const logBtn = mkEl("button", "rs-btn rs-model-repair-log-btn");
        logBtn.type = "button";
        logBtn.textContent = "📋 修复记录";
        logBtn.title = "查看本技能的模型路径修复历史（本机本地记录）";
        logBtn.addEventListener("click", (e) => { e.stopPropagation(); openSkillRepairLogDialog(); });
        group.append(repairBtn, logBtn);
        return { group, repairBtn };
    };
    const genRepairGroup = makeSectionRepairBtns();
    genSettingsHeader.appendChild(genRepairGroup.group);
    const videoRepairGroup = makeSectionRepairBtns();
    videoGenSettingsHeader.appendChild(videoRepairGroup.group);
    genRepairBtn = genRepairGroup.repairBtn;
    videoRepairBtn = videoRepairGroup.repairBtn;

    // 当前活动设置区（生图/生视频互斥）的上下文：section、对应「修复」按钮、collect() 出的 config。
    // 「修复失效路径」弹窗与告警检测都基于它，保证用的是当前显示区的最新值而非最近 load 的快照。
    const activeRepairContext = () => {
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        return {
            section: isVideo ? videoModelSection : genModelSection,
            btn: isVideo ? videoRepairBtn : genRepairBtn,
            config: isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() },
        };
    };
    const setRepairAlert = (btn, on) => { if (btn) btn.classList.toggle("rs-alert", !!on); };
    function countMissingFields(fields) {
        if (!fields || typeof fields !== "object") return 0;
        let n = 0;
        for (const k of ["model", "text_encoder", "vae", "audio_vae"]) if (fields[k] && fields[k].status === "missing") n++;
        for (const l of fields.loras || []) if (l.status === "missing") n++;
        return n;
    }

    // 设置区头部「💾 Save / ↺ 恢复默认」与本地覆盖提示的显隐（仅预设；恢复仅在存在覆盖时显示）
    // 检测当前活动设置区是否有失效模型路径 → 「修复」按钮红框+右上角红点；无缺失则清除。
    // 打开/重载技能、应用修复后调用；异步结果按「技能未切换且该区仍显示」校验，避免过期覆盖。
    async function checkRepairStatus() {
        const ctx = activeRepairContext();
        if (!ctx.btn) return;
        const idAtStart = currentSkillId;
        if (!idAtStart) { setRepairAlert(ctx.btn, false); return; }
        let missing = 0;
        try {
            const resp = await fetch("/neo_nodes/skill_model_suggest", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config: ctx.config }),
            });
            const data = await resp.json();
            if (data && data.success) missing = countMissingFields(data.fields);
        } catch (e) { /* 检测失败不告警，保持现状 */ }
        if (currentSkillId === idAtStart && ctx.btn === activeRepairContext().btn) setRepairAlert(ctx.btn, missing > 0);
    }

    // ---- 修复记录（localStorage，按技能 id 关联，新→旧，每技能上限 SKILL_REPAIR_LOG_LIMIT 条）----
    const SKILL_REPAIR_LOG_KEY = "neo.skillRepairLog";
    const SKILL_REPAIR_LOG_LIMIT = 50;
    function readSkillRepairLog() {
        try { const l = JSON.parse(localStorage.getItem(SKILL_REPAIR_LOG_KEY) || "[]"); return Array.isArray(l) ? l : []; } catch (e) { return []; }
    }
    function writeSkillRepairLog(log) {
        try { localStorage.setItem(SKILL_REPAIR_LOG_KEY, JSON.stringify(log)); } catch (e) { console.warn("[Neo Skill] 修复记录写入失败:", e); }
    }
    function getSkillRepairLog(skillId) { return readSkillRepairLog().filter((e) => e.skillId === skillId); }
    function clearSkillRepairLog(skillId) { writeSkillRepairLog(readSkillRepairLog().filter((e) => e.skillId !== skillId)); }
    function recordSkillRepair(skillId, changes, kind) {
        const log = readSkillRepairLog();
        const mine = log.filter((e) => e.skillId === skillId);
        const others = log.filter((e) => e.skillId !== skillId);
        mine.unshift({ skillId, time: new Date().toISOString(), kind: kind || "gen_image", changes });
        writeSkillRepairLog([...mine.slice(0, SKILL_REPAIR_LOG_LIMIT), ...others]);
    }

    // 修复记录弹窗：列出本技能历史修复（时间·类型 + 每处 from→to），可清空；纯本地，不影响 config.json
    function openSkillRepairLogDialog() {
        if (!currentSkillId) return;
        const existing = document.querySelector(".rs-skill-repair-log-overlay");
        if (existing) existing.remove();
        const log = getSkillRepairLog(currentSkillId);
        const overlay = mkEl("div", "rs-repair-overlay rs-skill-repair-log-overlay");
        const box = mkEl("div", "rs-repair-box");
        const head = mkEl("div", "rs-repair-head");
        const title = mkEl("span", "");
        title.textContent = `修复记录（${log.length}）`;
        const closeBtn = mkEl("button", "rs-repair-close");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        head.append(title, closeBtn);
        const body = mkEl("div", "rs-repair-body");
        if (!log.length) {
            const empty = mkEl("div", "rs-repair-log-empty");
            empty.textContent = "本技能暂无修复记录 — 点「🔧 修复失效路径」套用后，修改会记录在这里。";
            body.appendChild(empty);
        } else {
            for (const entry of log) {
                const group = mkEl("div", "rs-repair-log-group");
                const t = mkEl("div", "rs-repair-log-time");
                t.textContent = `${new Date(entry.time).toLocaleString("zh-CN", { hour12: false })} · ${entry.kind === "gen_video" ? "生视频" : "生图"}`;
                group.appendChild(t);
                for (const c of entry.changes || []) {
                    const row = mkEl("div", "rs-repair-row");
                    const label = mkEl("span", "rs-repair-label");
                    label.textContent = REPAIR_FIELD_LABELS[c.field] || c.field;
                    const from = mkEl("span", "rs-repair-cur");
                    from.textContent = shortModelName(c.from);
                    from.title = c.from;
                    const arrow = mkEl("span", "rs-repair-arrow");
                    arrow.textContent = "→";
                    const to = mkEl("span", "rs-repair-new");
                    to.textContent = shortModelName(c.to);
                    to.title = c.to;
                    row.append(label, from, arrow, to);
                    group.appendChild(row);
                }
                body.appendChild(group);
            }
        }
        const foot = mkEl("div", "rs-repair-foot");
        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = "仅本机本地记录，不影响 config.json";
        const clearBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
        clearBtn.type = "button";
        clearBtn.textContent = "清空记录";
        foot.append(hint, clearBtn);
        box.append(head, body, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const closeDialog = () => overlay.remove();
        closeBtn.addEventListener("click", closeDialog);
        clearBtn.addEventListener("click", () => { clearSkillRepairLog(currentSkillId); closeDialog(); showToast(app, "info", "本技能修复记录已清空"); });
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDialog(); });
    }

    function updateCfgButtons(btns, saveBtn, restoreBtn, localHint) {
        const preset = currentSource === "presets";
        btns.style.display = preset ? "flex" : "none";
        saveBtn.style.display = preset ? "inline-block" : "none";
        restoreBtn.style.display = preset && configOverridden ? "inline-block" : "none";
        localHint.style.display = preset ? "inline" : "none";
    }

    async function loadVideoGenSettings() {
        if (!currentSkillId) return null;
        const [config, videoModels] = await Promise.all([
            getSkillGenConfig(currentSkillId),
            listVideoGenModels().catch(() => ({})),
        ]);
        videoModelSection.load(config || {}, videoModels);
        updateCfgButtons(videoCfgBtns, videoSaveCfgBtn, videoRestoreCfgBtn, videoLocalHint);
        checkRepairStatus();   // 打开/重载后检测失效路径 → 「修复」按钮告警态
        return { config: config || {}, models: videoModels };
    }

    // config.json 恒可编辑（模型路径因机器而异、无统一预设）→ 设置区不置灰；config 缺失按空对象回落默认。
    async function loadGenSettings() {
        if (!currentSkillId) return null;
        const config = await getSkillGenConfig(currentSkillId);
        let models = {};
        try { models = await listGenModels(); } catch (e) { console.warn("Failed to load gen models:", e); }
        genModelSection.load(config || {}, models);
        genSizeSection.load(config || {});
        enhancePromptChk.checked = !!(config && config.enhance_prompt);
        updateCfgButtons(genCfgBtns, genSaveCfgBtn, genRestoreCfgBtn, genLocalHint);
        checkRepairStatus();   // 打开/重载后检测失效路径 → 「修复」按钮告警态
        return { config: config || {}, models };
    }

    // ---- 失效模型路径修复：检测 config 里失效字段，弹窗批量套用候选后回填设置区 ----
    const REPAIR_FIELD_LABELS = { model: "主模型", text_encoder: "Text Encoder", vae: "VAE", audio_vae: "音频 VAE" };

    // 「修复失效路径」应用后重渲染工作流图：用当前设置区值重新预渲染模板并重新校验，清掉已修好的红框（复用已加载的原始模板，不重新拉 workflow.json）
    async function refreshWorkflowGraph() {
        if (!workflowShown || !currentSkillId || !skillWorkflowRaw) return;
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        const cfg = isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() };
        const genInfo = { config: cfg, models: (loadedGenInfo && loadedGenInfo.models) || {} };
        const rendered = applyWorkflowParams(injectRuntimeLoras(skillWorkflowRaw, cfg.loras), workflowParamValues(isVideo, genInfo));
        renderWorkflowGraph(workflowBody, rendered, validateWorkflow(rendered, null, {}), workflowSummary);   // 先同步预检（蓝框）
        const validation = await checkWorkflow(rendered);   // /object_info + /models/*，失败内部按跳过处理
        if (currentSkillId && workflowShown) {               // 等待期间切了技能/关区 → 丢弃过期结果
            const sl = workflowBody.scrollLeft, st = workflowBody.scrollTop;
            renderWorkflowGraph(workflowBody, rendered, validation, workflowSummary);
            workflowBody.scrollLeft = sl;
            workflowBody.scrollTop = st;
        }
    }

    // 把接受的修复项回填到当前活动的设置区（生图/生视频）：合并进 collect() 后重新 load，
    // LoRA 按原失效名匹配替换（不依赖下标，避免用户增删行后错位）。回填不自动保存。
    function applyModelFixes(fixes) {
        const isGen = genSettingsWrap.style.display !== "none";
        const section = isGen ? genModelSection : videoModelSection;
        const models = (loadedGenInfo && loadedGenInfo.models) || {};
        const merged = { ...section.collect() };
        for (const k of ["model", "text_encoder", "vae", "audio_vae"]) if (k in fixes) merged[k] = fixes[k];
        if (fixes.loras && fixes.loras.length) {
            merged.loras = (merged.loras || []).map((e) => {
                const fix = fixes.loras.find((f) => f.from === e.name);
                return fix ? Object.assign({}, e, { name: fix.to }) : e;
            });
        }
        section.load(merged, models);
        refreshWorkflowGraph();   // 设置区已回填 → 重渲染工作流图并重新校验，清掉已修好的红框
    }

    async function openModelRepairDialog() {
        if (!currentSkillId) return;
        const config = activeRepairContext().config;   // 用当前活动设置区最新值（而非最近 load 的快照）
        let data;
        try {
            const resp = await fetch("/neo_nodes/skill_model_suggest", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config }),
            });
            data = await resp.json();
        } catch (e) {
            showToast(app, "error", "修复检查失败", String(e.message || e));
            return;
        }
        if (!data || !data.success) { showToast(app, "error", "修复检查失败", (data && data.error) || ""); return; }
        const fields = data.fields || {};
        // 收集失效项（标量字段 + LoRA），保留后端返回顺序
        const rows = [];
        for (const key of ["model", "text_encoder", "vae", "audio_vae"]) {
            const f = fields[key];
            if (f && f.status === "missing")
                rows.push({ kind: "field", key, value: f.value, suggestion: f.suggestion, score: f.score, candidates: f.candidates || [] });
        }
        for (const l of fields.loras || []) {
            if (l.status === "missing")
                rows.push({ kind: "lora", index: l.index, value: l.value, suggestion: l.suggestion, score: l.score, candidates: l.candidates || [] });
        }
        if (!rows.length) { showToast(app, "info", "没有失效的模型路径"); return; }

        const overlay = mkEl("div", "rs-repair-overlay");
        const box = mkEl("div", "rs-repair-box");
        const head = mkEl("div", "rs-repair-head");
        const title = mkEl("span", "");
        title.textContent = `修复失效模型路径（${rows.length}）`;
        const closeBtn = mkEl("button", "rs-repair-close");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        head.append(title, closeBtn);

        const body = mkEl("div", "rs-repair-body");
        const selects = [];   // 与 rows 对齐：每项一个 <select>，value="" 表示跳过
        for (const r of rows) {
            const row = mkEl("div", "rs-repair-row");
            const label = mkEl("span", "rs-repair-label");
            label.textContent = r.kind === "lora" ? `LoRA #${(r.index ?? 0) + 1}` : (REPAIR_FIELD_LABELS[r.key] || r.key);
            const cur = mkEl("span", "rs-repair-cur");
            cur.textContent = shortModelName(r.value);
            cur.title = r.value;
            const sel = document.createElement("select");
            sel.className = "rs-repair-sel rs-form-input";
            const ph = document.createElement("option");
            ph.value = "";
            ph.textContent = "（跳过）";
            sel.appendChild(ph);
            const addOpt = (val, text) => {
                const o = document.createElement("option");
                o.value = val;
                o.textContent = text;
                sel.appendChild(o);
            };
            if (r.suggestion) addOpt(r.suggestion, `${shortModelName(r.suggestion)}（推荐 ${Math.round((r.score || 0) * 100)}%）`);
            for (const c of r.candidates) {
                if (c === r.suggestion) continue;
                addOpt(c, shortModelName(c));
            }
            if (r.suggestion) sel.value = r.suggestion;   // 高置信默认选中推荐项
            row.append(label, cur, sel);
            body.appendChild(row);
            selects.push(sel);
        }

        const foot = mkEl("div", "rs-repair-foot");
        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = "套用后需点 Save 才写入 config.json";
        const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
        cancelBtn.type = "button";
        cancelBtn.textContent = "取消";
        const applyBtn = mkEl("button", "rs-btn");
        applyBtn.type = "button";
        applyBtn.textContent = "应用选中项";
        foot.append(hint, cancelBtn, applyBtn);

        box.append(head, body, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const closeDialog = () => overlay.remove();
        closeBtn.addEventListener("click", closeDialog);
        cancelBtn.addEventListener("click", closeDialog);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDialog(); });

        applyBtn.addEventListener("click", () => {
            const fixes = {};
            const changes = [];   // 写入本技能修复记录：{ field, from, to }
            let n = 0;
            rows.forEach((r, i) => {
                const val = selects[i].value;
                if (!val) return;
                if (r.kind === "field") { fixes[r.key] = val; n++; changes.push({ field: r.key, from: r.value, to: val }); }
                else { (fixes.loras = fixes.loras || []).push({ from: r.value, to: val }); n++; changes.push({ field: `LoRA #${(r.index ?? 0) + 1}`, from: r.value, to: val }); }
            });
            if (!n) { closeDialog(); return; }
            const kind = videoGenSettingsWrap.style.display !== "none" ? "gen_video" : "gen_image";
            applyModelFixes(fixes);
            recordSkillRepair(currentSkillId, changes, kind);   // 记录到本技能修复历史（localStorage）
            checkRepairStatus();                                 // 重新检测：无缺失则清除红框/红点
            closeDialog();
            showToast(app, "success", `已填入 ${n} 项，请点 Save 保存到 config.json`);
        });
    }

    // ---- 预设技能设置区：独立保存（主 Save 对预设隐藏）+ 一键恢复默认 ----
    async function savePresetGenSettings() {
        if (!currentSkillId || currentSource !== "presets") return;
        try {
            if (genSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, { ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
            } else if (videoGenSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, videoModelSection.collect());
            }
            configOverridden = true;
            genSettingsBaseline = collectGenSettingsJson();
            updateCfgButtons(genCfgBtns, genSaveCfgBtn, genRestoreCfgBtn, genLocalHint);
            updateCfgButtons(videoCfgBtns, videoSaveCfgBtn, videoRestoreCfgBtn, videoLocalHint);
            dispatchSkillChanged(currentSkillId); // 预设设置落盘（本地覆盖）→ 通知节点状态条即时重检
        } catch (err) {
            alert("Save gen settings failed: " + err.message);
        }
    }

    async function restorePresetGenSettings() {
        if (!currentSkillId || currentSource !== "presets") return;
        if (!confirm("恢复本技能设置为预设默认？（将清除本地覆盖设置）")) return;
        const r = await resetSkillGenConfig(currentSkillId);
        if (!r.success) { alert("Restore failed: " + (r.error || "")); return; }
        configOverridden = false;
        try {
            if (genSettingsWrap.style.display !== "none") await loadGenSettings();
            else if (videoGenSettingsWrap.style.display !== "none") await loadVideoGenSettings();
        } catch (err) {
            alert("Reload settings failed: " + err.message);
        }
    }
    genSaveCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); savePresetGenSettings(); });
    videoSaveCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); savePresetGenSettings(); });
    genRestoreCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); restorePresetGenSettings(); });
    videoRestoreCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); restorePresetGenSettings(); });

    // ---- 底部按钮：随状态显隐（Save / Delete）；关闭走标题栏 ✕，复制走标题栏 Copy as custom ----
    const footerBtns = mkEl("div", "rs-modal-btns rs-skill-detail-actions");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = "💾 Save";
    const deleteBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    deleteBtn.textContent = "🗑 Delete";
    footerBtns.append(saveBtn, deleteBtn);

    content.append(nameRow, multiTurnRow, contentRow, genSettingsWrap, videoGenSettingsWrap, workflowWrap, footerBtns);
    modal.append(header, content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ---- 状态 ----
    let currentSkillId = null;
    let currentSource = "custom";
    let configOverridden = false;   // 预设技能是否存在本地配置覆盖（load_skill 返回）
    let currentFiles = [];   // [{ name, size }]（递归 .md/.txt 相对路径，含主文件 skill.md）
    let selectedFile = null;
    let editorMode = "preview";
    const isCustom = () => currentSource === "custom";
    const isMainFile = (name) => String(name || "").toLowerCase() === "skill.md";
    let workflowShown = false;   // 是否渲染了工作流流程图（正文区高度减半，为空时进一步压缩）
    let contentBaseline = null;   // { name, content, multiTurn } 加载/新建后的快照，关闭时判断正文有无未保存修改
    let genSettingsBaseline = null;   // 生图/生视频设置区 collect() 的 JSON 快照（load/save 后刷新）；null = 无设置区
    let loadedGenInfo = null;         // 最近一次 loadGenSettings/loadVideoGenSettings 返回的 { config, models }，供「修复失效路径」回填复用
    let skillWorkflowRaw = null;     // 最近加载的技能 workflow.json 原始模板（「修复失效路径」后重渲染复用，避免重新拉取）

    // 有工作流的技能：正文区高度减半给流程图让位；正文为空时进一步压缩（输入内容后自动恢复）
    function updateContentCompact() {
        contentRow.classList.toggle("rs-content-row-workflow", workflowShown);
        contentRow.classList.toggle("rs-content-row-compact", workflowShown && !contentTextarea.value.trim());
    }

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
    contentTextarea.addEventListener("input", updateContentCompact);

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
        editBtn.style.display = readOnly ? "none" : "inline-block";
        previewBtn.style.display = readOnly ? "none" : "inline-block";
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
        contentBaseline = { name: nameInput.value, content: text, multiTurn: multiTurnChk.checked };
        setEditorMode(/\.md$/i.test(name) ? editorMode : "edit");
        updateControls();
        updateContentCompact();
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
        contentBaseline = null;
        genSettingsBaseline = null;
        const full = await loadSkill(id);
        if (full && full.error) { alert("Failed to load skill: " + full.error); close(); return; }
        const nm = (full && full.name) || id;
        nameInput.value = nm;
        const roSuffix = !isCustom() ? "（只读）" : "";
        titleSpan.textContent = "📝 " + nm + roSuffix;
        titleSpan.title = nm;
        multiTurnChk.checked = !!(full && full.multi_turn);
        configOverridden = !!(full && full.config_overridden);
        currentFiles = (full && full.files) || [];
        let mainName = null;
        for (const f of currentFiles) { if (isMainFile(f.name)) { mainName = f.name; break; } }
        if (!mainName && currentFiles.length) mainName = currentFiles[0].name;
        populateFileSelect(mainName);
        setEditorMode("preview");
        if (mainName) await selectFile(mainName);
        else { selectedFile = null; contentTextarea.value = ""; contentBaseline = { name: nm, content: "", multiTurn: multiTurnChk.checked }; }
        // workflow.json 拉取与设置区加载互不依赖 → 提前并发发出，省一段串行等待
        const wfPromise = (full && (full.gen_image || full.gen_video)) ? loadSkillWorkflow(id) : null;
        // 生图/生视频技能显示各自 config.json 覆盖区（恒可编辑：预设存本地覆盖、自定义随主 Save）；其余技能隐藏。
        // multi_turn 是文本多轮概念，生图/生视频技能用不到 → 一并隐藏
        let genInfo = null; // 设置区加载的 { config, models }，供工作流模板预渲染复用（不再重复请求）
        setRepairAlert(genRepairBtn, false);   // 打开新技能先清告警；loadGenSettings/loadVideoGenSettings 内 checkRepairStatus 检测后再点亮
        setRepairAlert(videoRepairBtn, false);
        if (full && full.gen_image) {
            genSettingsWrap.style.display = "block";
            videoGenSettingsWrap.style.display = "none";
            multiTurnRow.style.display = "none";
            enhancePromptWrap.style.display = "";
            genInfo = await loadGenSettings();
        } else if (full && full.gen_video) {
            genSettingsWrap.style.display = "none";
            videoGenSettingsWrap.style.display = "block";
            multiTurnRow.style.display = "none";
            enhancePromptWrap.style.display = "none";
            genInfo = await loadVideoGenSettings();
        } else {
            genSettingsWrap.style.display = "none";
            videoGenSettingsWrap.style.display = "none";
            multiTurnRow.style.display = "";
            enhancePromptWrap.style.display = "none";
        }
        loadedGenInfo = genInfo || null;                  // 「修复失效路径」用：保存 { config, models }
        genSettingsBaseline = collectGenSettingsJson();   // 设置区回填完成 → 脏检查基线就绪
        // 工作流流程图：仅生图/生视频技能。先显示骨架占位并同步压缩正文区（预留位置），加载完成后原地替换 → 打开时布局不跳；无 workflow.json 时隐藏。
        // 分步渲染：workflow.json + 设置就绪后先用同步预检（仅模板变量蓝框）画出流程图，
        // /object_info·/models/* 校验在后台进行，完成后原地重画补红框与摘要 → 图不必等最慢的请求。
        workflowBody.innerHTML = "";
        workflowSummary.textContent = "";
        workflowWrap.style.display = "none";
        workflowShown = false;
        skillWorkflowRaw = null;
        if (wfPromise) {
            const skel = mkEl("div", "rs-wf-skeleton");
            skel.textContent = "加载工作流图中…";
            workflowBody.appendChild(skel);
            workflowWrap.style.display = "block";
            workflowShown = true;
            updateContentCompact();   // 先占位：正文区立即让位，避免加载完成后整体下移
            const wf = await wfPromise;
            if (currentSkillId === id && wf) skillWorkflowRaw = wf;   // 存原始模板：「修复失效路径」后重渲染复用（apply/inject 返回新对象不改原模板）
            if (wf) {
                // 超出模板槽位的 LoRA 运行时动态插入（同后端 _apply_loras：在 render_template 之后、LoRA 槽位填充之前执行，流程图与真实提交一致）；配置了才注入
                const rendered = applyWorkflowParams(injectRuntimeLoras(wf, ((genInfo || {}).config || {}).loras), workflowParamValues(full.gen_video, genInfo));
                renderWorkflowGraph(workflowBody, rendered, validateWorkflow(rendered, null, {}), workflowSummary); // 内部先清空占位再画
                const validation = await checkWorkflow(rendered);   // /object_info + /models/*，失败内部按跳过处理
                if (currentSkillId === id && workflowShown) {       // 等待期间切了技能/关区 → 丢弃过期结果
                    const sl = workflowBody.scrollLeft, st = workflowBody.scrollTop;
                    renderWorkflowGraph(workflowBody, rendered, validation, workflowSummary);
                    workflowBody.scrollLeft = sl;
                    workflowBody.scrollTop = st;
                }
            } else {
                workflowWrap.style.display = "none";
                workflowShown = false;
                workflowBody.innerHTML = "";
            }
        }
        updateContentCompact();
        // 紧凑类在正文填充之后才确定 → 重设一次模式，让预览框高度与（可能已压缩的）编辑框一致
        setEditorMode(editorMode);
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
        configOverridden = false;
        setBadge();
        nameInput.value = "";
        contentTextarea.value = "";
        contentPreview.innerHTML = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        selectedFile = null;
        multiTurnChk.checked = false;
        multiTurnRow.style.display = "";
        enhancePromptWrap.style.display = "none";
        enhancePromptChk.checked = false;
        workflowWrap.style.display = "none";
        workflowShown = false;
        workflowBody.innerHTML = "";
        workflowSummary.textContent = "";
        contentBaseline = { name: "", content: "", multiTurn: false };
        genSettingsBaseline = null;
        loadedGenInfo = null;
        nameInput.disabled = false;
        contentTextarea.disabled = false;
        setEditorMode("edit");
        updateControls();
        nameInput.focus();
    }

    // ---- 关闭保护：有未保存修改先出确认条（同自动增强菜单 rs-gen-dirty-confirm 模式）----
    // 当前生图/生视频设置区的 JSON 快照（脏检查与保存共用）；无设置区返回 null
    function collectGenSettingsJson() {
        if (genSettingsWrap.style.display !== "none")
            return JSON.stringify({ ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
        if (videoGenSettingsWrap.style.display !== "none")
            return JSON.stringify(videoModelSection.collect());
        return null;
    }

    function hasUnsavedChanges() {
        if (contentBaseline && (nameInput.value !== contentBaseline.name ||
            contentTextarea.value !== contentBaseline.content ||
            multiTurnChk.checked !== contentBaseline.multiTurn)) return true;
        return genSettingsBaseline !== null && collectGenSettingsJson() !== genSettingsBaseline;
    }

    const dirtyConfirm = mkEl("div", "rs-gen-dirty-confirm");
    dirtyConfirm.hidden = true;
    const dirtyText = mkEl("span", "rs-gen-dirty-text");
    dirtyText.textContent = "⚠ 有未保存的修改";
    const dirtyActions = mkEl("div", "rs-gen-dirty-actions");
    const btnSaveClose = mkEl("button", "rs-btn rs-gen-dirty-save");
    btnSaveClose.type = "button";
    btnSaveClose.textContent = "💾 保存并关闭";
    const btnDiscard = mkEl("button", "rs-btn rs-gen-dirty-discard");
    btnDiscard.type = "button";
    btnDiscard.textContent = "放弃修改";
    const btnKeepEditing = mkEl("button", "rs-btn rs-gen-dirty-keep");
    btnKeepEditing.type = "button";
    btnKeepEditing.textContent = "继续编辑";
    dirtyActions.append(btnSaveClose, btnDiscard, btnKeepEditing);
    dirtyConfirm.append(dirtyText, dirtyActions);
    content.insertBefore(dirtyConfirm, footerBtns);

    function close() { dirtyConfirm.hidden = true; overlay.style.display = "none"; }

    // 用户主动关闭（✕ / 点遮罩 / Esc）：有未保存修改时暂停关闭，等用户在确认条里选择
    function requestClose() {
        if (!hasUnsavedChanges()) { close(); return; }
        dirtyConfirm.hidden = false;
    }
    btnDiscard.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    btnKeepEditing.addEventListener("click", (e) => { e.stopPropagation(); dirtyConfirm.hidden = true; });
    btnSaveClose.addEventListener("click", async (e) => {
        e.stopPropagation();
        btnSaveClose.disabled = true;
        if (isCustom() || !currentSkillId) await handleSave();   // 自定义/新建：主 Save（含生图设置），成功即关
        else { await savePresetGenSettings(); if (!hasUnsavedChanges()) close(); }   // 预设：正文只读，仅设置区可能脏；失败留在弹窗重试
        btnSaveClose.disabled = false;
    });

    // ---- 保存（新建主文件 / 已有 skill 的当前选中文件）----
    // 自定义技能：生图设置区随主 Save 一起写入该技能 config.json；预设技能：走设置区头部「💾 Save」（本地覆盖，见 savePresetGenSettings）
    async function persistGenSettings() {
        if (!currentSkillId || !isCustom()) return;
        try {
            if (genSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, { ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
            } else if (videoGenSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, videoModelSection.collect());
            }
            genSettingsBaseline = collectGenSettingsJson();
            dispatchSkillChanged(currentSkillId); // 自定义技能设置落盘 → 通知节点状态条即时重检
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
        // 复制产生的 name 需与已有 skill 不重名（后端 save_skill 会 409），冲突时递增序号
        const baseName = ((full && full.name) || nameInput.value.trim() || currentSkillId) + " (Copy)";
        const takenNames = new Set((await listSkills()).map(s => (s.name || "").trim()));
        let copyName = baseName;
        for (let n = 2; takenNames.has(copyName); n++) copyName = `${baseName} ${n}`;
        await saveSkill({
            id: newId,
            name: copyName,
            content: (full && full.content) || "",
            tags: [...((full && full.tags) || [])],
            source: "custom",
            multi_turn: !!(full && full.multi_turn),
            // 保留 frontmatter 元数据：生图/生视频技能复制后仍是原分类且设置区可见
            category: (full && full.category) || "",
            gen_image: !!(full && full.gen_image),
            gen_video: !!(full && full.gen_video),
            // 视频模式（t2v/i2v/fl2v/r2v）：导演编辑器的分段技能下拉按 skill.mode 过滤，复制后必须保留
            mode: (full && full.mode) || "",
            requires_ref: !!(full && full.requires_ref)
        });
        await copySkillFiles(currentSkillId, newId); // 生图技能连同 workflow.json / config.json 一起复制（失败静默）
        document.dispatchEvent(new CustomEvent("rs.skills.updated"));
        await openExisting(newId, "custom"); // 立即切换到复制后的 skill 详情
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

    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同预设列表浮层）
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        modal.addEventListener(t, (e) => e.stopPropagation());
    });
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) requestClose(); });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); requestClose(); });
    const onKey = (e) => { if (e.key === "Escape" && overlay.style.display !== "none") requestClose(); };
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

// ==========================================
// 标题对话框：从画布导出技能时只问一个名称（替代三个原生 prompt）。
// overlay 挂到 document.body，复用 skill 弹窗样式；Enter 提交、Esc/点遮罩取消，返回 Promise<string|null>。
// ==========================================
let _activeTitleDialog = null;
function promptSkillTitle(defaultValue = "") {
    if (_activeTitleDialog) return _activeTitleDialog; // 避免重复弹层
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });

    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-title-dialog");
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = "📋 从画布创建技能";
    header.appendChild(titleSpan);

    const body = mkEl("div", "rs-skill-modal-content");
    const row = mkEl("div", "rs-config-row");
    const label = mkEl("label", "rs-form-label");
    label.textContent = "技能名称";
    const input = document.createElement("input");
    input.className = "rs-form-input rs-tpl-name";
    input.value = defaultValue;
    row.append(label, input);
    body.appendChild(row);

    const btns = mkEl("div", "rs-modal-btns");
    const cancelBtn = mkEl("button", "rs-btn rs-btn-local");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    const okBtn = mkEl("button", "rs-btn rs-btn-local");
    okBtn.type = "button";
    okBtn.textContent = "创建";
    btns.append(cancelBtn, okBtn);

    modal.append(header, body, btns);
    overlay.appendChild(modal);

    let done = false;
    const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        _activeTitleDialog = null;
        resolveFn(value);
    };
    const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; } // 名称必填：空则聚焦输入框，不关闭
        finish(v);
    };
    const onKey = (e) => {
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同详情弹窗）
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        modal.addEventListener(t, (e) => e.stopPropagation());
    });
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) finish(null); });
    okBtn.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(null); });

    overlay.style.display = "flex";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { input.focus(); input.select(); });

    _activeTitleDialog = promise;
    return promise;
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
// 技能选择弹窗（居中式，替代原生 combo 下拉）：
// - openSkillPickerModal()：通用居中弹窗（标题 + 搜索过滤 + 分组列表 + 可选底部管理工具栏）；
//   技能列表在右侧附浮动预览卡（生成技能 = 主模型 / LoRA / 长边尺寸 / 默认比例 / 步数，未保存字段显示与详情一致的自动默认值；其余技能 = skill.md 模板提示词正文摘录），随行焦点（键盘高亮 / hover）切换，点击打开详情弹窗
// - attachSkillPickerToComboWidget()：拦截 ComfyUI 画布 combo widget 的点击（widget.mouse），
//   弹出选择窗；选中写回 widget.value 并触发 callback（保留 Krea2/H3 既有的 loadDims/loadSpec 钩子）
// - attachSkillPickerToSelect()：拦截原生 <select>（导演编辑器分段技能下拉），同样弹居中窗口
// ==========================================

/** 把 skill 元数据映射为选择窗条目（value/label/badge/tags/source/group），按 category 分组排序。
 *  combo 的取值可能是 name 或 id：以实际出现在 allowed(options.values) 里的为准，保证写回合法；
 *  无 allowed 时默认用 name。 */
function skillItemsFromMeta(skills, allowed) {
    const items = [];
    for (const s of skills || []) {
        let value;
        if (allowed) value = allowed.includes(s.name) ? s.name : (allowed.includes(s.id) ? s.id : null);
        else value = s.name || s.id;
        if (!value) continue;
        items.push({
            value,
            skillId: s.id, // 行内 Edit/查看需按 id 打开详情（value 可能是 name，仅用于写回 combo）
            label: s.name || s.id,
            badge: s.needs_image ? "📷" : "",
            tags: (s.tags || []).join(" "),
            source: s.source || "custom",
            group: CATEGORY_LABELS[s.category]?.label || "",
            genImage: !!s.gen_image, // 预览卡自动默认值需区分生图 / 生视频（建议模型来源不同）
            genVideo: !!s.gen_video,
            genConfig: (s.gen_config && typeof s.gen_config === "object") ? s.gen_config : null, // 生图/生视频配置摘要（主模型 / LoRA / 长边 / 默认比例 / 步数）
        });
    }
    items.sort((a, b) => {
        if (a.group !== b.group) return a.group < b.group ? -1 : 1;
        return a.label.localeCompare(b.label);
    });
    return items;
}

/** 底部管理工具栏按钮（+ New Skill / ⬆ ZIP / ⬆ Folder / 📋 From Canvas）；onClose 在动作前关闭当前容器 */
function buildSkillManagementButtons(onClose) {
    const makeBtn = (label, title) => {
        const b = mkEl("button", "rs-btn rs-btn-local rs-skill-footer-btn");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };
    const newBtn = makeBtn("+ New Skill", "Create a new custom skill");
    newBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillDetailPopup().openNew(); });
    const zipBtn = makeBtn("⬆ ZIP", "Upload a .zip skill package");
    zipBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillUploadInputs().zipInput.click(); });
    const dirBtn = makeBtn("⬆ Folder", "Upload a skill folder (all .md files)");
    dirBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillUploadInputs().dirInput.click(); });
    // 把当前画布工作流（API prompt）导出为生图技能：后端自动抽模板占位符 + LoRA 槽位
    const canvasBtn = makeBtn("📋 From Canvas", "Export the current canvas workflow as a skill (image or H3 video)");
    canvasBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        onClose();
        try {
            const { output, error } = (await app.graphToPrompt()) || {};
            if (error || !output || !Object.keys(output).length) {
                showToast(app, "warning", "无法导出", "画布上没有有效工作流" + (error?.message ? `（${error.message}）` : ""));
                return;
            }
            const name = await promptSkillTitle("my-workflow");
            if (!name) return; // 用户在标题对话框取消
            const r = await saveWorkflowSkill({ name, description: "", tags: [], workflow: output });
            showToast(app, "success", `已保存${r.gen_video ? "生视频" : "生图"}技能 "${r.id}"`, (r.warnings || []).join("\n"));
            document.dispatchEvent(new CustomEvent("rs.skills.updated"));
        } catch (err) {
            showToast(app, "error", "保存失败", err.message);
        }
    });
    return [newBtn, zipBtn, dirBtn, canvasBtn];
}

/**
 * 打开居中技能选择弹窗。
 * opts: { title, items:[{value,label,badge,tags,source,group,skillId,genImage,genVideo,genConfig}], currentValue, onPick(value,item), showFooter }
 * 返回 { close, overlay }；每次调用新建并挂到 body，close 时移除。
 * 同一时刻只允许一个选择窗：重复点击 / 异步竞态（连点 combo）不会叠加出多个弹窗。
 */
// 把 anchor（DOM 元素 / 带 clientX/clientY 的指针事件 / {left,top,width,height}）归一成视口坐标矩形；无法解析返回 null
function resolveAnchorRect(anchor) {
    if (!anchor || typeof anchor !== "object") return null;
    if (typeof anchor.getBoundingClientRect === "function") {
        const r = anchor.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    if (Number.isFinite(anchor.clientX)) {
        // 指针事件：以点击点为锚，矩形退化为一个点（弹窗贴在该点下方）
        return { left: anchor.clientX, top: anchor.clientY, right: anchor.clientX, bottom: anchor.clientY, width: 0, height: 0 };
    }
    if (Number.isFinite(anchor.left) && Number.isFinite(anchor.top)) {
        return { left: anchor.left, top: anchor.top, right: anchor.right ?? anchor.left, bottom: anchor.bottom ?? anchor.top, width: anchor.width || 0, height: anchor.height || 0 };
    }
    return null;
}

// 把弹窗面板锚定到矩形附近：默认贴下方左侧，越界翻到上方并夹在视口内。jsdom 无布局（offsetWidth=0）时用回退尺寸。
function positionPickerPanel(panel, rect) {
    const GAP = 10;
    const MARGIN = 8;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const pw = panel.offsetWidth || 440;
    const ph = panel.offsetHeight || 320;
    let left = rect.left;
    let top = rect.bottom + GAP;
    if (top + ph > vh - MARGIN) top = rect.top - ph - GAP; // 下方放不下 → 翻到上方
    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));
    panel.style.position = "fixed";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

// 预览卡正文摘录长度（skill.md 模板提示词，超长截断）
const PREVIEW_EXCERPT_LEN = 400;

// skill.md 正文缓存：非生成技能预览按需 loadSkill 取正文，避免每次 hover 都请求；技能增删改后随广播清空
const _skillPreviewContent = new Map(); // skillId -> 正文（"" = 已加载且为空）
document.addEventListener("rs.skills.updated", () => _skillPreviewContent.clear());

async function getSkillPreviewContent(id) {
    if (_skillPreviewContent.has(id)) return _skillPreviewContent.get(id);
    const data = await loadSkill(id);
    const body = (data && !data.error) ? String(data.content || "") : "";
    _skillPreviewContent.set(id, body);
    return body;
}

/** 预览卡锚定：紧贴焦点行右侧、顶边对齐；右侧放不下翻到行左侧，坐标夹在视口内 */
function positionPreviewCard(previewEl, rect) {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const MARGIN = 8, GAP = 8;
    const w = previewEl.offsetWidth || 420;
    const h = previewEl.offsetHeight || 120;
    let left = rect.right + GAP;
    if (left + w > vw - MARGIN) left = rect.left - w - GAP; // 右侧放不下 → 翻到行左侧
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(rect.top, vh - h - MARGIN));
    previewEl.style.left = `${left}px`;
    previewEl.style.top = `${top}px`;
}

// 自动建议模型列表（未保存主模型时显示「自动（建议名）」，与详情弹窗同源）：模块级懒加载，选择窗与技能下拉共享
let _previewGenModelsPromise = null;
let _previewVideoModelsPromise = null;
function ensurePreviewModelLists() {
    if (!_previewGenModelsPromise) _previewGenModelsPromise = listGenModels().catch(() => null);
    if (!_previewVideoModelsPromise) _previewVideoModelsPromise = listVideoGenModels().catch(() => null);
    return Promise.all([_previewGenModelsPromise, _previewVideoModelsPromise]).then(([genModels, videoModels]) => ({ genModels, videoModels }));
}

/** 把焦点技能渲染进预览卡：生成技能 = 主模型 / LoRA（逐条 chip）/ 长边尺寸 / 默认比例 / 步数，未保存的按详情弹窗同款自动默认显示；
 *  其余技能 = skill.md 模板提示词正文摘录（懒加载 + 缓存）。it 为 null（无焦点行）时显示操作提示。整卡点击打开详情由调用方绑定。 */
function renderSkillPreview(preview, it, ctx = {}) {
    preview.innerHTML = "";
    if (!it) {
        const hint = mkEl("div", "rs-skill-preview-empty");
        hint.textContent = "用 ↑ / ↓ 或悬停浏览技能";
        preview.appendChild(hint);
        return;
    }
    const id = it.skillId || it.value;
    preview.dataset.focusId = id;
    const name = mkEl("div", "rs-skill-preview-name");
    name.textContent = it.label;
    name.title = it.label;
    preview.appendChild(name);
    if (it.genImage || it.genVideo) {
        const cfg = (it.genConfig && typeof it.genConfig === "object") ? it.genConfig : {};
        const addRow = (key, valEl) => {
            const r = mkEl("div", "rs-skill-preview-row");
            const k = mkEl("span", "rs-skill-preview-key");
            k.textContent = key;
            r.append(k, valEl);
            preview.appendChild(r);
        };
        // 主模型：已保存值优先；未保存时与详情「自动（建议名）」一致——生图取 suggested_diffusion_models，生视频按 H3 名称线索挑
        let model = String(cfg.model || "").trim();
        if (!model) {
            const suggested = it.genImage
                ? (ctx.genModels && ctx.genModels.suggested_diffusion_models) || ""
                : videoSuggestion(ctx.videoModels ? ctx.videoModels.diffusion_models : []);
            model = suggested ? `自动（${shortModelName(suggested)}）` : "自动";
        }
        const mv = mkEl("span", "rs-skill-preview-val");
        mv.textContent = model;
        addRow("主模型", mv);
        // LoRA：仅已保存配置展示（详情同样不自动加行）
        const loras = Array.isArray(cfg.loras) ? cfg.loras.filter((n) => n) : [];
        if (loras.length) {
            const chips = mkEl("span", "rs-skill-preview-val rs-skill-preview-chips");
            loras.forEach((n) => {
                const c = mkEl("span", "rs-skill-preview-chip");
                c.textContent = n;
                chips.appendChild(c);
            });
            addRow("LoRA", chips);
        }
        // 长边 / 比例：生图与生视频共用同一 gen_config 字段，未保存时显示后端默认（与详情「默认 (1280)」/「默认 (1:1)」一致）
        const base = Number.isFinite(cfg.base_resolution) && cfg.base_resolution > 0 ? cfg.base_resolution : null;
        const bv = mkEl("span", "rs-skill-preview-val");
        bv.textContent = base ? `${base}px` : "默认 (1280)";
        addRow("长边尺寸", bv);
        const ratio = String(cfg.default_ratio || "").trim();
        const rv = mkEl("span", "rs-skill-preview-val");
        rv.textContent = ratio || "默认 (1:1)";
        addRow("默认比例", rv);
        // 步数：详情「🎬 生视频设置」的「步数」输入框 / 模板 {{STEPS}}，缺省 20（与后端 resolve 一致）
        const steps = Number.isFinite(cfg.steps) && cfg.steps > 0 ? cfg.steps : null;
        const sv = mkEl("span", "rs-skill-preview-val");
        sv.textContent = steps ? String(steps) : "默认 (20)";
        addRow("步数", sv);
    } else {
        // 非生成技能：skill.md 模板提示词正文摘录（懒加载 + 缓存，超长截断）
        const showBody = (body) => (body.length > PREVIEW_EXCERPT_LEN ? body.slice(0, PREVIEW_EXCERPT_LEN) + "…" : body) || "（无正文）";
        const bodyEl = mkEl("div", "rs-skill-preview-body");
        preview.appendChild(bodyEl);
        const cached = _skillPreviewContent.get(id);
        if (cached !== undefined) {
            bodyEl.textContent = showBody(cached);
        } else {
            bodyEl.textContent = "加载中…";
            getSkillPreviewContent(id).then((body) => {
                if (preview.dataset.focusId !== id) return; // 焦点已切走，丢弃过期结果
                bodyEl.textContent = showBody(body);
            });
        }
    }
    const hint = mkEl("div", "rs-skill-preview-hint");
    hint.textContent = "点击卡片打开技能详情";
    preview.appendChild(hint);
}

let _skillPickerOpen = false;

function openSkillPickerModal(opts = {}) {
    if (_skillPickerOpen) return; // 已有选择窗打开，忽略重复触发
    _skillPickerOpen = true;
    const items = Array.isArray(opts.items) ? opts.items : [];
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    overlay.style.display = "flex";

    // 键盘导航状态：visibleItems/Rows 为当前过滤后的候选，highlightIndex 是光标（-1 未聚焦）
    let visibleItems = [];
    let visibleRows = [];
    let highlightIndex = -1;
    const setHighlight = (i) => {
        if (!visibleRows.length) return;
        highlightIndex = ((i % visibleRows.length) + visibleRows.length) % visibleRows.length;
        visibleRows.forEach((r, j) => r.classList.toggle("is-highlighted", j === highlightIndex));
        visibleRows[highlightIndex]?.scrollIntoView?.({ block: "nearest" });
        updatePreview(); // 预览卡随焦点切换
    };
    const pickHighlighted = () => {
        const it = visibleItems[highlightIndex];
        if (!it) return;
        close();
        opts.onPick?.(it.value, it);
    };

    // close 需在构建 footer（引用它）之前定义；onKey 与 close 互相闭包，实际调用都在二者初始化之后
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(highlightIndex + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(highlightIndex - 1); }
        else if (e.key === "Enter") { e.preventDefault(); pickHighlighted(); }
    };
    const close = () => { _skillPickerOpen = false; overlay.remove(); document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", positionPreview); opts.onClose?.(); };
    // 打开技能详情（编辑）弹窗：选择窗关闭后按 skill id 加载（名称可改，id 是稳定键）
    const openDetail = (it) => { close(); getSkillDetailPopup().openExisting(it.skillId || it.value, it.source); };

    const panel = mkEl("div", "rs-skill-modal rs-skill-picker");

    const search = mkEl("input", "rs-form-input rs-skill-picker-search");
    search.type = "text";
    search.placeholder = "🔍 输入过滤...";

    const list = mkEl("div", "rs-skill-picker-list");
    panel.append(search, list);

    if (opts.showFooter) {
        const footer = mkEl("div", "rs-skill-dropdown-footer");
        buildSkillManagementButtons(close).forEach((b) => footer.appendChild(b));
        panel.appendChild(footer);
    }

    // 技能列表：浮动预览卡，以焦点行为锚点贴其右侧（键盘高亮 / hover 跟随）；
    // 生成技能显示配置摘要（未保存字段按详情同款自动默认），其余技能显示 skill.md 模板正文摘录，故只要存在技能条目就渲染。
    // 调用方传 previewRenderer 时改用自定义渲染（如导演配方的只读时间轴），此时只要有候选项就渲染
    const wrap = mkEl("div", "rs-skill-picker-wrap");
    wrap.appendChild(panel);
    let preview = null;
    if (opts.previewRenderer || items.some((it) => it.skillId || it.genImage || it.genVideo)) {
        preview = mkEl("div", "rs-skill-picker-preview");
        preview.title = opts.previewRenderer ? "" : "点击打开技能详情";
        preview.addEventListener("mousedown", (e) => e.preventDefault()); // 不抢搜索框焦点
        preview.addEventListener("click", () => {
            const it = visibleItems[highlightIndex];
            if (!it) return;
            if (opts.onPreviewClick) { close(); opts.onPreviewClick(it); }
            else openDetail(it);
        });
        overlay.appendChild(preview); // absolute 挂在 overlay（fixed inset:0）上，按视口坐标锚定焦点行
    }
    // 预览卡锚点定位：紧贴焦点行右侧，顶边对齐；右侧放不下翻到行左侧，垂直夹在视口内。无焦点时锚定列表顶部
    const positionPreview = () => {
        if (!preview) return;
        positionPreviewCard(preview, (visibleRows[highlightIndex] || list).getBoundingClientRect());
    };
    // 有生成技能未保存主模型时，拉一次模型列表取自动建议（与详情弹窗同源）；到位后刷新当前预览
    let genModels = null;
    let videoModels = null;
    if (preview) {
        const needModels = items.some((it) => (it.genImage || it.genVideo) && !(it.genConfig && it.genConfig.model));
        if (needModels) {
            ensurePreviewModelLists().then((m) => { genModels = m.genModels; videoModels = m.videoModels; updatePreview(); });
        }
    }
    const updatePreview = () => {
        if (!preview) return;
        const it = visibleItems[highlightIndex] || null;
        if (opts.previewRenderer) opts.previewRenderer(preview, it);
        else renderSkillPreview(preview, it, { genModels, videoModels });
        positionPreview(); // 内容行数变化后卡片高度变，需重新锚定
    };

    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    list.addEventListener("scroll", positionPreview); // 列表滚动时焦点行位置变化
    window.addEventListener("resize", positionPreview);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const render = (filter) => {
        list.innerHTML = "";
        const f = String(filter || "").trim().toLowerCase();
        const matches = items.filter((it) => !f || `${it.label} ${it.tags || ""}`.toLowerCase().includes(f));
        visibleItems = matches;
        visibleRows = [];
        highlightIndex = -1;
        updatePreview(); // 过滤后焦点重置，预览卡回到提示态（下方命中当前值时会重新高亮）
        if (!matches.length) {
            const empty = mkEl("div", "rs-skill-picker-empty");
            empty.textContent = "无匹配项";
            list.appendChild(empty);
            return;
        }
        let lastGroup = null;
        matches.forEach((it, i) => {
            if (it.group && it.group !== lastGroup) {
                const gh = mkEl("div", "rs-combo-category");
                gh.textContent = it.group;
                list.appendChild(gh);
                lastGroup = it.group;
            }
            const row = mkEl("div", "rs-skill-picker-item" + (it.value === opts.currentValue ? " is-selected" : ""));
            if (it.badge) { const b = mkEl("span", "rs-skill-picker-badge"); b.textContent = it.badge; row.appendChild(b); }
            const lbl = mkEl("span", "rs-skill-picker-label");
            lbl.textContent = it.label;
            row.appendChild(lbl);
            row.addEventListener("mousedown", (e) => e.preventDefault()); // 保持搜索框焦点
            row.addEventListener("mouseenter", () => setHighlight(i)); // hover 行同步右侧预览卡
            row.addEventListener("click", (e) => { e.stopPropagation(); close(); opts.onPick?.(it.value, it); });
            visibleRows[i] = row;
            list.appendChild(row);
        });
        const cur = matches.findIndex((it) => it.value === opts.currentValue); // 默认高亮当前值所在行
        if (cur >= 0) setHighlight(cur);
    };
    render("");
    search.addEventListener("input", () => render(search.value));

    // 传入 anchor 时贴到触发控件附近（去遮罩的浮层）；否则保持居中模态。预览卡独立 absolute 定位，不受面板位置影响
    const anchorRect = resolveAnchorRect(opts.anchor);
    if (anchorRect) {
        overlay.classList.add("rs-skill-picker--anchored");
        positionPickerPanel(wrap, anchorRect);
        positionPreview(); // 面板锚定后焦点行坐标已变，预览卡需重新对齐（首次定位发生在居中布局下）
    }

    search.focus();
    return { close, overlay };
}

/** 写回 combo widget：更新 value + 触发 callback（Krea2/H3 已在其上挂 loadDims/loadSpec）+ 标记画布脏 */
function setComboWidgetValue(node, widget, value) {
    if (widget.value === value) return;
    const old = widget.value;
    widget.value = value;
    try { if (typeof widget.callback === "function") widget.callback(value); } catch (_) {}
    try { node?.onWidgetChanged?.(widget.name, value, old, widget); } catch (_) {}
    try { node?.graph?.change?.(); } catch (_) {}
}

/** 默认技能条目来源：listSkills() 元数据，value 对齐该 combo 的合法 options.values（Krea2/H3 skill_id 通用） */
async function defaultSkillItemsProvider(widget) {
    const skills = await listSkills();
    const allowed = Array.isArray(widget?.options?.values) ? widget.options.values : null;
    return skillItemsFromMeta(skills, allowed);
}

/** 打开 combo 对应的选择窗（异步取条目后展示）；extra 透传给 openSkillPickerModal（previewRenderer / onPreviewClick） */
async function openComboSkillPicker(node, widget, title, showFooter, provider, anchor, extra = {}) {
    let items = [];
    try { items = (await provider(widget)) || []; } catch (e) { console.error("[Neo Nodes] skill picker load failed", e); }
    openSkillPickerModal({
        title,
        items,
        currentValue: String(widget.value || ""),
        showFooter,
        anchor,
        onPick: (value) => setComboWidgetValue(node, widget, value),
        ...extra,
    });
}

/**
 * 拦截 ComfyUI 画布 combo widget 的点击，改为弹出技能选择窗（锚定到鼠标位置）。
 * opts: { title, showFooter(默认 true), itemsProvider(widget)->Promise<items[]>,
 *         previewRenderer(previewEl, item|null)（自定义预览卡渲染，如配方时间轴）, onPreviewClick(item)（点预览卡动作，默认打开技能详情）, onClose()（选择窗关闭时回调，供调用方清理预览卡资源） }
 * 新版前端 processWidgetClick 只认 onPointerDown 返回真值来短路原生 combo 下拉；
 * 其 pointer 参数没有视口坐标，因此用 document 捕获阶段记录的真实 pointerdown 坐标做锚点。
 * 不能挂 widget.mouse：processMouseMove 也会调用它，会导致悬停/点击别处时重复弹窗。
 */
let _neoLastPointer = null;
function ensureNeoPointerTracker() {
    if (_neoLastPointer) return;
    _neoLastPointer = { x: 0, y: 0 };
    document.addEventListener("pointerdown", (e) => {
        _neoLastPointer.x = e.clientX;
        _neoLastPointer.y = e.clientY;
    }, true);
}

function attachSkillPickerToComboWidget(widget, opts = {}) {
    if (!widget || widget.__neoSkillPickerAttached) return;
    const showFooter = opts.showFooter !== false;
    const provider = typeof opts.itemsProvider === "function" ? opts.itemsProvider : defaultSkillItemsProvider;
    const extra = {};
    if (typeof opts.previewRenderer === "function") extra.previewRenderer = opts.previewRenderer;
    if (typeof opts.onPreviewClick === "function") extra.onPreviewClick = opts.onPreviewClick;
    if (typeof opts.onClose === "function") extra.onClose = opts.onClose;
    ensureNeoPointerTracker();
    const node = widget.node;
    widget.onPointerDown = () => {
        openComboSkillPicker(node || widget.node, widget, null, showFooter, provider, { clientX: _neoLastPointer.x, clientY: _neoLastPointer.y }, extra);
        return true;
    };
    widget.__neoSkillPickerAttached = true;
}

/** 拦截原生 <select>（导演编辑器分段技能下拉）：点击弹居中搜索窗，选中写回 select.value。
 *  option 可携带 __skillMeta（listVideoSkills 元数据），透传给选择窗条目以渲染浮动预览卡 */
function attachSkillPickerToSelect(selectEl, opts = {}) {
    if (!selectEl || selectEl.__neoSkillPickerAttached) return;
    const title = opts.title || "选择视频技能";
    selectEl.__neoSkillPickerAttached = true;
    selectEl.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 阻止原生下拉展开
        const items = Array.from(selectEl.options)
            .filter((o) => o.value !== "")
            .map((o) => {
                const meta = o.__skillMeta || {};
                return {
                    value: o.value,
                    skillId: meta.id || o.value,
                    label: String(o.textContent || o.value).trim(),
                    source: (o.dataset && o.dataset.source) || "custom",
                    group: CATEGORY_LABELS[meta.category]?.label || "",
                    genImage: !!meta.gen_image,
                    genVideo: !!meta.gen_video,
                    genConfig: (meta.gen_config && typeof meta.gen_config === "object") ? meta.gen_config : null,
                };
            });
        openSkillPickerModal({
            title,
            items,
            currentValue: selectEl.value,
            anchor: selectEl,
            showFooter: false,
            onPick: (value) => {
                if (selectEl.value !== value) {
                    selectEl.value = value;
                    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                }
            },
        });
    });
}

// ==========================================
// 技能下拉组装：原生 select（数据源）+ 可搜索组件 + 底部管理工具栏 + 行内操作一体创建。
// prompt-manager 只需 const { selectEl, combo } = createSkillDropdown() 并挂载 combo.box；
// 选项填充仍走 populateSkillOptions(selectEl, skills)，combo 自动跟随（选项带 data-source 供行内操作判断）。
// ==========================================

function createSkillDropdown() {
    const selectEl = mkEl("select", "rs-tpl-selector");
    selectEl.title = "Select a skill";

    // 底部工具栏：+ New Skill / ⬆ ZIP / ⬆ Folder / 📋 From Canvas —— 管理入口（与技能选择弹窗共用同一组按钮）
    const skillFooter = mkEl("div", "rs-skill-dropdown-footer");
    buildSkillManagementButtons(() => combo.close()).forEach((b) => skillFooter.appendChild(b));

    // 浮动预览卡：与选择窗同款，挂在 body 上（fixed），跟随焦点行；所有技能可预览
    // （生成技能 = 配置摘要，其余 = skill.md 模板正文摘录），点击打开详情弹窗
    let skillPreview = null;
    let previewFocusItem = null;
    let previewFocusRow = null;
    const ensureSkillPreview = () => {
        if (skillPreview) return skillPreview;
        skillPreview = mkEl("div", "rs-skill-picker-preview rs-skill-picker-preview--fixed");
        skillPreview.style.display = "none";
        skillPreview.title = "点击打开技能详情";
        // stopPropagation 必须：combo 点外关闭是 document mousedown，不拦的话列表先关、click 到不了卡片（同 viewBtn / 底部按钮）
        skillPreview.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // 不抢输入框焦点
        skillPreview.addEventListener("click", () => {
            const it = previewFocusItem;
            if (!it) return;
            combo.close();
            getSkillDetailPopup().openExisting(it.skillId, it.source);
        });
        document.body.appendChild(skillPreview);
        return skillPreview;
    };
    // 未保存主模型的生成技能需拉模型列表取自动建议（与选择窗 / 详情弹窗同源）
    let genModels = null;
    let videoModels = null;
    const onItemFocus = (itemEl) => {
        const val = itemEl && itemEl.dataset.value;
        const opt = val ? [...selectEl.options].find((o) => o.value === val) : null;
        if (!opt) {
            previewFocusItem = null;
            previewFocusRow = null;
            if (skillPreview) skillPreview.style.display = "none";
            return;
        }
        const meta = opt.__skillMeta || {};
        previewFocusItem = {
            value: val,
            skillId: meta.id || val,
            label: meta.name || String(opt.textContent || val).trim(),
            source: (opt.dataset && opt.dataset.source) || "custom",
            genImage: !!meta.gen_image,
            genVideo: !!meta.gen_video,
            genConfig: (meta.gen_config && typeof meta.gen_config === "object") ? meta.gen_config : null,
        };
        previewFocusRow = itemEl;
        const preview = ensureSkillPreview();
        preview.style.display = "";
        renderSkillPreview(preview, previewFocusItem, { genModels, videoModels });
        positionPreviewCard(preview, itemEl.getBoundingClientRect());
        if ((previewFocusItem.genImage || previewFocusItem.genVideo) && !(previewFocusItem.genConfig && previewFocusItem.genConfig.model)) {
            const focusToken = previewFocusItem;
            ensurePreviewModelLists().then((m) => {
                genModels = m.genModels;
                videoModels = m.videoModels;
                if (previewFocusItem !== focusToken) return; // 焦点已切走，丢弃过期结果
                renderSkillPreview(preview, previewFocusItem, { genModels, videoModels });
                positionPreviewCard(preview, previewFocusRow.getBoundingClientRect());
            });
        }
    };
    window.addEventListener("resize", () => {
        if (skillPreview && skillPreview.style.display !== "none" && previewFocusRow) {
            positionPreviewCard(skillPreview, previewFocusRow.getBoundingClientRect());
        }
    });

    // combo 声明在其后：footer / 预览卡闭包只在用户交互时执行，届时 combo 已赋值
    const combo = attachComboBox(selectEl, {
        placeholder: "🔍 输入过滤 skill...",
        emptyText: "无匹配 skill",
        listMinWidth: 306,
        footerEl: skillFooter,
        onItemFocus,
    });

    // hover 已选 skill 时右侧出现 👁 按钮，点击打开详情弹窗（覆盖 caret 区域）
    const wrap = combo.box.firstElementChild;
    const viewBtn = mkEl("button", "rs-skill-view-btn");
    viewBtn.type = "button";
    viewBtn.textContent = "👁";
    viewBtn.title = "查看当前技能详情";
    viewBtn.style.cssText = "position:absolute;right:24px;top:50%;transform:translateY(-50%);opacity:0;pointer-events:none;background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:#ccc;z-index:2;transition:opacity .15s;line-height:1;";
    viewBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = selectEl.value;
        if (!val) return;
        const selOpt = selectEl.selectedOptions[0];
        const source = (selOpt && selOpt.dataset && selOpt.dataset.source) || "custom";
        getSkillDetailPopup().openExisting(val, source);
    });
    wrap.appendChild(viewBtn);
    combo.box.addEventListener("mouseenter", () => {
        const val = selectEl.value;
        if (!val) return;
        const selOpt = selectEl.selectedOptions[0];
        const source = (selOpt && selOpt.dataset && selOpt.dataset.source) || "custom";
        if (source === "preset") return; // 预设只读，不显示查看按钮
        viewBtn.style.opacity = "1";
        viewBtn.style.pointerEvents = "auto";
    });
    combo.box.addEventListener("mouseleave", () => {
        viewBtn.style.opacity = "0"; viewBtn.style.pointerEvents = "none";
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
    validateSkillForNode,
    invalidateSkillValidation,
    openSkillDetailById,
    createSkillStatusRow,
    SKILL_CHANGED_EVENT,
    CATEGORY_LABELS,
    renderMarkdown,
    createSkillDetailPopup,
    createSkillDropdown,
    openSkillPickerModal,
    attachSkillPickerToComboWidget,
    attachSkillPickerToSelect
};