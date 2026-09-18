/**
 * workflow-graph.js
 * 技能工作流模板（API prompt 格式）的只读 SVG 流程图渲染：
 * - layoutWorkflow：拓扑分层 → 从左到右自动布局（节点高度随参数行数自适应；纯函数，无 DOM 依赖）
 * - applyWorkflowParams：按已知参数（设置 + 自动建议模型）预替换模板变量，运行时变量保留
 * - injectRuntimeLoras：配置 LoRA 超出模板槽位时镜像后端 _apply_loras 动态插入 LoraLoaderModelOnly，
 *   使流程图与运行时实际提交的图一致；未配置或槽位够用时原样返回
 * - validateWorkflow / checkWorkflow：对照 /object_info 与 /models/{folder}
 *   标记 节点未安装 / 模型未找到 / {{模板变量}}（请求失败时跳过对应检查，不误报）
 * - renderWorkflowGraph：画 SVG（节点框 + 参数行 + 贝塞尔连线 + 徽标 + tooltip）+ 问题摘要到容器
 */

const NODE_W = 150, NODE_H = 46, GAP_X = 64, GAP_Y = 18, PAD = 12;
// 第一列（加载器）更宽，便于显示更长的模型名
const NODE_W_SOURCE = 196;
function nodeW(layerIdx) { return layerIdx === 0 ? NODE_W_SOURCE : NODE_W; }
// 参数行宽度上限按框宽推导（10px 字号约 5.5px/字符）
function lineMaxChars(w) { return Math.floor((w - 20) / 5.5); }
const TEMPLATE_RE = /\{\{.*?\}\}/;

// combo 输入类型 → /models/{folder} 目录；未知类型跳过（宁缺勿误报）
const MODEL_INPUT_TYPE_TO_FOLDER = {
    CHECKPOINT_NAME: "checkpoints",
    LORA_NAME: "loras",
    VAE_NAME: "vae",
    CLIP_NAME: "clip",
    CLIP_VISION_NAME: "clip_vision",
    UNET_NAME: "diffusion_models",
    DIFFUSION_MODEL_NAME: "diffusion_models",
    DUALCONV_NAME: "dual_convolution",
    STYLE_MODEL_NAME: "style_model",
    UPSCALE_MODEL_NAME: "upscale_models",
    EMBEDDING_NAME: "embeddings",
    LOADER: "controlnet",
};

function _sortNodeIds(a, b) {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
}

/** API prompt → { nodes, edges, width, height }。inputs 里 ["srcId", slot] 视为连线；环安全（回边忽略）。 */
export function layoutWorkflow(workflow) {
    const wf = collapseRefLoaders(workflow || {});
    const ids = Object.keys(wf);
    const idSet = new Set(ids);
    const preds = {};
    for (const id of ids) preds[id] = [];
    for (const id of ids) {
        const inputs = (wf[id] && wf[id].inputs) || {};
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && v[0] !== id && idSet.has(v[0])) {
                preds[id].push(v[0]);
            }
        }
    }

    // 最长路径分层；visiting 标记断环
    const layer = {};
    const state = {}; // 1=进行中 2=完成
    function assign(id) {
        if (state[id] === 2) return layer[id];
        if (state[id] === 1) return 0; // 环回边，忽略
        state[id] = 1;
        let l = 0;
        for (const p of preds[id]) l = Math.max(l, assign(p) + 1);
        state[id] = 2;
        layer[id] = l;
        return l;
    }
    ids.forEach(assign);

    const byLayer = {};
    for (const id of ids) (byLayer[layer[id]] ||= []).push(id);
    const layers = Object.keys(byLayer).map(Number).sort((a, b) => a - b);
    const lines = {};
    for (const id of ids) lines[id] = nodeInputLines(wf, id, lineMaxChars(nodeW(layer[id])));
    const pos = {};
    let maxRowH = 0, x = PAD;
    for (const L of layers) {
        const w = nodeW(L);
        const group = byLayer[L].slice().sort(_sortNodeIds);
        let y = PAD, rowH = 0;
        for (const id of group) {
            pos[id] = { x, y };
            const h = nodeH(lines[id].length);
            y += h + GAP_Y;
            rowH += h;
        }
        maxRowH = Math.max(maxRowH, rowH + Math.max(0, group.length - 1) * GAP_Y);
        x += w + GAP_X;
    }
    const width = layers.length ? x - GAP_X + PAD : PAD * 2;
    const height = PAD * 2 + maxRowH;

    const nodes = ids.map(id => ({
        id,
        classType: (wf[id] && wf[id].class_type) || "?",
        x: pos[id].x, y: pos[id].y, w: nodeW(layer[id]), h: nodeH(lines[id].length), layer: layer[id],
        lines: lines[id],
    }));
    const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const edges = [];
    for (const id of ids) {
        const inputs = (wf[id] && wf[id].inputs) || {};
        for (const [k, v] of Object.entries(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && nodeById[v[0]] && v[0] !== id) {
                const t = nodeById[id];
                // 连线精确指向目标节点上对应参数行的文字中心（text y 是基线，字高 10px → 中心在基线上方约 3.5px）；该行被折叠时退回节点垂直中心
                const idx = t.lines.indexOf(k);
                edges.push({ from: v[0], to: id, targetY: idx >= 0 ? t.y + INPUT_FIRST_Y + idx * INPUT_LINE_H - 3.5 : t.y + t.h / 2 });
            }
        }
    }
    return { nodes, edges, width, height };
}

