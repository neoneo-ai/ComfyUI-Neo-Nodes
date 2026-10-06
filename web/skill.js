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
import { checkWorkflow, renderWorkflowGraph, applyWorkflowParams, validateWorkflow, injectRuntimeLoras, canvasLayout } from "./workflow-graph.js";
// 仅事件回调内调用（复制补带 workflow/config、画布导出为生图技能、每技能生图设置、选择窗预览卡自动默认值）；与 image-gen.js 的循环导入均为延迟使用，安全
import { copySkillFiles, saveWorkflowSkill, updateWorkflowSkill, getSkillGenConfig, saveSkillGenConfig, listGenModels, createModelConfigSection, createGenSizeRows, createVideoModelConfigSection, listVideoGenModels, shortModelName, videoSuggestion, videoAudioVaeSuggestion, videoVideoVaeSuggestion } from "./image-gen.js";
import { showToast } from "./gallery-utils.js";
import { actionToast } from "./toast.js";
import { openModelHub } from "./model-hub.js";

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
        values.STEPS = Number.isFinite(cfg.steps) && cfg.steps > 0 ? cfg.steps : 20;
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

// 画布 import 的 number widget 的 keys：模板预渲染把纯数字串归 number（与后端 render_template typed values 一致）
const NUMERIC_WIDGET_KEYS = new Set(["width", "height", "batch_size", "seed", "steps", "length"]);

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

// 画布 widget 值归一：number widget 的纯数字串归 number、提示词占串清空（与后端 render_template 的 typed values 一致）
function toCanvasTypedValues(wf) {
    for (const node of Object.values(wf)) {
        const inputs = (node || {}).inputs;
        if (!inputs) continue;
        for (const [k, v] of Object.entries(inputs)) {
            if (typeof v !== "string") continue;
            const s = v.split("{{PROMPT}}").join("").split("{{NEGATIVE}}").join("");
            inputs[k] = NUMERIC_WIDGET_KEYS.has(k) && /^\d+$/.test(s) ? Number(s) : s;
        }
    }
    return wf;
}

// 画布导入按技能已保存配置灌 widget：画布导出成技能时只有主链值被占位符化（生图 steps、SeedNode.seed
// 等保持写死），只替换 {{TOKEN}} 会让画布显示导出时的旧值。这里按后端 _template_from_workflow /
// _template_video_from_workflow 的同一套键位，把技能 config 推出的值覆盖进图里已存在的 widget；
// 连线输入不动，模板里没有的槽位不加。
const CONFIG_WIDGET_TARGETS = {
    UNETLoader: { unet_name: "MODEL" },
    CLIPLoader: { clip_name: "TEXT_ENCODER" },
    KSampler: { seed: "SEED", steps: "STEPS" },
    KSamplerAdvanced: { seed: "SEED", steps: "STEPS" },
    SeedNode: { seed: "SEED" },
    EmptyLatentImage: { width: "WIDTH", height: "HEIGHT", batch_size: "COUNT" },
    EmptySD3LatentImage: { width: "WIDTH", height: "HEIGHT", batch_size: "COUNT" },
    SaveImage: { filename_prefix: "PREFIX" },
};
const MINIMAX_H3_TARGETS = { width: "WIDTH", height: "HEIGHT", length: "LENGTH" };
const NUMERIC_WIDGET_FIELDS = new Set(["seed", "steps", "width", "height", "batch_size", "length"]);

function forceCanvasConfigValues(wf, values, isVideo) {
    // 与后端一致：喂 VAEDecodeAudio 的 VAELoader 是音频 VAE，灌 AUDIO_VAE 而不是视频 VAE
    const audioVaeIds = new Set();
    for (const node of Object.values(wf)) {
        const vae = node && node.class_type === "VAEDecodeAudio" ? (node.inputs || {}).vae : null;
        if (Array.isArray(vae)) audioVaeIds.add(String(vae[0]));
    }
    for (const [id, node] of Object.entries(wf)) {
        const ct = (node || {}).class_type;
        if (!ct) continue;
        const targets = ct.startsWith("MiniMaxH3") ? MINIMAX_H3_TARGETS
            : ct === "VAELoader" ? { vae_name: isVideo && audioVaeIds.has(id) ? "AUDIO_VAE" : "VAE" }
                : CONFIG_WIDGET_TARGETS[ct];
        if (!targets) continue;
        const inputs = node.inputs || {};
        for (const [key, valueKey] of Object.entries(targets)) {
            if (!(key in inputs) || Array.isArray(inputs[key])) continue;
            const raw = values[valueKey];
            if (raw === undefined || raw === null || raw === "") continue;
            if (!NUMERIC_WIDGET_FIELDS.has(key)) { inputs[key] = String(raw); continue; }
            const num = Number(raw);
            if (Number.isFinite(num)) inputs[key] = num;
        }
    }
    return wf;
}

// 载入画布后按流程图同一套布局重排：拓扑分层 → 左到右排布、列内按上游重心堆叠、短列垂直居中，最后适配视图
function arrangeCanvasNodes(wf) {
    const nodes = app.graph && app.graph._nodes;
    if (!nodes || !nodes.length) return;
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    for (const cell of canvasLayout(wf, (id) => (byId.get(id) || {}).size)) {
        const node = byId.get(cell.id);
        if (node) node.setPos(cell.x, cell.y);
    }
    app.graph.setDirtyCanvas(true, true);
    if (typeof app.canvas?.fitViewToSelectionAnimated === "function") app.canvas.fitViewToSelectionAnimated();
}

// 整画布 API prompt 落盘指定技能 workflow.json（skill.md 正文保留；预设只读）
async function writeWorkflowToSkill(id, source) {
    if (!id) { showToast(app, "warning", "回写入技能", "技能未保存，先保存技能本体"); return false; }
    if (source === "presets") { showToast(app, "warning", "预设不可回写", "先「复制为自定义」后编辑"); return false; }
    if (typeof app.graphToPrompt !== "function") { showToast(app, "warning", "无画布", "当前视图没有画布，回写不可用"); return false; }
    try {
        const { output, error } = (await app.graphToPrompt()) || {};
        if (error || !output || !Object.keys(output).length) {
            showToast(app, "warning", "无法回写", "画布没有有效工作流" + (error?.message ? `（${error.message}）` : ""));
            return false;
        }
        const r = await updateWorkflowSkill(id, output);
        showToast(app, "success", `已回写入技能 "${r.id}"`, (r.warnings || []).join("\n"));
        document.dispatchEvent(new CustomEvent("rs.skills.updated"));
        return true;
    } catch (err) {
        showToast(app, "error", "回写入失败", err.message);
        return false;
    }
}

// ---- Studio ⇄ 主画布交接 ----
// Studio 没有 LiteGraph，工作流编辑交回主界面：技能详情「⤒ 主画布编辑」开 /?neo_wf_edit=<skill_id>，
// 主界面扩展 setup 消费该参数灌画布，toast 给「💾 回写入技能」入口（技能详情弹窗不在场也能落盘）。
const WF_EDIT_PARAM = "neo_wf_edit";
// 交接回写卡片：绑定灌入技能时那张画布（graph 实例），切走 tab 收起、切回恢复；同画布后导入的顶掉前一张
let handoffCard = null;

function openSkillWorkflowInMainUi(id) {
    if (!id) { showToast(app, "warning", "主画布编辑", "技能未保存，先保存技能本体"); return; }
    window.open(`/?${WF_EDIT_PARAM}=${encodeURIComponent(id)}`, "_blank");
}

/** 技能 workflow.json 灌进主画布：设置区不在场 → 按技能 config.json + 自动建议模型预渲染（同「导入到画布」） */
async function openSkillWorkflowOnCanvas(id) {
    const [full, wf] = await Promise.all([loadSkill(id), loadSkillWorkflow(id)]);
    if (!full || full.error) { showToast(app, "warning", "主画布编辑", `技能 "${id}" 不存在`); return; }
    if (!wf) { showToast(app, "warning", "无工作流", `技能 "${full.name || id}" 没有 workflow.json`); return; }
    if (typeof app.loadApiJson !== "function") { showToast(app, "warning", "无画布", "当前视图没有画布，导入不可用"); return; }
    const isVideo = !!full.gen_video;
    const models = isVideo ? await listVideoGenModels().catch(() => ({})) : await listGenModels().catch(() => ({}));
    const cfg = (await getSkillGenConfig(id)) || {};
    const values = workflowParamValues(isVideo, { config: cfg, models });
    values.SEED = 0;
    values.REF_WIDTH = values.WIDTH;
    values.REF_HEIGHT = values.HEIGHT;
    const canvasWf = forceCanvasConfigValues(toCanvasTypedValues(applyWorkflowParams(injectRuntimeLoras(wf, cfg.loras), values)), values, isVideo);
    try {
        await app.loadApiJson(canvasWf, id);
        arrangeCanvasNodes(canvasWf);
    } catch (e) {
        showToast(app, "error", "导入失败", String(e.message || e));
        return;
    }
    const source = full.source || "custom";
    handoffCard?.close();   // 同画布只认最后打开的技能
    // 内置 toast 不认 actionLabel / onAction（前端无此契约，按钮不渲染、5s 就消失）
    // → 走插件 action toast，「💾 回写入技能」入口才可见且留在屏上
    let unwatch = null;
    const card = actionToast({
        severity: "success",
        summary: "已导入到画布",
        detail: `技能 "${id}" 的 workflow.json 已按技能设置灌入画布（节点按流程图布局排列）。改完点「💾 回写入技能」落盘，skill.md 正文保留`,
        actionLabel: "💾 回写入技能",
        onAction: () => writeWorkflowToSkill(id, source),
        onClose: () => {
            if (handoffCard === card) handoffCard = null;
            unwatch?.();
        },
    });
    handoffCard = card;
    // 卡片绑定灌入技能时的工作流 tab：切走收起、切回恢复（换 tab 只改 store 的 activeWorkflow，
    // 画布 DOM 上没有 litegraph:set-graph 可听）
    const wfStore = app.extensionManager?.workflow;
    const boundWf = wfStore?.activeWorkflow;
    if (wfStore && boundWf && typeof wfStore.$subscribe === "function") {
        unwatch = wfStore.$subscribe(() => card.setHidden(wfStore.activeWorkflow !== boundWf));
    }
}