// 合并同类参考加载器：autogrow 槽位（ref_images.ref_image_0..8）的专属源节点（LoadImage/LoadVideo/LoadAudio 等）
// 按 (目标节点, 槽位族) 分组，2+ 个成员时替换为单个合成节点 "ClassName ×N"，大幅减少图的高度
const AUTOGROW_SLOT_RE = /\.\w+_\d+$/;
function collapseRefLoaders(workflow) {
    const ids = Object.keys(workflow);
    // 收集 autogrow 槽位的连线：targetId → slotFamily → [sourceIds]
    const slotGroups = {};
    for (const id of ids) {
        const inputs = workflow[id].inputs || {};
        for (const [k, v] of Object.entries(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && AUTOGROW_SLOT_RE.test(k)) {
                const family = k.replace(/_\d+$/, "");
                const key = `${id}|${family}`;
                (slotGroups[key] ||= []).push(v[0]);
            }
        }
    }
    // 对每个 2+ 源的组，扩展收集专属上游节点（如 LoadVideo → GetVideoComponents → H3），生成合成节点
    const removeSet = new Set();
    const synthMap = {}; // removedId → syntheticId
    const synthNodes = {};

    // 反向邻接：sourceId → Set<targetId>（谁连出到谁）
    const outTo = {};
    for (const id of ids) {
        const inputs = workflow[id].inputs || {};
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string") {
                (outTo[v[0]] ||= new Set()).add(id);
            }
        }
    }

    for (const [key, sourceIds] of Object.entries(slotGroups)) {
        // 只保留实际存在于 workflow 中的源节点（外部引用/未定义节点不参与合并）
        const uniqueSources = [...new Set(sourceIds)].filter(s => workflow[s]);
        if (uniqueSources.length < 2) continue;
        const targetId = key.split("|")[0];

        // 扩展：把输出只连向本组成员的上游节点也纳入（如 LoadVideo → GetVideoComponents）
        const members = new Set(uniqueSources);
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of ids) {
                if (members.has(id)) continue;
                const targets = outTo[id];
                if (targets && targets.size > 0 && [...targets].every(t => members.has(t))) {
                    members.add(id);
                    changed = true;
                }
            }
        }

        const synthId = `__grp_${targetId}_${key.split("|")[1]}`;
        for (const m of members) { removeSet.add(m); synthMap[m] = synthId; }

        // 合成节点：优先取叶子源节点（无数组连线输入的）的 class_type，如 LoadVideo 而非 GetVideoComponents
        const leafSrc = uniqueSources.find(s => {
            const ins = workflow[s].inputs || {};
            return !Object.values(ins).some(v => Array.isArray(v) && typeof v[0] === "string");
        }) || [...members].find(m => {
            const ins = workflow[m].inputs || {};
            return !Object.values(ins).some(v => Array.isArray(v) && typeof v[0] === "string");
        }) || uniqueSources[0];
        synthNodes[synthId] = { class_type: `${workflow[leafSrc].class_type} ×${uniqueSources.length}`, inputs: {} };
    }

    if (removeSet.size === 0) return workflow;

    // 构建新 workflow：移除被合并节点，添加合成节点，重定向边
    const result = {};
    for (const id of ids) {
        if (removeSet.has(id)) continue;
        const node = workflow[id];
        result[id] = { ...node, inputs: { ...node.inputs } };
    }
    Object.assign(result, synthNodes);

    // 重定向：指向被移除节点的连线改为指向对应合成节点（去重）
    for (const id of Object.keys(result)) {
        const inputs = result[id].inputs || {};
        for (const k of Object.keys(inputs)) {
            const v = inputs[k];
            if (Array.isArray(v) && typeof v[0] === "string" && removeSet.has(v[0])) {
                inputs[k] = [synthMap[v[0]], v[1]];
            }
        }
    }
    return result;
}


/**
 * 按已知参数预渲染模板：替换 {{MODEL}} / {{LORA_1_NAME}} / {{STEPS}} 等可由设置确定的占位符，
 * 运行时变量（{{PROMPT}} / {{SEED}} / {{REF_*}} 等）保持原样。返回新对象，不改原模板。
 */
export function applyWorkflowParams(workflow, values) {
    const map = {};
    for (const [k, v] of Object.entries(values || {})) {
        if (v !== undefined && v !== null && String(v) !== "") map["{{" + k + "}}"] = String(v);
    }
    if (!Object.keys(map).length) return workflow;
    const out = {};
    for (const [id, node] of Object.entries(workflow || {})) {
        if (!node || typeof node !== "object") { out[id] = node; continue; }
        const inputs = {};
        for (const [k, v] of Object.entries(node.inputs || {})) {
            if (typeof v === "string") {
                let s = v;
                for (const [tok, rep] of Object.entries(map)) if (s.includes(tok)) s = s.split(tok).join(rep);
                inputs[k] = s;
            } else {
                inputs[k] = v;
            }
        }
        out[id] = { ...node, inputs };
    }
    return out;
}


// LoRA 运行时动态注入（镜像 image_gen.py _apply_loras）：配置 LoRA 超出模板 {{LORA_i_*}} 槽位时，
// 在主链末端串联插入 LoraLoaderModelOnly（id = max_id+1...），使流程图与运行时实际提交的图一致。
// 未配置或槽位够用时原样返回；返回新对象不改原模板。注入节点带 runtime_injected 标记（tooltip 标注）。
const LORA_SLOT_RE = /^\{\{LORA_(\d+)_NAME\}\}$/;

function _loraModelConsumer(wf, srcId) {
    let best = null;
    for (const [id, node] of Object.entries(wf)) {
        if (!node || node.class_type !== "LoraLoaderModelOnly") continue;
        const v = (node.inputs || {}).model;
        if (Array.isArray(v) && typeof v[0] === "string" && v[0] === String(srcId)) {
            if (best === null || _sortNodeIds(id, best) < 0) best = id;
        }
    }
    return best;
}

function _anyModelConsumer(wf, srcId) {
    let best = null;
    for (const [id, node] of Object.entries(wf)) {
        if (id === srcId || !node) continue;
        const v = (node.inputs || {}).model;
        if (Array.isArray(v) && typeof v[0] === "string" && v[0] === String(srcId)) {
            if (best === null || _sortNodeIds(id, best) < 0) best = id;
        }
    }
    return best;
}

export function injectRuntimeLoras(workflow, loras) {
    const entries = (loras || [])
        .map(l => (typeof l === "string" ? { name: l, strength: 1.0 } : l))
        .filter(l => l && l.name);
    if (!entries.length) return workflow;
    const slots = {};
    for (const [id, node] of Object.entries(workflow || {})) {
        if (!node || node.class_type !== "LoraLoaderModelOnly") continue;
        const m = LORA_SLOT_RE.exec(String((node.inputs || {}).lora_name || ""));
        if (m) slots[Number(m[1])] = id;
    }
    const ordered = Object.keys(slots).map(Number).sort((a, b) => a - b).map(i => slots[i]);
    if (entries.length <= ordered.length) return workflow;

    // 锚点：最后一个槽位节点；无槽位时取第一个 UNETLoader，模板手写过 LoRA 链则推到链尾（与后端一致）
    let anchor = ordered[ordered.length - 1];
    if (!anchor) {
        const unets = Object.entries(workflow).filter(([, n]) => n && n.class_type === "UNETLoader").map(([id]) => id);
        if (!unets.length) return workflow;
        anchor = unets.sort(_sortNodeIds)[0];
        for (;;) {
            const nxt = _loraModelConsumer(workflow, anchor);
            if (!nxt) break;
            anchor = nxt;
        }
    }
    const consumer = _anyModelConsumer(workflow, anchor);
    if (!consumer) return workflow;

    let maxId = 0;
    for (const id of Object.keys(workflow)) {
        const n = Number(id);
        if (Number.isInteger(n) && n > maxId) maxId = n;
    }
    const out = {};
    for (const [id, node] of Object.entries(workflow)) out[id] = { ...node, inputs: { ...(node.inputs || {}) } };
    let prev = anchor;
    entries.slice(ordered.length).forEach((entry, i) => {
        const nid = String(maxId + i + 1);
        out[nid] = { class_type: "LoraLoaderModelOnly", runtime_injected: true,
                     inputs: { model: [prev, 0], lora_name: entry.name, strength_model: entry.strength ?? 1.0 } };
        prev = nid;
    });
    out[consumer].inputs.model = [prev, 0];
    return out;
}