/** 主界面启动时消费 ?neo_wf_edit=<skill_id>：清掉参数（刷新不重复导入）后灌画布。
 *  主界面自身的初始工作流加载排在扩展 setup 之后，抢先灌图会被它覆盖 →
 *  等前端换图事件（画布 DOM 上的 litegraph:set-graph）落地，超时兜底。 */
function runSkillWorkflowHandoff() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get(WF_EDIT_PARAM);
    if (!id) return;
    params.delete(WF_EDIT_PARAM);
    const q = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
    const canvasEl = app.canvas?.canvas;
    let fired = false;
    const run = () => {
        if (fired) return;
        fired = true;
        if (canvasEl) canvasEl.removeEventListener("litegraph:set-graph", run);
        openSkillWorkflowOnCanvas(id);
    };
    if (canvasEl) canvasEl.addEventListener("litegraph:set-graph", run);
    setTimeout(run, 2000);
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
// 提示词节点技能列表：图像/视频提示词增强排最前（仅次于 select 顶部的「默认」项，原生 option 恒在 optgroup 之前），
// 反推 / 直接生图或编辑 / custom 依次跟随；video_gen（生视频）与 task 为内部使用技能，不在下拉与 / 快捷菜单显示（hidden），task 也不进技能管理窗口左列表（managerHidden）；未知分类回落 image_enhance
const CATEGORY_LABELS = {
    "image_enhance": { label: "🎨 图像提示词增强", order: 0 },
    "video_enhance": { label: "🎬 视频提示词增强", order: 1 },
    "vision": { label: "⚡ 图像 / 反推", order: 2 },
    "image_gen": { label: "🖼️ 直接生图或编辑", order: 3 },
    "custom": { label: "📝 自定义", order: 4 },
    "video_gen": { label: "🎬 生视频 (H3)", order: 5, hidden: true },
    "task": { label: "⚙️ 任务", order: 6, hidden: true, managerHidden: true }
};

/** 把 skills 元数据填充进原生 <select>：按 category 分组为 optgroup，option 带 📷(需图) 徽标与 multiTurn 标记；
 *  includeHidden=true 时连 hidden 分类（task / video_gen）一起列出 */