/**
 * 校验 workflow：objectInfo（/object_info）与 modelLists（folder→文件名列表）任一为 null/缺项时跳过对应检查。
 * 返回 { issues: nodeId → [{kind, message}], counts: {missingNodes, missingModels, templates} }。
 */
export function validateWorkflow(workflow, objectInfo, modelLists) {
    const issues = {};
    const counts = { missingNodes: 0, missingModels: 0, templates: 0 };
    for (const [id, node] of Object.entries(workflow || {})) {
        const list = (issues[id] ||= []);
        const cls = node && node.class_type;
        if (objectInfo && cls && !objectInfo[cls]) {
            list.push({ kind: "missing_node", message: `节点未安装：${cls}` });
            counts.missingNodes++;
            continue; // 节点不存在则查不到输入类型，跳过后续检查
        }
        const inputs = (node && node.inputs) || {};
        const def = objectInfo && cls ? objectInfo[cls].input : null;
        for (const [name, value] of Object.entries(inputs)) {
            if (typeof value === "string" && TEMPLATE_RE.test(value)) {
                list.push({ kind: "template", message: `${name} 为模板变量：${value}` });
                counts.templates++;
                continue; // 待替换值不做存在性判断
            }
            if (!def || typeof value !== "string" || !value) continue;
            const entry = [...Object.entries(def.required || {}), ...Object.entries(def.optional || {})]
                .find(([n]) => n === name);
            if (!entry) continue;
            // 有效模型列表有两个来源：
            //  1) object_info 直接内联的解析后 combo 列表（本环境）：spec = [["a.safetensors", ...]]
            //  2) 标准类型名 spec = ["UNET_NAME"] → 用 checkWorkflow 拉取的 modelLists[folder]
            let files = null, label = "";
            if (Array.isArray(entry[1]) && Array.isArray(entry[1][0]) && entry[1][0].length > 0
                && entry[1][0].every((x) => typeof x === "string")) {
                files = entry[1][0];
                label = name;
            } else {
                const typeList = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
                const folder = MODEL_INPUT_TYPE_TO_FOLDER[typeList[0]];
                if (folder) { files = (modelLists || {})[folder]; label = folder; }
            }
            if (!files) continue; // 列表不可用 → 跳过，不误报
            // config 与模型列表的分隔符可能不一致（Windows 后端返回反斜杠）→ 两边归一化后精确比对
            const normList = files.map((f) => String(f).replace(/\\/g, "/"));
            const v = value.replace(/\\/g, "/");
            if (!normList.includes(v) && !normList.includes(v + ".safetensors") && !normList.includes(v + ".ckpt")) {
                list.push({ kind: "missing_model", message: `模型未找到：${value}（${label}）` });
                counts.missingModels++;
            }
        }
    }
    return { issues, counts };
}

/** 拉 /object_info + 本工作流用到的 /models/{folder} 后执行校验；请求失败按「跳过检查」处理。 */
export async function checkWorkflow(workflow) {
    let objectInfo = null;
    try {
        const res = await fetch("/object_info");
        if (res.ok) objectInfo = await res.json();
    } catch (e) { /* 跳过节点存在性检查 */ }

    const folders = new Set();
    for (const node of Object.values(workflow || {})) {
        const cls = node && node.class_type;
        const def = objectInfo && cls ? (objectInfo[cls] || {}).input : null;
        if (!def) continue;
        for (const group of [def.required || {}, def.optional || {}]) {
            for (const t of Object.values(group)) {
                const typeList = Array.isArray(t) ? t : [t];
                const folder = MODEL_INPUT_TYPE_TO_FOLDER[typeList[0]];
                if (folder) folders.add(folder);
            }
        }
    }
    const modelLists = {};
    await Promise.all([...folders].map(async (f) => {
        try {
            const res = await fetch(`/models/${f}`);
            if (res.ok) modelLists[f] = await res.json();
        } catch (e) { /* 跳过该目录检查 */ }
    }));
    return validateWorkflow(workflow, objectInfo, modelLists);
}