function populateSkillOptions(selectEl, skills, { includeHidden = false } = {}) {
    if (!skills || !skills.length) return;
    const groups = {};
    skills.forEach(s => {
        const cat = CATEGORY_LABELS[s.category] ? s.category : "image_enhance";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(s);
    });
    Object.keys(groups).sort((a, b) =>
        (CATEGORY_LABELS[a]?.order ?? 99) - (CATEGORY_LABELS[b]?.order ?? 99)
    ).filter(cat => includeHidden || !CATEGORY_LABELS[cat].hidden).forEach(cat => {
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
            opt.textContent = `${imgBadge}${s.cn_name || s.name || s.id}`;
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
    const ref = String(skill || "").trim().replace(/（不可用）$/, ""); // 下拉值可能带「（不可用）」后缀（h3_video_gen._skill_label），先剥掉再反查
    if (!ref) return "";
    const entry = _skillNameLookup[isVideo ? "video" : "image"];
    if (!entry.map || Date.now() - entry.t > SKILL_VALIDATION_TTL) {
        const list = await listSkills();
        const map = new Map();
        for (const s of Array.isArray(list) ? list : []) {
            if (!s || !s.id || !(isVideo ? s.gen_video : s.gen_image)) continue;
            map.set(String(s.id), s.id);
            if (s.cn_name) map.set(String(s.cn_name), s.id);
            if (s.name && s.name !== s.id) map.set(String(s.name), s.id);
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

/**
 * 复制技能为自定义副本（客户端 loadSkill + saveSkill，无专用后端接口）：连同 workflow.json / config.json 一起复制。
 * 详情弹窗「⧉ 复制为自定义」与技能管理列表行内「⧉」共用。成功返回 { id, name }，失败提示后返回 null。
 */
async function copySkillAsCustom(skillId, fallbackName = "") {
    const full = await loadSkill(skillId);
    if (full && full.error) { showToast(app, "error", "复制失败", full.error); return null; }
    const newId = `${skillId}_copy_${Date.now()}`;
    // 复制产生的 name 需与已有 skill 不重名（后端 save_skill 会 409），冲突时递增序号
    const baseName = ((full && full.name) || fallbackName || skillId) + " (Copy)";
    const takenNames = new Set((await listSkills()).map(s => (s.name || "").trim()));
    let copyName = baseName;
    for (let n = 2; takenNames.has(copyName); n++) copyName = `${baseName} ${n}`;
    const result = await saveSkill({
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
    if (!result.success) { showToast(app, "error", "复制失败", result.error || "Unknown error"); return null; }
    await copySkillFiles(skillId, newId);
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
    return { id: newId, name: copyName };
}

// ==========================================
// UI：createSkillDetailPopup() —— 单技能详情弹窗（查看 / 编辑 / 删除 / 复制为自定义 / 新建）
// 由技能下拉的行内操作与底部工具栏打开；overlay 挂到 document.body，跨节点共享一个实例。
// 返回 { overlay, openExisting(id, source), openNew(), close }。canvasBtns=false（Studio 内嵌，无画布）时工作流区画布按钮不挂。
// ==========================================

function createSkillDetailPopup(host, canvasBtns = true) {
    const embedded = !!host;   // 内嵌模式：modal 挂到调用方容器（统一技能管理窗口右侧），不自建遮罩、不监听全局 Esc/点遮罩
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-detail");
    const showDetail = () => { if (embedded) modal.style.display = ""; else overlay.style.display = "flex"; };

    // ---- 头部：标题 + 来源徽标 + 复制为自定义 + 关闭 ----
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = "📝 技能";
    const sourceBadge = mkEl("span", "rs-source-badge rs-skill-detail-badge");
    header.append(titleSpan, sourceBadge);
    // 「复制为自定义」放标题栏（仅预设/任务技能显示），在 ✕ 左侧
    const copyBtn = mkEl("button", "rs-btn rs-btn-local");
    copyBtn.type = "button";
    copyBtn.textContent = "⧉ 复制为自定义";
    copyBtn.title = "把这个内置技能复制为可编辑的自定义技能";
    copyBtn.style.display = "none";
    const closeBtn = mkEl("button", "rs-skill-modal-close");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.append(copyBtn, closeBtn);

    // ---- 内容：名称行 + 正文区（多文件下拉 + 预览/编辑切换）----
    const content = mkEl("div", "rs-skill-modal-content");

    // 不可用说明：依赖 VDN 加速节点的视频技能在插件未装时顶部提示（不影响查看/编辑）
    const unavailableBanner = mkEl("div", "rs-skill-unavailable-banner");
    unavailableBanner.textContent = "⚠️ 该技能依赖 VDN 加速节点（ComfyUI-VDN-H3 插件），当前未注册，暂不能用于生成。可继续查看与编辑其设置。";
    unavailableBanner.style.display = "none";

    const nameRow = mkEl("div", "rs-config-row");
    const nameLabel = mkEl("label", "rs-form-label");
    nameLabel.textContent = "技能名称";
    const nameInput = mkEl("input", "rs-form-input rs-tpl-name");
    nameInput.placeholder = "输入技能名称…";
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
    // 正文用途说明（tooltip / 标题提示）：带工作流的技能由 workflow.json 决定出图，正文一般无需修改
    const CONTENT_HINT = "技能正文（skill.md）：仅在开启「提示词增强」时作为扩写指令，或在参考图模式下作为提示词模板；出图流程由 workflow.json 决定。";
    // 标题 = caret + 文字：带工作流的技能可点标题折叠正文（默认收起）
    const contentTitle = mkEl("span", "rs-content-title");
    const contentCaret = mkEl("span", "rs-content-caret");
    contentCaret.textContent = "▾";
    const contentLabel = mkEl("label", "rs-form-label");
    contentLabel.textContent = "系统提示词内容";
    contentLabel.title = CONTENT_HINT;
    contentTitle.append(contentCaret, contentLabel);
    contentTitle.addEventListener("click", () => {
        if (!contentRow.classList.contains("rs-content-row-collapsible")) return;
        contentCollapsed = !contentCollapsed;
        updateContentCompact();
    });
    contentLeft.appendChild(contentTitle);
    // 工作流驱动的技能：标题旁提示（默认收起，点标题展开编辑）
    const contentHint = mkEl("span", "rs-content-hint");
    contentHint.textContent = "工作流驱动";
    contentHint.title = CONTENT_HINT;
    contentHint.style.display = "none";
    contentLeft.appendChild(contentHint);
    // Enhance Prompt 开关（仅生图技能显示）：LLM 提示词增强，指令即上方正文；放在标题右侧便于就近理解
    const enhancePromptWrap = mkEl("div", "rs-content-enhance");
    enhancePromptWrap.style.display = "none";
    const enhancePromptChk = document.createElement("input");
    enhancePromptChk.type = "checkbox";
    enhancePromptChk.className = "rs-gen-enhance-chk";
    const enhancePromptLabel = mkEl("label", "rs-form-label");
    enhancePromptLabel.textContent = "提示词增强";
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
    addFileBtn.textContent = "+ 文件";
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
    previewBtn.textContent = "👁 预览";
    const editBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    editBtn.type = "button";
    editBtn.textContent = "✎ 编辑";
    modeBtns.append(previewBtn, editBtn);
    contentHeader.appendChild(contentLeft);
    contentHeader.appendChild(modeBtns);
    const contentTextarea = document.createElement("textarea");
    contentTextarea.className = "rs-form-input rs-tpl-content";
    contentTextarea.style.resize = "vertical";
    contentTextarea.placeholder = "输入系统提示词内容…";
    const contentPreview = mkEl("div", "rs-md-preview");
    contentPreview.style.display = "none";
    contentRow.append(contentHeader, contentTextarea, contentPreview);

    // ---- 生图设置（仅 gen_image 技能显示）：复用全局生图设置的共享控件区，读写该技能的 config.json 覆盖 ----
    const genSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-gen-settings");
    genSettingsWrap.style.display = "none";
    const genSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const genSettingsTitle = mkEl("label", "rs-form-label");
    genSettingsTitle.textContent = "🖼️ 生图设置";
    genSettingsTitle.title = "仅对本技能生效，未填项回落全局生图设置";
    const genLocalHint = mkEl("span", "rs-gen-readonly-hint");
    genLocalHint.textContent = "预设的设置改动保存为本地覆盖，不修改预设文件";
    genLocalHint.title = "模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除";
    genLocalHint.style.display = "none";
    const genSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    genSaveCfgBtn.type = "button";
    genSaveCfgBtn.textContent = "💾 保存";
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
    videoGenSettingsTitle.textContent = "🎬 生视频设置";
    videoGenSettingsTitle.title = "仅对本技能生效，未填项回落全局「生视频模型」设置";
    const videoLocalHint = mkEl("span", "rs-gen-readonly-hint");
    videoLocalHint.textContent = "预设的设置改动保存为本地覆盖，不修改预设文件";
    videoLocalHint.title = "模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除";
    videoLocalHint.style.display = "none";
    const videoSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    videoSaveCfgBtn.type = "button";
    videoSaveCfgBtn.textContent = "💾 保存";
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
    const workflowHeader = mkEl("div", "rs-config-row rs-gen-settings-header rs-skill-workflow-head");
    const workflowCaret = mkEl("span", "rs-wf-caret");
    workflowCaret.textContent = "▾";
    const workflowTitle = mkEl("label", "rs-form-label");
    workflowTitle.textContent = "🔀 工作流（节点流程图）";
    workflowTitle.title = "技能 workflow.json 模板的自动布局；红框 = 节点未安装/模型缺失，蓝框 = 含待替换模板变量";
    const workflowBody = mkEl("div", "rs-wf-body");
    const workflowSummary = mkEl("div", "rs-wf-summary");
    workflowHeader.append(workflowCaret, workflowTitle);
    workflowHeader.title = "点击折叠 / 展开流程图";
    workflowHeader.addEventListener("click", () => setWorkflowCollapsed(!workflowWrap.classList.contains("rs-wf-collapsed")));
    // 画布 ⇄ 技能：导入把模板按当前设置预渲染、运行时占串归 concrete values 后 loadApiJson 载入画布；
    //      回写把整画布 API prompt 落盘该技能 workflow.json（skill.md 保留，预设不可回写）。
    //      Studio 内嵌无画布（canvasBtns=false）→ 只挂「⤒ 主画布编辑」，开主界面 ?neo_wf_edit=<id> 交接编辑。
    const wfCanvasBtns = mkEl("div", "rs-wf-canvas-btns");
    if (canvasBtns) {
        const wfImportBtn = mkEl("button", "rs-btn rs-wf-canvas-import-btn");
        wfImportBtn.type = "button";
        wfImportBtn.textContent = "⤒ 导入到画布";
        wfImportBtn.title = "把本技能 workflow.json 载入画布（模板变量按当前设置预渲染，参考图槽位留占串），画里后点「💾 回写入技能」落盘";
        wfImportBtn.addEventListener("click", (e) => { e.stopPropagation(); importWorkflowToCanvas(); });
        const wfWriteBtn = mkEl("button", "rs-btn rs-wf-canvas-write-btn");
        wfWriteBtn.type = "button";
        wfWriteBtn.textContent = "💾 回写入技能";
        wfWriteBtn.title = "把整画布工作流落盘本技能 workflow.json（skill.md 正文保留；预设技能不可回写）";
        wfWriteBtn.addEventListener("click", (e) => { e.stopPropagation(); writeWorkflowBackToSkill(); });
        wfCanvasBtns.append(wfImportBtn, wfWriteBtn);
    } else {
        const wfOpenBtn = mkEl("button", "rs-btn rs-wf-canvas-import-btn");
        wfOpenBtn.type = "button";
        wfOpenBtn.textContent = "⤒ 主画布编辑";
        wfOpenBtn.title = "在主 ComfyUI 界面打开本技能 workflow.json 编辑（按技能设置预渲染），改完点「💾 回写入技能」落盘本技能";
        wfOpenBtn.addEventListener("click", (e) => { e.stopPropagation(); openSkillWorkflowInMainUi(currentSkillId); });
        wfCanvasBtns.append(wfOpenBtn);
    }
    workflowHeader.append(wfCanvasBtns);
    // 工作流区两模式：只读流程图 ⇄ 内嵌 litegraph 编辑（前端未暴露 LiteGraph 的视图不提供编辑模式）
    const wfEditorSupported = !!window.LGraph && !!window.LGraphCanvas && !!window.LiteGraph;
    const wfModeBtns = mkEl("div", "rs-content-mode rs-wf-mode-btns");
    const wfViewBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    wfViewBtn.type = "button";
    wfViewBtn.textContent = "👁 流程图";
    wfViewBtn.title = "只读流程图：workflow.json 模板自动布局 + 校验标注";
    const wfEditBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    wfEditBtn.type = "button";
    wfEditBtn.textContent = "🧩 编辑";
    wfEditBtn.title = "在窗口内编辑 workflow.json 模板（widget 按本技能 config 初始化，保存写回 workflow.json 与 config.json）";
    if (!wfEditorSupported) wfEditBtn.style.display = "none";
    wfModeBtns.append(wfViewBtn, wfEditBtn);
    workflowHeader.append(wfModeBtns);

    const wfEditWrap = mkEl("div", "rs-wf-editor");
    wfEditWrap.style.display = "none";
    const wfEditBar = mkEl("div", "rs-wf-editor-bar");
    const wfSaveBtn = mkEl("button", "rs-btn rs-btn-local");
    wfSaveBtn.type = "button";
    wfSaveBtn.textContent = "💾 保存工作流";
    wfSaveBtn.title = "把画布上的工作流写回本技能 workflow.json，并把画布上的模型 / 尺寸 / 张数 / 前缀同步进 config.json（提示词等运行时变量原样保留）";
    const wfReloadBtn = mkEl("button", "rs-btn rs-btn-local");
    wfReloadBtn.type = "button";
    wfReloadBtn.textContent = "↺ 重新载入";
    wfReloadBtn.title = "丢弃画布上的改动，按技能当前 workflow.json 与 config 重载";
    const wfFitBtn = mkEl("button", "rs-btn rs-btn-local");
    wfFitBtn.type = "button";
    wfFitBtn.textContent = "🧭 适配视图";
    wfEditBar.append(wfSaveBtn, wfReloadBtn, wfFitBtn);
    const wfCanvasBox = mkEl("div", "rs-wf-editor-canvas-box");
    wfEditWrap.append(wfEditBar, wfCanvasBox);
    workflowWrap.append(workflowHeader, workflowBody, workflowSummary, wfEditWrap);

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
    // 修复项 → 模型库落盘类别；失效文件名去目录与扩展名后作为模型库搜索词
    const REPAIR_FIELD_CATEGORY = { model: "diffusion_models", text_encoder: "text_encoders", vae: "vae", audio_vae: "audio_vae", lora: "loras" };
    const repairHubQuery = (value) => String(value || "").split(/[\\/]/).pop().replace(/\.(safetensors|bin|pth|pt|ckpt|gguf|onnx|npz)$/i, "");

    // 「修复失效路径」应用后重渲染工作流图：用当前设置区值重新预渲染模板并重新校验，清掉已修好的红框（复用已加载的原始模板，不重新拉 workflow.json）
    async function refreshWorkflowGraph() {
        if (!workflowShown || !currentSkillId || !skillWorkflowRaw) return;
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        const cfg = isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() };
        await renderWorkflowPreview(skillWorkflowRaw, { config: cfg, models: (loadedGenInfo && loadedGenInfo.models) || {} }, isVideo, currentSkillId);
    }

    // ---- 画布 ⇄ 技能：把技能模板归画布可 load 的 API prompt（已知参数按设置预渲染、运行时占串归 concrete values
    //      与后端 render_template 的 typed values 一致：number widget 的纯数字串归 number；参考图槽位留 {{REF_IMAGE}} 占串）
    function canvasWorkflow() {
        if (!skillWorkflowRaw) return null;
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        const cfg = isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() };
        const values = workflowParamValues(isVideo, { config: cfg, models: (loadedGenInfo && loadedGenInfo.models) || {} });
        values.SEED = 0;
        values.REF_WIDTH = values.WIDTH;
        values.REF_HEIGHT = values.HEIGHT;
        return forceCanvasConfigValues(toCanvasTypedValues(applyWorkflowParams(injectRuntimeLoras(skillWorkflowRaw, cfg.loras), values)), values, isVideo);
    }

    // 内嵌编辑的初始图：模板按技能已保存 config 灌 widget（模型 / 尺寸 / 张数 / 前缀 / 步数 / 视频宽高时长），
    // 超出模板槽位的 LoRA 同运行时一样动态注入；提示词 / 种子 / 参考图 / LoRA 槽位等运行时 {{变量}} 原样保留
    // → 保存时后端按同一套键位重新占位符化并回写 config。
    function editorTemplateWorkflow() {
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        const cfg = isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() };
        const values = workflowParamValues(isVideo, { config: cfg, models: (loadedGenInfo && loadedGenInfo.models) || {} });
        const wf = JSON.parse(JSON.stringify(skillWorkflowRaw));
        return forceCanvasConfigValues(injectRuntimeLoras(wf, cfg.loras), values, isVideo);
    }

    async function importWorkflowToCanvas() {
        if (!skillWorkflowRaw) { showToast(app, "warning", "无工作流", "本技能没有 workflow.json"); return; }
        if (typeof app.loadApiJson !== "function") { showToast(app, "warning", "无画布", "当前视图没有画布，导入不可用"); return; }
        const wf = canvasWorkflow();
        if (!wf) return;
        try {
            await app.loadApiJson(wf, currentSkillId);
            arrangeCanvasNodes(wf);
        } catch (e) {
            showToast(app, "error", "导入失败", String(e.message || e));
            return;
        }
        showToast(app, "success", "已导入到画布",
            `点「💾 回写入技能」把整画布落盘 "${currentSkillId}" 的 workflow.json（节点已按流程图布局自动排列，skill.md 正文保留）`);
    }

    async function writeWorkflowBackToSkill() {
        await writeWorkflowToSkill(currentSkillId, currentSource);
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

            // 本地缺这个模型 → 直接进模型库搜索下载（预填失效文件名 + 对应落盘类别）
            const hubBtn = mkEl("button", "rs-repair-hub-btn");
            hubBtn.type = "button";
            hubBtn.textContent = "📥 模型库";
            hubBtn.title = "在模型库（Comfy-Org · Hugging Face / ModelScope）搜索并下载此模型";
            hubBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openModelHub({
                    query: repairHubQuery(r.value),
                    category: REPAIR_FIELD_CATEGORY[r.kind === "lora" ? "lora" : r.key] || "",
                });
            });
            row.appendChild(hubBtn);

            // LoRA 无本地候选时，提供 C站搜索下载按钮
            if (r.kind === "lora" && !r.suggestion && !(r.candidates && r.candidates.length)) {
                const civBtn = mkEl("button", "rs-repair-civitai-btn");
                civBtn.type = "button";
                civBtn.textContent = "🔍 C站";
                civBtn.title = "从 Civitai 搜索并下载此 LoRA";
                const subPanel = mkEl("div", "rs-repair-civitai-panel");
                subPanel.style.display = "none";
                civBtn.addEventListener("click", async () => {
                    if (subPanel.style.display !== "none") { subPanel.style.display = "none"; return; }
                    subPanel.innerHTML = '<span class="rs-civ-loading">搜索中…</span>';
                    subPanel.style.display = "block";
                    try {
                        const resp = await fetch("/neo_nodes/civitai_search_lora", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ query: r.value }),
                        });
                        const data = await resp.json();
                        if (!data.success) throw new Error(data.error || "搜索失败");
                        subPanel.innerHTML = "";
                        const items = data.items || [];
                        if (!items.length) {
                            subPanel.innerHTML = '<span class="rs-civ-empty">未找到匹配的 LoRA</span>';
                            return;
                        }
                        for (const it of items.slice(0, 6)) {
                            const itemRow = mkEl("div", "rs-civ-item");
                            const info = mkEl("span", "rs-civ-info");
                            const sizeStr = it.file_size ? ` (${(it.file_size / 1024 / 1024).toFixed(1)} MB)` : "";
                            info.textContent = `${it.name} — ${it.author || "?"}${sizeStr}`;
                            info.title = it.file_name || "";
                            const dlBtn = mkEl("button", "rs-civ-dl-btn");
                            dlBtn.type = "button";
                            dlBtn.textContent = "下载";
                            dlBtn.addEventListener("click", async () => {
                                dlBtn.disabled = true;
                                dlBtn.textContent = "下载中…";
                                try {
                                    const dResp = await fetch("/neo_nodes/civitai_download_lora", {
                                        method: "POST", headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ url: it.download_url, filename: it.file_name }),
                                    });
                                    const dData = await dResp.json();
                                    if (!dData.success) throw new Error(dData.error || "下载失败");
                                    // 下载成功：把文件名加入 select 并选中
                                    const fname = dData.filename;
                                    addOpt(fname, `${shortModelName(fname)}（已下载）`);
                                    sel.value = fname;
                                    subPanel.style.display = "none";
                                    showToast(app, "success", `LoRA 已下载: ${fname}`);
                                } catch (e) {
                                    dlBtn.disabled = false;
                                    dlBtn.textContent = "重试";
                                    showToast(app, "error", "下载失败", String(e.message || e));
                                }
                            });
                            itemRow.append(info, dlBtn);
                            subPanel.appendChild(itemRow);
                        }
                    } catch (e) {
                        subPanel.innerHTML = `<span class="rs-civ-err">${e.message || "搜索出错"}</span>`;
                    }
                });
                row.appendChild(civBtn);
                body.appendChild(row);
                body.appendChild(subPanel);
            } else {
                body.appendChild(row);
            }
            selects.push(sel);
        }

        const foot = mkEl("div", "rs-repair-foot");
        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = "套用后自动保存到 config.json";
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

        applyBtn.addEventListener("click", async () => {
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
            // 直接保存设置区到 config.json
            try {
                if (isCustom()) {
                    await persistGenSettings();
                } else {
                    await savePresetGenSettings();
                }
                showToast(app, "success", `已修复 ${n} 项并保存`);
            } catch (err) {
                showToast(app, "error", "保存失败", String(err.message || err));
            }
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

    // ---- 底部按钮：随状态显隐（保存 / 删除）；关闭走标题栏 ✕，复制走标题栏「复制为自定义」----
    const footerBtns = mkEl("div", "rs-modal-btns rs-skill-detail-actions");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = "💾 保存";
    const deleteBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    deleteBtn.textContent = "🗑 删除";
    footerBtns.append(saveBtn, deleteBtn);

    // 主区两栏：左 = 生图/生视频设置，右 = 系统提示词内容（面板够宽时并排；窄面板堆叠且系统提示词在上，顺序由 CSS 控制）
    const mainRow = mkEl("div", "rs-skill-detail-main");
    const settingsCol = mkEl("div", "rs-skill-detail-settings");
    settingsCol.append(genSettingsWrap, videoGenSettingsWrap);
    mainRow.append(contentRow, settingsCol);
    // 普通技能（无生图/生视频设置区）隐藏左栏，正文占满整行
    const syncSettingsColumn = () => {
        const on = genSettingsWrap.style.display !== "none" || videoGenSettingsWrap.style.display !== "none";
        settingsCol.style.display = on ? "" : "none";
    };

    content.append(unavailableBanner, nameRow, multiTurnRow, mainRow, workflowWrap, footerBtns);
    modal.append(header, content);
    if (embedded) { modal.style.display = "none"; host.appendChild(modal); }
    else { overlay.appendChild(modal); document.body.appendChild(overlay); }

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
    let contentCollapsed = true; // 正文是否收起（仅带 workflow.json 的技能可折叠；默认收起）
    let workflowExpanded = false; // 工作流区是否展开（默认折叠；展开时流程图占据高度、正文区减半让位）
    let contentBaseline = null;   // { name, content, multiTurn } 加载/新建后的快照，关闭时判断正文有无未保存修改
    let genSettingsBaseline = null;   // 生图/生视频设置区 collect() 的 JSON 快照（load/save 后刷新）；null = 无设置区
    let loadedGenInfo = null;         // 最近一次 loadGenSettings/loadVideoGenSettings 返回的 { config, models }，供「修复失效路径」回填复用
    let skillWorkflowRaw = null;     // 最近加载的技能 workflow.json 原始模板（「修复失效路径」后重渲染复用，避免重新拉取）
    let currentIsVideo = false;      // 当前技能是否生视频（内嵌编辑保存后重渲染流程图取对应设置）
    let wfGraph = null, wfCanvas = null;   // 内嵌编辑模式的子图与画布（null = 未挂载）

    // 折叠/展开工作流区：折叠时隐藏流程图与摘要，正文区恢复完整高度
    function setWorkflowCollapsed(collapsed) {
        workflowExpanded = !collapsed;
        workflowWrap.classList.toggle("rs-wf-collapsed", collapsed);
        workflowCaret.textContent = collapsed ? "▸" : "▾";
        if (collapsed && wfCanvas) setWfMode("view");   // 折叠 → 卸载内嵌画布，回到只读流程图
        updateContentCompact();
    }
    function resetWorkflowCollapse() {
        setWorkflowCollapsed(true);   // 每次打开技能：工作流区默认折叠
    }

    // ---- 内嵌 litegraph 编辑（workflow.json 模板）----
    // 编辑模式把模板按技能 config 初始化后灌进独立 LGraph + LGraphCanvas（与「导入到画布」同一套
    // widget 键位），保存走 app.graphToPrompt(子图) → updateWorkflowSkill 写回本技能 workflow.json
    // 并同步 config.json，提示词 / 种子 / 参考图等 {{运行时变量}} 原样保留。
    // LiteGraph.configure 只认 litegraph 序列化，API prompt 必须先转换：节点按注册模板实例化取
    // 真实 widget 顺序与槽位顺序，widget 值按名对齐，连线按 API 的 [id, slot] 落到目标槽位名。
    function apiPromptToLitegraph(api) {
        const LiteGraph = window.LiteGraph;
        const infos = Object.entries(api).map(([id, def]) => ({ id: Number(id), def: def || {}, node: LiteGraph.createNode((def || {}).class_type) }));
        const byId = new Map(infos.filter((i) => i.node).map((i) => [i.id, i]));
        const missing = infos.filter((i) => !i.node).map((i) => (i.def || {}).class_type);
        const nodes = [], links = [];
        for (const info of infos) {
            if (!info.node) continue;
            const inputs = info.def.inputs || {};
            const widgets = info.node.widgets || [];
            info.out = {
                id: info.id, type: info.node.type, pos: [0, 0], size: [info.node.size[0], info.node.size[1]],
                flags: info.node.flags || {}, mode: info.node.mode || 0, order: (info.def._meta || {}).order || 0,
                properties: {},
                // 按节点自身 widget 顺序取值：createNode 出来的节点只有带默认值的 widgets，
                // widgets_values 要 configure / serialize 才填 → 从它取会整批丢值，画布只剩节点默认值
                widgets_values: widgets.map((w) => (Object.prototype.hasOwnProperty.call(inputs, w.name) ? inputs[w.name] : w.value)),
                inputs: (info.node.inputs || []).map((s) => ({ name: s.name, type: s.type, link: null })),
                outputs: (info.node.outputs || []).map((s) => ({ name: s.name, type: s.type, links: null })),
            };
            nodes.push(info.out);
        }
        for (const info of infos) {
            if (!info.out) continue;
            for (const [name, ref] of Object.entries(info.def.inputs || {})) {
                if (!Array.isArray(ref)) continue;
                const origin = byId.get(Number(ref[0]));
                const slot = info.out.inputs.findIndex((s) => s.name === name);
                if (!origin || !origin.out || slot < 0 || !origin.out.outputs[ref[1]]) continue;
                const linkId = links.length + 1;
                links.push([linkId, origin.id, ref[1], info.id, slot, ref.length >= 5 ? ref[4] : ref[2] || "COMBO"]);
                info.out.inputs[slot].link = linkId;
                (origin.out.outputs[ref[1]].links || (origin.out.outputs[ref[1]].links = [])).push(linkId);
            }
        }
        const lite = {
            id: 1, version: 0.4, nodes, links, groups: [], config: {},
            last_node_id: nodes.reduce((m, n) => Math.max(m, n.id), 0), last_link_id: links.length, last_group_id: 0,
        };
        return { lite, missing };
    }

    function refitWfCanvas() {
        if (!wfCanvas) return;
        const w = wfCanvasBox.clientWidth || 800, h = wfCanvasBox.clientHeight || 420;
        // litegraph 约定后备缓冲 = CSS 尺寸 × dpr、前层 ctx 按 dpr 缩放（同前端 resizeCanvas）：
        // 只按 CSS 像素下发会让背景层只铺满 1/dpr 的画布（125% 缩放下画布看着只剩 80% 大小）
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        wfCanvas.resize(Math.round(w * dpr), Math.round(h * dpr));
        wfCanvas.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);   // canvas.width 赋值会重置 ctx 变换
        const nodes = (wfCanvas.graph && wfCanvas.graph._nodes) || [];
        if (nodes.length) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const n of nodes) {
                x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1]);
                x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]);
            }
            const sc = Math.min(1, w / (x1 - x0 + 160), h / (y1 - y0 + 160));
            wfCanvas.ds.scale = sc;
            wfCanvas.ds.offset = [w / (2 * sc) - (x0 + x1) / 2, h / (2 * sc) - (y0 + y1) / 2];
        }
        wfCanvas.setDirty(true, true);
        wfCanvas.draw(true, true);
    }

    // 盒子尺寸变化（窗口缩放 / ⛶ 放大还原 / 把手拉伸 / 左栏分隔条拖动）后重适配内嵌画布
    const wfBoxResize = new ResizeObserver(() => refitWfCanvas());

    function destroyWfEditor() {
        if (wfCanvas) {
            wfCanvas.stopRendering();
            wfCanvas.unbindEvents();
            wfCanvas = null;
        }
        if (wfGraph) {
            for (const n of [...wfGraph._nodes]) wfGraph.removeNode(n);   // 逐节点走 litegraph 生命周期（断线、DOM widget 清理）
            wfGraph.clear();
            wfGraph = null;
        }
        wfBoxResize.disconnect();
        wfCanvasBox.innerHTML = "";
    }

    function mountWfEditor() {
        if (wfCanvas) return true;
        if (!skillWorkflowRaw) { showToast(app, "warning", "无工作流", "本技能没有 workflow.json"); return false; }
        const LGraph = window.LGraph, LGraphCanvas = window.LGraphCanvas;
        if (!LGraph || !LGraphCanvas) { showToast(app, "warning", "无内嵌画布", "当前视图没有 LiteGraph，请用「⤒ 导入到画布」编辑"); return false; }
        const wf = editorTemplateWorkflow();
        const { lite, missing } = apiPromptToLitegraph(wf);
        // 未注册节点直接进编辑会在保存时把该节点从 workflow.json 里丢掉，拒绝并退回只读预览
        if (missing.length) { showToast(app, "warning", "无法内嵌编辑", `节点类型未注册：${missing.join("、")}，请用「⤒ 导入到画布」编辑`); return false; }
        const g = new LGraph();
        g.configure(lite);
        // 自动布局：与「导入到画布」同一套列号与重心排布，位置按节点真实尺寸推导
        for (const cell of canvasLayout(wf, (id) => (g.getNodeById(id) || {}).size)) {
            const n = g.getNodeById(cell.id);
            if (n) n.pos = [cell.x, cell.y];
        }
        g.start();
        wfGraph = g;
        const canvasEl = mkEl("canvas", "rs-wf-editor-canvas");
        wfCanvasBox.appendChild(canvasEl);
        wfCanvas = new LGraphCanvas(canvasEl, g);
        // litegraph 的 widget 弹窗按「clientX - canvas.getBoundingClientRect().left」定位：主画布左上角
        // 就是视口原点所以看不出问题，内嵌画布在窗口里偏移几百像素，弹窗会飞到鼠标左上方。
        // 前端 CSS 里 .graphdialog 是 position:fixed，落点直接按视口坐标下发。
        const basePrompt = wfCanvas.prompt;
        wfCanvas.prompt = function (name, value, callback, event, multiline) {
            const r = basePrompt.call(this, name, value, callback, event, multiline);
            const dlg = this.prompt_box;
            if (!dlg) return r;
            const rect = canvasEl.getBoundingClientRect();
            dlg.style.left = `${(event ? event.clientX : rect.left + rect.width / 2) - 20}px`;
            dlg.style.top = `${(event ? event.clientY : rect.top + rect.height / 2) - 20}px`;
            dlg.style.zIndex = "10000";   // .graphdialog 基础层只有 1000，会被技能弹窗（9846）盖住
            return r;
        };
        wfBoxResize.observe(wfCanvasBox);
        return true;
    }

    function setWfMode(mode) {
        if (mode === "edit") {
            if (!mountWfEditor()) return;
            if (!workflowExpanded) setWorkflowCollapsed(false);
        }
        const editing = mode === "edit";
        workflowBody.style.display = editing ? "none" : "";
        workflowSummary.style.display = editing ? "none" : "";
        wfEditWrap.style.display = editing ? "flex" : "none";
        wfViewBtn.classList.toggle("rs-content-mode-active", !editing);
        wfEditBtn.classList.toggle("rs-content-mode-active", editing);
        wfSaveBtn.style.display = isCustom() ? "" : "none";
        modal.classList.toggle("rs-wf-editing", editing);   // 编辑态：卡片吃满内容区剩余高度，设置区让位给画布
        if (editing) requestAnimationFrame(refitWfCanvas);   // 显示后画布才有尺寸，此时再适配
        else destroyWfEditor();
    }

    // 只读流程图：先按模板变量画蓝框预检，/object_info·/models/* 校验在后台完成后原地补红框
    async function renderWorkflowPreview(wf, genInfo, isVideo, seqId) {
        // 超出模板槽位的 LoRA 运行时动态插入（同后端 _apply_loras：在 render_template 之后、LoRA 槽位填充之前执行，流程图与真实提交一致）
        const rendered = applyWorkflowParams(injectRuntimeLoras(wf, ((genInfo || {}).config || {}).loras), workflowParamValues(isVideo, genInfo));
        renderWorkflowGraph(workflowBody, rendered, validateWorkflow(rendered, null, {}), workflowSummary);   // 内部先清空占位再画
        const validation = await checkWorkflow(rendered);   // /object_info + /models/*，失败内部按跳过处理
        if (currentSkillId === seqId && workflowShown) {   // 等待期间切了技能/关区 → 丢弃过期结果
            const sl = workflowBody.scrollLeft, st = workflowBody.scrollTop;
            renderWorkflowGraph(workflowBody, rendered, validation, workflowSummary);
            workflowBody.scrollLeft = sl;
            workflowBody.scrollTop = st;
        }
    }

    async function saveWorkflowFromEditor() {
        if (!currentSkillId) { showToast(app, "warning", "保存工作流", "请先保存技能本体"); return; }
        if (currentSource === "presets") { showToast(app, "warning", "预设不可回写", "先「复制为自定义」再编辑工作流"); return; }
        if (!wfGraph) return;
        if (typeof app.graphToPrompt !== "function") { showToast(app, "warning", "无画布序列化", "当前视图没有画布，保存不可用"); return; }
        try {
            const { output, error } = (await app.graphToPrompt(wfGraph)) || {};
            if (error || !output || !Object.keys(output).length) { showToast(app, "warning", "无法保存", "画布上没有有效工作流" + (error && error.message ? `（${error.message}）` : "")); return; }
            const r = await updateWorkflowSkill(currentSkillId, output);
            showToast(app, "success", `已保存工作流 "${r.id}"`, (r.warnings || []).join("\n"));
            document.dispatchEvent(new CustomEvent("rs.skills.updated"));
            skillWorkflowRaw = output;   // 只读流程图按新模板重画
            setWfMode("view");
            const genInfo = currentIsVideo ? await loadVideoGenSettings() : await loadGenSettings();   // 回写后的 config 灌回设置区
            loadedGenInfo = genInfo || null;
            genSettingsBaseline = collectGenSettingsJson();   // 设置区已按新 config 重载 → 脏检查基线同步
            await renderWorkflowPreview(output, genInfo, currentIsVideo, currentSkillId);
        } catch (err) {
            showToast(app, "error", "保存工作流失败", err.message);
        }
    }

    wfViewBtn.addEventListener("click", (e) => { e.stopPropagation(); setWfMode("view"); });
    wfEditBtn.addEventListener("click", (e) => { e.stopPropagation(); setWfMode("edit"); });
    wfSaveBtn.addEventListener("click", (e) => { e.stopPropagation(); saveWorkflowFromEditor(); });
    wfReloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        destroyWfEditor();
        if (mountWfEditor()) requestAnimationFrame(refitWfCanvas);
    });
    wfFitBtn.addEventListener("click", (e) => { e.stopPropagation(); refitWfCanvas(); });

    // 有工作流的技能：正文默认收起（点标题展开）；正文区高度减半给流程图让位；正文为空时进一步压缩（输入内容后自动恢复）
    function updateContentCompact() {
        const active = workflowShown && workflowExpanded;
        contentRow.classList.toggle("rs-content-row-workflow", active);
        contentRow.classList.toggle("rs-content-row-compact", active && !contentTextarea.value.trim());
        const collapsible = workflowShown;      // 由 workflow.json 驱动的技能才可折叠
        const collapsed = collapsible && contentCollapsed;
        contentRow.classList.toggle("rs-content-row-collapsible", collapsible);
        contentRow.classList.toggle("rs-content-row-collapsed", collapsed);
        contentCaret.textContent = collapsed ? "▸" : "▾";
        contentHint.style.display = collapsible ? "" : "none";
        // 正文收起 → 主区改单列（设置区独占整行），不再为右栏留空
        mainRow.classList.toggle("rs-main-content-collapsed", collapsed);
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
        showDetail();
        titleSpan.textContent = "📝 技能";
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
        titleSpan.textContent = "📝 " + nm;
        titleSpan.title = nm;
        multiTurnChk.checked = !!(full && full.multi_turn);
        currentIsVideo = !!(full && full.gen_video);
        configOverridden = !!(full && full.config_overridden);
        // 不可用视频技能（VDN 加速节点未装）：内容区顶部显示说明
        unavailableBanner.style.display = (full && full.gen_video && full.available === false) ? "block" : "none";
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
        syncSettingsColumn();
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
        setWfMode("view");   // 切技能回到只读流程图（顺带卸载上一个技能的内嵌画布）
        contentCollapsed = true;   // 每次打开技能：带工作流的正文默认收起
        resetWorkflowCollapse();   // 每次打开技能：工作流区默认展开
        if (wfPromise) {
            const skel = mkEl("div", "rs-wf-skeleton");
            skel.textContent = "加载工作流图中…";
            workflowBody.appendChild(skel);
            workflowWrap.style.display = "flex";   // 卡片是 flex 列（见 .rs-skill-workflow）：写 block 会让内嵌画布的 flex:1 失效
            workflowShown = true;
            updateContentCompact();   // 先占位：正文区立即让位，避免加载完成后整体下移
            const wf = await wfPromise;
            if (currentSkillId === id && wf) skillWorkflowRaw = wf;   // 存原始模板：内嵌编辑与「修复失效路径」后重渲染复用
            if (wf) await renderWorkflowPreview(wf, genInfo, full.gen_video, id);
            else {
                workflowWrap.style.display = "none";
                workflowShown = false;
                workflowBody.innerHTML = "";
            }
        }
        updateContentCompact();
        setEditorMode(editorMode);
        updateControls();
    }

    // ---- 打开：新建空表单 ----
    function openNew() {
        showDetail();
        titleSpan.textContent = "✨ 新建技能";
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
        genSettingsWrap.style.display = "none";
        videoGenSettingsWrap.style.display = "none";
        syncSettingsColumn();
        unavailableBanner.style.display = "none";
        workflowWrap.style.display = "none";
        workflowShown = false;
        skillWorkflowRaw = null;
        currentIsVideo = false;
        setWfMode("view");
        contentCollapsed = true;
        resetWorkflowCollapse();
        updateContentCompact();   // 清掉上一个技能残留的工作流 / 正文折叠类
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

    function close() { dirtyConfirm.hidden = true; destroyWfEditor(); if (embedded) modal.style.display = "none"; else overlay.style.display = "none"; }

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
            if (result.success) { contentBaseline = { name: nameInput.value, content: contentTextarea.value, multiTurn: multiTurnChk.checked }; await persistGenSettings(); document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
            else alert("Save failed: " + (result.error || "Unknown error"));
        } else {
            const r = await saveSkillFile(currentSkillId, selectedFile, contentTextarea.value);
            if (r.success) { contentBaseline = { name: nameInput.value, content: contentTextarea.value, multiTurn: multiTurnChk.checked }; await persistGenSettings(); document.dispatchEvent(new CustomEvent("rs.skills.updated")); close(); }
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

    // ---- 复制为自定义（仅内置）----
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || isCustom()) return;
        const copy = await copySkillAsCustom(currentSkillId, nameInput.value.trim());
        if (copy) await openExisting(copy.id, "custom"); // 立即切换到复制后的 skill 详情
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
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); requestClose(); });
    if (!embedded) {
        // 独立弹窗：点遮罩 / Esc 关闭；内嵌模式由宿主窗口（统一技能管理）负责关闭与 Esc
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) requestClose(); });
        const onKey = (e) => { if (e.key === "Escape" && overlay.style.display !== "none") requestClose(); };
        document.addEventListener("keydown", onKey);
    }

    return { overlay, openExisting, openNew, close, isDirty: hasUnsavedChanges };
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
        if (allowed) {
            // combo 选项值 = cn_name || name（见 image_gen_edit._gen_image_skills）；不可用视频技能带「（不可用）」后缀（h3_video_gen._skill_label）；按此优先级匹配，保证写回合法
            const candidates = [s.cn_name, s.name, s.id].filter(Boolean);
            if (s.available === false) candidates.unshift(`${s.cn_name || s.name || s.id}（不可用）`);
            value = candidates.find((c) => allowed.includes(c)) || null;
        } else {
            value = s.name || s.id;
        }
        if (!value) continue;
        items.push({
            value,
            skillId: s.id, // 行内 Edit/查看需按 id 打开详情（value 可能是 name，仅用于写回 combo）
            label: String(value).endsWith("（不可用）") ? value : (s.cn_name || s.name || s.id),
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
            label: meta.cn_name || meta.name || String(opt.textContent || val).trim(),
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
// 统一技能管理 UI：左侧技能列表（搜索 + 分类分组）+ 右侧技能详情（内嵌 createSkillDetailPopup）
// createSkillManager(host, opts) 直接挂进给定容器，返回 { el, closeBtn, close }；
// openSkillManager() 包一层模态遮罩作顶栏 🅝 菜单「🗂 技能管理」入口（跨节点单例，重复打开不叠加）；
// Neo Studio「技能」页签直接挂主区（无弹窗外壳）。
// 技能增删改/上传均广播 rs.skills.updated，左侧列表随之自动刷新。
// ==========================================
let _skillManagerOpen = false;

// 左栏宽度拖拽：下限保证列表可读，右栏下限保证详情不被挤没；宽度记忆到 localStorage，双击分隔条清除
const SKILL_LEFT_W_KEY = "neo.skillManagerLeftWidth";
const SKILL_LEFT_MIN_W = 180;
const SKILL_RIGHT_MIN_W = 320;

function createSkillManager(host, { showClose = true, showCanvasBtn = true } = {}) {
    const box = mkEl("div", "rs-skill-manager");

    // 顶部标题栏：🗂 技能管理 + ✕（关闭整窗；内嵌模式无 ✕）
    const head = mkEl("div", "rs-skill-manager-head");
    const title = mkEl("span", "rs-skill-manager-title");
    title.textContent = "🗂 技能管理";
    head.appendChild(title);
    let closeBtn = null;
    if (showClose) {
        closeBtn = mkEl("button", "rs-skill-modal-close");
        closeBtn.type = "button";
        closeBtn.title = "关闭（Esc）";
        closeBtn.textContent = "✕";
        head.appendChild(closeBtn);
    }

    // 主体：左列表 | 分隔条 | 右详情
    const body = mkEl("div", "rs-skill-manager-body");
    const left = mkEl("div", "rs-skill-manager-left");
    const split = mkEl("div", "rs-skill-manager-split");
    const right = mkEl("div", "rs-skill-manager-right");
    body.append(left, split, right);
    box.append(head, body);

    // 左：搜索框 + 列表 + 管理工具栏（新建 / ZIP / 目录 / 从画布）
    const search = document.createElement("input");
    search.type = "text";
    search.className = "rs-skill-picker-search";
    search.placeholder = "🔍 搜索技能…";
    search.addEventListener("input", () => renderList());
    const list = mkEl("div", "rs-skill-picker-list");
    const mgmt = mkEl("div", "rs-skill-dropdown-footer");
    left.append(search, list, mgmt);

    // 右：占位提示 + 内嵌详情弹窗（modal 挂到 right）
    const placeholder = mkEl("div", "rs-skill-manager-empty");
    placeholder.textContent = "从左侧选择技能查看详情";
    right.appendChild(placeholder);
    const popup = createSkillDetailPopup(right, showCanvasBtn);

    host.appendChild(box);

    // 左栏宽度拖拽：分隔条跟随光标，钳制在 [左栏下限, 主体宽 - 右栏下限]；松手记忆到 localStorage（开窗沿用，
    // 上限由 CSS .rs-skill-manager-left max-width 兜底），双击分隔条清除记忆回到默认宽度。
    const setLeftWidth = (w) => {
        const max = Math.max(SKILL_LEFT_MIN_W, body.getBoundingClientRect().width - SKILL_RIGHT_MIN_W);
        left.style.width = `${Math.round(Math.max(SKILL_LEFT_MIN_W, Math.min(w, max)))}px`;
    };
    split.title = "拖动调整列表宽度（双击恢复默认）";
    let savedLeftW = NaN;
    try { savedLeftW = parseInt(localStorage.getItem(SKILL_LEFT_W_KEY), 10); } catch { /* 隐私模式下 localStorage 不可用 */ }
    if (Number.isFinite(savedLeftW)) left.style.width = `${Math.max(SKILL_LEFT_MIN_W, savedLeftW)}px`;
    // 捕获指针 + 闸门：手势取消或在页面外松手时页面收不到 mouseup/pointerup，
    // 不捕获就会留下 move 监听器，左栏宽度会一直跟着鼠标跑
    let splitDrag = false;
    split.addEventListener("pointerdown", (e) => {
        if (splitDrag || e.button !== 0) return;
        const startX = e.clientX;
        const startW = left.getBoundingClientRect().width;
        splitDrag = true;
        split.classList.add("is-dragging");
        document.body.classList.add("rs-skill-resizing");
        split.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => { if (splitDrag) setLeftWidth(startW + ev.clientX - startX); };
        const onUp = () => {
            splitDrag = false;
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            split.classList.remove("is-dragging");
            document.body.classList.remove("rs-skill-resizing");
            try { localStorage.setItem(SKILL_LEFT_W_KEY, left.style.width); } catch { /* 同上 */ }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    });
    split.addEventListener("dblclick", () => {
        try { localStorage.removeItem(SKILL_LEFT_W_KEY); } catch { /* 同上 */ }
        left.style.width = "";
    });

    let allItems = [];
    let selectedId = null;
    // 手风琴：同时只展开一个分类；undefined = 首屏尚未定位（首次加载后默认展开「生图」）
    let openGroup;
    const syncEmpty = () => {
        const m = right.querySelector(".rs-skill-modal");
        placeholder.hidden = !!(m && m.style.display !== "none");
    };

    // 行内操作按钮（⧉ 复制 / 🗑 删除）：默认透明，hover 行时淡入（见 prompts.css .rs-skill-row-btn）
    const mkRowBtn = (glyph, tip, extraCls = "") => {
        const b = mkEl("button", "rs-skill-row-btn" + (extraCls ? ` ${extraCls}` : ""));
        b.type = "button";
        b.textContent = glyph;
        b.title = tip;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };

    // 渲染分组列表（搜索过滤）；分类头可点击折叠/展开（手风琴：仅一个组展开，搜索时全展开）；展开组加粗高亮 is-open；选中项高亮 is-selected
    function renderList() {
        list.textContent = "";
        const q = search.value.trim().toLowerCase();
        const items = allItems.filter((it) => !q || `${it.label} ${it.badge || ""}`.toLowerCase().includes(q));
        if (!items.length) {
            const empty = mkEl("div", "rs-skill-picker-empty");
            empty.textContent = q ? "无匹配技能" : "暂无技能";
            list.appendChild(empty);
            return;
        }
        // 搜索时强制展开，保证匹配项可见
        const searching = !!q;
        // 按分组聚合（items 已按 group 排序，Map 保持原顺序；无分组项归入 ""）
        const groups = new Map();
        for (const it of items) {
            const g = it.group || "";
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(it);
        }
        for (const [g, groupItems] of groups) {
            if (g) {
                const collapsed = !searching && g !== openGroup;
                const gh = mkEl("div", "rs-combo-category rs-skill-manager-cat" + (collapsed ? "" : " is-open"));
                gh.dataset.group = g;
                const caret = mkEl("span", "rs-skill-manager-cat-caret");
                caret.textContent = collapsed ? "▸" : "▾";
                const lbl = mkEl("span", "rs-skill-manager-cat-label");
                lbl.textContent = g;
                gh.append(caret, lbl);
                gh.title = collapsed ? `展开「${g}」` : `折叠「${g}」`;
                gh.addEventListener("click", () => toggleGroup(g));
                list.appendChild(gh);
                if (collapsed) continue;
            }
            for (const it of groupItems) {
                const row = mkEl("div", "rs-skill-picker-item" + (it.value === selectedId ? " is-selected" : ""));
                if (it.badge) { const b = mkEl("span", "rs-skill-picker-badge"); b.textContent = it.badge; row.appendChild(b); }
                const lbl = mkEl("span", "rs-skill-picker-label");
                lbl.textContent = it.label;
                row.appendChild(lbl);
                const actions = mkEl("div", "rs-skill-picker-actions");
                const copyBtn = mkRowBtn("⧉", it.source === "custom" ? "复制为副本" : "复制为自定义技能");
                copyBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const copy = await copySkillAsCustom(it.skillId || it.value, it.label);
                    if (copy) await selectSkill({ value: copy.name, skillId: copy.id, source: "custom" });
                });
                actions.appendChild(copyBtn);
                if (it.source === "custom") {
                    const delBtn = mkRowBtn("🗑", "删除该自定义技能", "rs-skill-row-del");
                    delBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        const id = it.skillId || it.value;
                        if (!confirm(`删除技能 "${it.label}"？`)) return;
                        const r = await deleteSkill(id);
                        if (!r.success) { showToast(app, "error", "删除失败", r.error || "Unknown error"); return; }
                        if (it.value === selectedId) { popup.close(); selectedId = null; }   // 删的正是右侧正在显示的详情
                        document.dispatchEvent(new CustomEvent("rs.skills.updated"));
                    });
                    actions.appendChild(delBtn);
                }
                row.appendChild(actions);
                row.addEventListener("click", () => selectSkill(it));
                list.appendChild(row);
            }
        }
    }

    // 分类头点击：手风琴——展开某组会收起其它组，再点当前组收起全部
    function toggleGroup(group) {
        openGroup = openGroup === group ? null : group;
        renderList();
    }

    async function loadList() {
        const skills = (await listSkills()).filter(s => !CATEGORY_LABELS[s.category]?.managerHidden);
        allItems = skillItemsFromMeta(skills);
        // 首屏默认展开「生图」（没有生图技能时展开第一个分类），避免一屏铺满全部分类
        if (openGroup === undefined) {
            const labels = allItems.map((it) => it.group).filter(Boolean);
            const gen = CATEGORY_LABELS.image_gen.label;
            openGroup = labels.includes(gen) ? gen : (labels[0] ?? null);
        }
        if (selectedId && !allItems.some((it) => it.value === selectedId)) selectedId = null;   // 删除后清选择
        renderList();
        syncEmpty();
    }

    // 选中技能：有未保存修改先确认，再加载详情到右侧
    async function selectSkill(it) {
        if (it.value === selectedId) return;
        if (popup.isDirty() && !confirm("当前技能有未保存的修改，放弃并切换？")) return;
        selectedId = it.value;
        renderList();
        await popup.openExisting(it.skillId || it.value, it.source);
        syncEmpty();
    }

    // 管理工具栏按钮：新建进右侧内嵌详情；上传/导出广播 rs.skills.updated 自动刷新列表
    const makeMgmtBtn = (label, tip) => {
        const b = mkEl("button", "rs-btn rs-btn-local rs-skill-footer-btn");
        b.type = "button";
        b.textContent = label;
        b.title = tip;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };
    const newBtn = makeMgmtBtn("+ 新建", "新建自定义技能");
    newBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (popup.isDirty() && !confirm("当前技能有未保存的修改，放弃并新建？")) return;
        selectedId = null;
        renderList();
        await popup.openNew();
        syncEmpty();
    });
    const zipBtn = makeMgmtBtn("⬆ ZIP", "上传 .zip 技能包");
    zipBtn.addEventListener("click", (e) => { e.stopPropagation(); getSkillUploadInputs().zipInput.click(); });
    const dirBtn = makeMgmtBtn("⬆ 目录", "上传技能目录（全部 .md）");
    dirBtn.addEventListener("click", (e) => { e.stopPropagation(); getSkillUploadInputs().dirInput.click(); });
    mgmt.append(newBtn, zipBtn, dirBtn);
    if (showCanvasBtn) {
        const canvasBtn = makeMgmtBtn("📋 从画布", "把当前画布工作流导出为技能");
        canvasBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                const { output, error } = (await app.graphToPrompt()) || {};
                if (error || !output || !Object.keys(output).length) {
                    showToast(app, "warning", "无法导出", "画布上没有有效工作流" + (error?.message ? `（${error.message}）` : ""));
                    return;
                }
                const name = await promptSkillTitle("my-workflow");
                if (!name) return;
                const r = await saveWorkflowSkill({ name, description: "", tags: [], workflow: output });
                showToast(app, "success", `已保存${r.gen_video ? "生视频" : "生图"}技能 "${r.id}"`, (r.warnings || []).join("\n"));
                document.dispatchEvent(new CustomEvent("rs.skills.updated"));
            } catch (err) {
                showToast(app, "error", "保存失败", err.message);
            }
        });
        mgmt.appendChild(canvasBtn);
    }

    // 技能增删改（rs.skills.updated）自动刷新列表；close() 清监听并移除根节点
    const onSkillsUpdated = () => loadList();
    document.addEventListener("rs.skills.updated", onSkillsUpdated);
    const close = () => {
        document.removeEventListener("rs.skills.updated", onSkillsUpdated);
        box.remove();
    };

    // 初始加载 + 默认选中「默认展开分类」的第一项（与左侧展开的分类一致，而非按分组排序的列表首项）
    loadList().then(() => {
        if (selectedId || !allItems.length) return;
        selectSkill(allItems.find((it) => it.group === openGroup) || allItems[0]);
    });

    return { el: box, head, closeBtn, close };
}