function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
}

// 参数在节点上的展示：最多 N 行 + 按框宽截断，超出部分由 tooltip 补全
const MAX_INPUT_LINES = 6, INPUT_LINE_H = 13, INPUT_FIRST_Y = 47;
// 连线调色板大小（与 prompts.css 里 .rs-wf-edge-cN 一一对应）
const EDGE_COLORS = 6;

function _fmtVal(v, max = 60) {
    if (Array.isArray(v) && typeof v[0] === "string") return `← #${v[0]}`;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// 节点上展示的参数行：`key: value`（截断到 maxChars）；连线输入只显示参数名（连线直接指向该行），超过 MAX_INPUT_LINES 行 → 「+N 项」
// autogrow 同类输入（如 ref_images.ref_image_0..8）合并为一行摘要 "base ×N"，减少可选槽位的视觉噪音
function nodeInputLines(workflow, id, maxChars) {
    const inputs = (workflow[id] && workflow[id].inputs) || {};
    // 按 base name 分组带数字后缀的输入（如 ref_images.ref_image_0 → base "ref_images.ref_image"）
    const groups = {};
    const regular = [];
    for (const [k, v] of Object.entries(inputs)) {
        const m = k.match(/^(.+)_\d+$/);
        if (m) (groups[m[1]] ||= []).push(k);
        else regular.push([k, v]);
    }
    // 仅对 2+ 个同 base 的输入做合并；单个保留原名
    const groupLines = [];
    for (const [base, names] of Object.entries(groups)) {
        if (names.length >= 2) groupLines.push(`${base} ×${names.length}`);
        else regular.push([names[0], inputs[names[0]]]);
    }
    const all = [
        ...regular.map(([k, v]) => {
            if (Array.isArray(v) && typeof v[0] === "string") return k;
            const l = `${k}: ${_fmtVal(v, 60)}`;
            return l.length > maxChars ? l.slice(0, maxChars - 1) + "…" : l;
        }),
        ...groupLines,
    ];
    if (all.length > MAX_INPUT_LINES) {
        return [...all.slice(0, MAX_INPUT_LINES), `… +${all.length - MAX_INPUT_LINES} 项`];
    }
    return all;
}

// 节点高度：头部（类型+#id）固定，参数行每行 INPUT_LINE_H
function nodeH(nLines) {
    return nLines === 0 ? NODE_H : INPUT_FIRST_Y + (nLines - 1) * INPUT_LINE_H + 6;
}

function nodeTooltip(id, workflow, issues) {
    const injected = workflow[id] && workflow[id].runtime_injected ? "（运行时动态注入）" : "";
    const lines = [`${(workflow[id] && workflow[id].class_type) || "?"} #${id}${injected}`];
    const inputs = (workflow[id] && workflow[id].inputs) || {};
    for (const [k, v] of Object.entries(inputs)) lines.push(`${k}: ${_fmtVal(v)}`);
    for (const i of issues || []) lines.push(i.message);
    return lines.join("\n");
}

// 拖拽平移（同画布体验）：滚动区内按住拖动 → 平移 scrollLeft/Top；内容未超出时自然无效。
// pointer 事件优先，环境无 PointerEvent（老浏览器）回落 mouse 事件
function attachDragPan(svg, scroller) {
    const hasPointer = typeof window.PointerEvent !== "undefined";
    const downT = hasPointer ? "pointerdown" : "mousedown";
    const moveT = hasPointer ? "pointermove" : "mousemove";
    const upT = hasPointer ? "pointerup" : "mouseup";
    let drag = null;
    svg.addEventListener(downT, (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop };
        try { if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId); } catch (err) { /* mouse 事件无 pointerId */ }
        e.preventDefault();
    });
    window.addEventListener(moveT, (e) => {
        if (!drag) return;
        scroller.scrollLeft = drag.sl - (e.clientX - drag.x);
        scroller.scrollTop = drag.st - (e.clientY - drag.y);
    }, { passive: false });
    const end = () => { drag = null; };
    window.addEventListener(upT, end);
    svg.addEventListener("pointercancel", end);
}