function openSkillManager() {
    if (_skillManagerOpen) return;
    _skillManagerOpen = true;
    // 独立窗口（同导演编辑器）：无遮罩 —— 背景透明且指针穿透，画布保持可操作；
    // 标题栏拖动 / 双击放大还原 / ⛶ 放大还原 / 右下角拉伸；关闭只走 ✕ 与 Esc
    const overlay = mkEl("div", "rs-skill-modal-overlay rs-skill-manager-overlay");
    overlay.style.display = "flex";   // .rs-skill-modal-overlay 默认 display:none，内嵌整窗需显式显示
    document.body.appendChild(overlay);

    const mgr = createSkillManager(overlay);
    const box = mgr.el;
    overlay.appendChild(box);

    // ⛶ 放大/还原：铺满视口（留 8px 边距），还原回到放大前的几何
    let maximized = false, prevRect = null;
    const maxBtn = mkEl("button", "rs-skill-manager-maximize");
    maxBtn.type = "button";
    maxBtn.title = "放大到最大";
    maxBtn.textContent = "⛶";
    const toggleMaximize = () => {
        if (maximized) {
            Object.assign(box.style, prevRect || { left: "", top: "", width: "", height: "" });
            maximized = false;
            maxBtn.textContent = "⛶";
            maxBtn.title = "放大到最大";
        } else {
            prevRect = { left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height };
            Object.assign(box.style, { position: "absolute", left: "8px", top: "8px", width: "calc(100vw - 16px)", height: "calc(100vh - 16px)" });
            maximized = true;
            maxBtn.textContent = "🗗";
            maxBtn.title = "还原窗口";
        }
    };
    maxBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMaximize(); });
    mgr.head.insertBefore(maxBtn, mgr.closeBtn);

    // 标题栏拖动：位移后夹回视口，保证标题栏始终够得到（放大态铺满，拖动无意义）
    // 拖拽期间捕获指针并在 onMove 上设闸门：手势被取消（pointercancel）或在页面外松手时
    // 页面收不到 pointerup，不捕获就会留下 pointermove 监听器，松手后窗口继续跟着鼠标跑
    let headDrag = false;
    mgr.head.addEventListener("pointerdown", (e) => {
        if (maximized || headDrag || e.button !== 0 || e.target.closest("button, input")) return;
        const startL = parseFloat(box.style.left) || box.offsetLeft;
        const startT = parseFloat(box.style.top) || box.offsetTop;
        const startX = e.clientX, startY = e.clientY;
        box.style.position = "absolute";
        box.style.left = startL + "px";
        box.style.top = startT + "px";
        headDrag = true;
        mgr.head.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
            if (!headDrag) return;
            const w = box.offsetWidth, h = box.offsetHeight;
            box.style.left = Math.max(-w + 80, Math.min(startL + ev.clientX - startX, window.innerWidth - 80)) + "px";
            box.style.top = Math.max(0, Math.min(startT + ev.clientY - startY, window.innerHeight - 44)) + "px";
        };
        const onUp = () => {
            headDrag = false;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });
    mgr.head.addEventListener("dblclick", (e) => {
        if (e.target.closest("button, input")) return;
        toggleMaximize();
    });

    // 右下角拖拽改尺寸
    const grip = mkEl("div", "rs-skill-manager-resize");
    grip.title = "拖拽调整窗口大小";
    box.appendChild(grip);
    // 右下角拖拽改尺寸（同标题栏拖动：捕获指针 + 闸门，松手/取消手势后不再跟随鼠标）
    let resizing = false;
    grip.addEventListener("pointerdown", (e) => {
        if (resizing || e.button !== 0) return;
        e.preventDefault();
        const sw = box.offsetWidth, sh = box.offsetHeight;
        const startX = e.clientX, startY = e.clientY;
        resizing = true;
        grip.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
            if (!resizing) return;
            box.style.width = Math.max(640, sw + ev.clientX - startX) + "px";
            box.style.height = Math.max(420, sh + ev.clientY - startY) + "px";
        };
        const onUp = () => {
            resizing = false;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });

    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const close = () => {
        _skillManagerOpen = false;
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        mgr.close();
    };
    mgr.closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    document.addEventListener("keydown", onKey, true);
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
    resolveSkillId,
    openSkillDetailById,
    createSkillStatusRow,
    SKILL_CHANGED_EVENT,
    CATEGORY_LABELS,
    renderMarkdown,
    createSkillDetailPopup,
    createSkillDropdown,
    openSkillPickerModal,
    createSkillManager,
    openSkillManager,
    openSkillWorkflowInMainUi,
    openSkillWorkflowOnCanvas,
    runSkillWorkflowHandoff,
    attachSkillPickerToComboWidget,
    attachSkillPickerToSelect
};