/** 把流程图画进 container（先清空旧内容）；summaryTarget 提供时摘要行画到滚动区外。返回 { svg, summary }。 */
export function renderWorkflowGraph(container, workflow, validation, summaryTarget) {
    container.innerHTML = "";
    const layout = layoutWorkflow(workflow);
    const issues = (validation && validation.issues) || {};

    const svg = svgEl("svg", {
        class: "rs-wf-svg", width: layout.width, height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`,
    });
    const byId = Object.fromEntries(layout.nodes.map(n => [n.id, n]));

    // 连线在下层：终点精确落在目标节点对应参数行上（小圆点标记落点）；不同连线用不同颜色便于区分
    for (let i = 0; i < layout.edges.length; i++) {
        const e = layout.edges[i];
        const a = byId[e.from], b = byId[e.to];
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = e.targetY ?? b.y + b.h / 2;
        const mx = (x1 + x2) / 2;
        const g = svgEl("g", { class: `rs-wf-edge-c${i % EDGE_COLORS}` });
        g.appendChild(svgEl("path", {
            class: "rs-wf-edge", d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        }));
        g.appendChild(svgEl("circle", { class: "rs-wf-edge-dot", cx: x2, cy: y2, r: 2.5 }));
        svg.appendChild(g);
    }

    for (const n of layout.nodes) {
        const list = issues[n.id] || [];
        const hasError = list.some(i => i.kind === "missing_node" || i.kind === "missing_model");
        const hasTpl = list.some(i => i.kind === "template");
        const cls = ["rs-wf-node"];
        if (hasError) cls.push("rs-wf-node-bad");
        else if (hasTpl) cls.push("rs-wf-node-tpl");
        const g = svgEl("g", { class: cls.join(" "), transform: `translate(${n.x} ${n.y})` });
        // tooltip：渲染后的输入值（连线/模板变量/问题行）
        const title = svgEl("title");
        title.textContent = nodeTooltip(n.id, workflow, list);
        g.appendChild(title);
        g.appendChild(svgEl("rect", { class: "rs-wf-node-box", width: n.w, height: n.h, rx: 8 }));
        const labelMax = n.w > NODE_W ? 28 : 21;
        const label = n.classType.length > labelMax ? n.classType.slice(0, labelMax - 1) + "…" : n.classType;
        const t1 = svgEl("text", { class: "rs-wf-node-type", x: 10, y: 19 });
        t1.textContent = label;
        const t2 = svgEl("text", { class: "rs-wf-node-id", x: 10, y: 35 });
        t2.textContent = `#${n.id}`;
        g.append(t1, t2);
        // 参数行直接画在节点上（截断/折叠），完整值由 tooltip 补全
        let ty = INPUT_FIRST_Y;
        for (const line of n.lines) {
            const ti = svgEl("text", { class: "rs-wf-node-input", x: 10, y: ty });
            ti.textContent = line;
            g.appendChild(ti);
            ty += INPUT_LINE_H;
        }
        if (hasError || hasTpl) {
            g.appendChild(svgEl("circle", {
                class: hasError ? "rs-wf-badge rs-wf-badge-error" : "rs-wf-badge rs-wf-badge-tpl",
                cx: n.w - 12, cy: 12, r: 7,
            }));
        }
        svg.appendChild(g);
    }
    container.appendChild(svg);
    attachDragPan(svg, container); // 内容超出滚动区时可按住拖拽平移（同画布体验）

    // 问题摘要（无问题时隐藏）
    const summary = document.createElement("div");
    summary.className = "rs-wf-summary";
    const c = (validation && validation.counts) || { missingNodes: 0, missingModels: 0, templates: 0 };
    const parts = [];
    if (c.missingNodes) parts.push(`⚠️ ${c.missingNodes} 个节点未安装`);
    if (c.missingModels) parts.push(`⚠️ ${c.missingModels} 个模型缺失`);
    if (c.templates) parts.push(`🔵 ${c.templates} 个模板变量运行时填入`);
    summary.textContent = parts.join(" · ");
    // 分阶段渲染会多次调用本函数，summaryTarget 是外部持久元素，必须整体替换而不是追加
    if (summaryTarget) summaryTarget.replaceChildren(summary);
    else container.appendChild(summary);
    return { svg, summary };
}
