/**
 * recipes.js — Neo-Nodes 配方模块
 * 配方 = 提示词 + 有序多资产(图/视频/音频)。负责：
 *   - 从当前工作流收集资源 (LoadImage / LoadVideo / LoadAudio) 供「保存配方」
 *   - 调用后端 /rs_recipes/* API
 *   - 侧边栏「配方」面板：列表 + 一键发送到工作流
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { $el } from "../../../../scripts/ui.js";
import { Lightbox } from "./lightbox.js";

const assetUrl = (recipe, file, dir) =>
    `${window.location.protocol}//${window.location.host}/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;

// 配方统一立方体图标：侧边栏标题、保存弹窗按钮、预设列表条目共用
export const RECIPE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

// ==========================================
// 从工作流收集资源
// ==========================================

/** 把 widget 值规范成 Comfy 文件引用 {filename, subfolder, type}；无法解析返回 null。
 * 兼容对象 / ["name","sub","type"] 数组 / 字符串（含 [input]/[output]/[temp] 注解）。 */
function widgetValueToRef(v) {
    if (!v) return null;
    if (typeof v === 'object' && v.filename) {
        return { filename: v.filename, subfolder: v.subfolder || '', type: v.type || 'input' };
    }
    if (Array.isArray(v)) {
        const [filename, subfolder, type] = v;
        if (filename) return { filename, subfolder: subfolder || '', type: type || 'input' };
        return null;
    }
    if (typeof v === 'string' && v.trim()) {
        let s = v.trim();
        let type = 'input';
        const m = s.match(/^(.*?)\s*\[(input|output|temp)\]$/i);
        if (m) { s = m[1].trim(); type = m[2].toLowerCase(); }
        let filename = s, subfolder = '';
        const idx = s.lastIndexOf('/');
        if (idx > 0) { subfolder = s.slice(0, idx); filename = s.slice(idx + 1); }
        if (filename) return { filename, subfolder, type };
    }
    return null;
}

/** 是否禁用节点：跳过 Mute/Never(mode 2) 与 Bypass(mode 4)。 */
function isNodeDisabled(n) {
    return n.mode === 2 || n.mode === 4;
}

function buildLinkMap(serializedLinks) {
    const linkMap = new Map();
    if (Array.isArray(serializedLinks)) {
        for (const l of serializedLinks) {
            // [id, origin_id, origin_slot, target_id, target_slot, type]
            if (Array.isArray(l)) linkMap.set(String(l[0]), { origin_id: l[1], target_id: l[3], target_slot: l[4] });
        }
    } else {
        const gl = app.graph?.links;
        const iter = gl && typeof gl.forEach === 'function' ? gl : Object.values(gl || {});
        iter.forEach(l => {
            if (l && l.target_id != null) linkMap.set(String(l.id), { origin_id: l.origin_id, target_id: l.target_id, target_slot: l.target_slot });
        });
    }
    return linkMap;
}

/** 连通子图：把画布连线当无向边做并查集，返回 nodeId -> 子图根 nodeId。
 * 同一画布上互不相连的多张工作流图各自成一个子图；disable 节点仍作桥接参与划分。 */
function buildComponents(nodes, linkMap) {
    const parent = new Map(nodes.map(n => [String(n.id), String(n.id)]));
    const find = (x) => {
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
        return root;
    };
    for (const link of linkMap.values()) {
        const a = String(link.origin_id), b = String(link.target_id);
        if (!parent.has(a) || !parent.has(b)) continue;
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    }
    for (const id of parent.keys()) find(id);
    return parent;
}

// 节点的媒体输出连到目标节点指定类型输入槽的参数序号（1-based）；无连线返回 null
// 同时返回 targetId（连到的下游目标节点 id），供还原端「同目标节点的分组/计数」
function computeSlotNo(n, slotType, linkMap, nodeById) {
    for (const o of n.outputs || []) {
        const lids = Array.isArray(o.links) ? o.links : (o.link != null ? [o.link] : []);
        for (const lid of lids) {
            const link = linkMap.get(String(lid));
            if (!link) continue;
            const target = nodeById.get(String(link.target_id));
            if (!target) continue;
            let count = 0;
            const slotIdx = Number(link.target_slot) || 0;
            for (let i = 0; i < (target.inputs || []).length; i++) {
                if (String(target.inputs[i].type).toUpperCase() !== slotType) continue;
                count++;
                if (i === slotIdx) return { slot: count, targetId: String(link.target_id) };
            }
        }
    }
    return null;
}

/** 找到 Load 节点上承载媒体文件引用的 widget（优先按名称匹配，退化为第一个像媒体引用的值）。 */
function findMediaWidget(n, kind) {
    const namePat = kind === 'video' ? /video/i : kind === 'audio' ? /audio|upload/i : /image|upload/i;
    let found = null;
    for (const w of n.widgets || []) {
        const v = w.value;
        const shaped = (typeof v === 'string' && v) || (Array.isArray(v) && v.length) ||
            (v && typeof v === 'object' && (v.filename || v.name));
        if (namePat.test(w.name || '')) {
            if (shaped || w.type === 'combo') return w;
            if (!found) found = w;
        } else if (!found && shaped) {
            found = w;
        }
    }
    return found;
}

function findMediaValueFromWidgetsValues(widgetsValues) {
    for (const entry of widgetsValues || []) {
        if (typeof entry === 'string' || Array.isArray(entry)) return entry;
        if (entry && typeof entry === 'object' && (entry.name || entry.filename)) return entry;
    }
    return null;
}

/**
 * 扫描工作流中的 LoadImage / LoadVideo / LoadAudio 节点，保存与还原共用同一编码规则：
 *   - 跳过禁用（BYPASS/NEVER）状态的节点；
 *   - 用 graphToPrompt 序列化连线，计算输出连到目标节点 IMAGE/VIDEO/AUDIO 输入槽的
 *     参数序号（1-based）与目标节点 id，未连线为 null；
 *   - 返回 { media, comps, sizes, disabledConn }：media 元素为
 *     { node, live, widget, value, kind, slot, targetId }，widget 是活动节点上
 *     可写的媒体 widget；comps 为 nodeId -> 连通子图根 nodeId，sizes 为子图根 ->
 *     节点数（含禁用节点）；disabledConn 为「已连线但被禁用的 Load 节点」，
 *     用于还原端补齐资产时的自动 enable 对齐。
 */
async function scanMediaNodes() {
    let nodes = null;
    let serializedLinks = null;
    if (typeof app?.graphToPrompt === 'function') {
        try {
            const prompt = await app.graphToPrompt();
            nodes = prompt?.workflow?.nodes || null;
            serializedLinks = prompt?.workflow?.links || null;
        } catch (e) {
            console.warn('[Neo Recipes] graphToPrompt:', e);
        }
    }
    if (!Array.isArray(nodes)) nodes = app.graph?._nodes || [];
    const linkMap = buildLinkMap(serializedLinks);
    const comps = buildComponents(nodes, linkMap);
    const sizes = new Map();
    for (const n of nodes) {
        const root = comps.get(String(n.id));
        sizes.set(root, (sizes.get(root) || 0) + 1);
    }
    const nodeById = new Map(nodes.map(n => [String(n.id), n]));
    const liveById = new Map((app.graph?._nodes || []).map(n => [String(n.id), n]));

    const media = [];
    const disabledConn = [];
    for (const n of nodes) {
        const cls = String(n.comfyClass || n.type || '');
        const isLoadImage = /load.?image/i.test(cls);
        const isLoadVideo = /load.?video/i.test(cls);
        const isLoadAudio = /load.?audio/i.test(cls);
        if (!isLoadImage && !isLoadVideo && !isLoadAudio) continue;
        const kind = isLoadVideo ? 'video' : isLoadAudio ? 'audio' : 'image';
        const live = liveById.get(String(n.id)) || null;
        const widget = live ? findMediaWidget(live, kind) : null;
        const value = widget ? widget.value : findMediaValueFromWidgetsValues(n.widgets_values);
        const slotInfo = computeSlotNo(n, kind.toUpperCase(), linkMap, nodeById);
        const slot = slotInfo?.slot ?? null;
        const targetId = slotInfo?.targetId ?? null;
        if (isNodeDisabled(n)) {
            if (slot != null && live) disabledConn.push({ node: n, live, widget, kind, slot, targetId });
        } else {
            media.push({ node: n, live, widget, value, kind, slot, targetId });
        }
    }
    return { media, comps, sizes, disabledConn };
}

/**
 * 扫描工作流，收集媒体文件引用（保存用）。与还原共用 scanMediaNodes 的编码规则：
 * 只收集 anchorNode（当前 Neo Prompt 节点）所在连通子图内、输出已连线的资源，
 * 图片组按参数序号在前、视频、音频组在后；其他子图与未连线节点一律不保存。
 */
export async function collectWorkflowAssets(anchorNode) {
    const { media: scanned, comps } = await scanMediaNodes();
    const root = anchorNode ? comps.get(String(anchorNode.id)) : null;
    const pick = (kind) => scanned
        .filter(s => s.kind === kind && s.slot != null && comps.get(String(s.node.id)) === root)
        .sort((a, b) => a.slot - b.slot)
        .map(s => {
            // kind 来自加载节点类型（LoadImage/LoadVideo/LoadAudio）：mp4 等文件可能
            // 作为音频使用，后端不能用后缀反推，故随 ref 一并传给配方记录
            const ref = widgetValueToRef(s.value);
            return ref ? { ...ref, kind: s.kind } : null;
        })
        .filter(Boolean);
    // 保存时后端按此顺序写入配方 assets，还原时按同规则反解即可落回原参数位置
    return [...pick('image'), ...pick('video'), ...pick('audio')];
}

/** 是否为“结果输出”节点：只有这类节点产生的结果才应存入 samples。
 *  排除 load 类与输入类（LoadImage 的输出是输入资产而非执行结果）。
 *  按 comfyClass 特征匹配：save / preview / output / combine / vhs / audio 等。 */
function isOutputNode(n) {
    const cls = String(n.comfyClass || n.type || '');
    // 明确的输入/加载类或中间节点（不产生“结果”）
    if (/^(load_|load[A-Z0-9])/i.test(cls) || /load.?image|load.?video|load.?audio|load.?latent/im.test(cls)) return false;
    if (/\b(input|load)\b/i.test(cls)) return false;
    // 只认可明确的结果输出节点
    return /(save|preview|output|combine|vhs|videohelper|audio|result|export|download|upload|animate)/i.test(cls);
}

/** 计算每个节点的最长路径深度（拓扑执行序的深度）。输出节点结果将只保留深度最大者 =
 *  最终结果；中间结果节点（被后续节点继续消费/继续输出的）会被忽略。
 *  以节点 id 为键返回 Map。 */
function computeNodeDepths(nodes, linkMap) {
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const memo = new Map();
    const visiting = new Set();
    const depthOf = (id) => {
        if (memo.has(id)) return memo.get(id);
        if (visiting.has(id)) return 0; // 环保护：不计入深度
        visiting.add(id);
        let d = 0;
        for (const link of linkMap.values()) {
            if (String(link.target_id) !== id) continue;
            const oid = String(link.origin_id);
            if (byId.has(oid)) d = Math.max(d, depthOf(oid) + 1);
        }
        visiting.delete(id);
        memo.set(id, d);
        return d;
    };
    const depths = new Map();
    for (const n of nodes) depths.set(String(n.id), depthOf(String(n.id)));
    return depths;
}

/** 收集当前画布最近一次执行的输出（app.nodeOutputs），kind 按输出节点类型判定。
 *  只收确实落在 Comfy output 目录的结果（img.type === 'output'）：LoadImage 等输入
 *  节点的缓存 type 为 input（读入的图片是输入资产而非执行结果），天然被排除。
 *  只保留拓扑执行序最末端的输出节点结果（最终结果）；中间结果（被后续继续处理的）忽略。 */
export function collectWorkflowResults() {
    const outputs = app.nodeOutputs || {};
    const nodes = app.graph?._nodes || [];
    const linkMap = buildLinkMap();
    const depths = computeNodeDepths(nodes, linkMap);

    let maxDepth = -1;
    const outNodes = [];
    for (const n of nodes) {
        if (!isOutputNode(n)) continue;
        const images = outputs[String(n.id)]?.images;
        if (!Array.isArray(images) || !images.length) continue;
        const d = depths.get(String(n.id)) ?? 0;
        outNodes.push({ n, d });
        if (d > maxDepth) maxDepth = d;
    }
    // 只保留深度最大（最终）的输出节点集合
    const finals = outNodes.filter(x => x.d === maxDepth);

    const results = [];
    for (const { n } of finals) {
        const images = outputs[String(n.id)]?.images;
        if (!Array.isArray(images) || !images.length) continue;
        const cls = String(n.comfyClass || n.type || '');
        // kind 按输出节点类型判定：audio 类独有 → 音频；其余含 video/combine 特征 → 视频；否则图片
        const kind = /(saveaudio|audio)/i.test(cls) ? 'audio'
            : /video|combine|animate/i.test(cls) ? 'video'
                : 'image';
        for (const img of images) {
            if (!img || !img.filename || img.type !== 'output') continue; // 只收 output 目录产物
            results.push({ filename: img.filename, subfolder: img.subfolder || '', type: 'output', kind });
        }
    }
    return results;
}

// ==========================================
// 后端 API
// ==========================================

/** 收集当前画布完整工作流（与「导出工作流」同格式），供备份到配方 workflows/。 */
export async function collectWorkflowSnapshot() {
    if (typeof app?.graphToPrompt !== 'function') return null;
    try {
        const p = await app.graphToPrompt();
        return p?.workflow ?? null;
    } catch (e) {
        console.warn('[Neo Recipes] collectWorkflowSnapshot:', e);
        return null;
    }
}

/** 读回配方中某示例对应的工作流快照；请求失败抛出。 */
async function fetchSampleWorkflow(recipeName, wfFile) {
    const resp = await api.fetchApi(`/rs_recipes/workflow?recipe=${encodeURIComponent(recipeName)}&file=${encodeURIComponent(wfFile)}`);
    if (!resp.ok) throw new Error(`workflow fetch ${resp.status}`);
    return resp.json();
}

/** 把某示例对应的工作流快照加载到画布；无备份时报提示。返回是否成功。 */
async function copySampleWorkflowToCanvas(recipeName, wfFile) {
    if (!wfFile) {
        app.extensionManager.toast.add({ severity: 'info', summary: '无工作流备份', detail: '该示例未备份工作流', life: 4000 });
        return false;
    }
    try {
        const workflow = await fetchSampleWorkflow(recipeName, wfFile);
        await app.loadGraphData(workflow, true, true, `${recipeName} · 工作流备份`);
        app.extensionManager.toast.add({ severity: 'success', summary: '工作流已复制', detail: `已加载 ${recipeName} 的快照工作流`, life: 4000 });
        return true;
    } catch (err) {
        console.error('[Neo Recipes] Copy workflow failed:', err);
        app.extensionManager.toast.add({ severity: 'error', summary: '复制工作流失败', detail: err.message, life: 4000 });
        return false;
    }
}

export async function saveRecipe(name, prompt, assets, results = [], workflow = null) {
    const resp = await api.fetchApi('/rs_recipes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt, assets, results, workflow })
    });
    return resp.json();
}

export async function appendResultsToRecipe(name, results, workflow = null) {
    const resp = await api.fetchApi('/rs_recipes/append_results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, results, workflow })
    });
    return resp.json();
}

export async function deleteRecipeSample(name, file) {
    const resp = await api.fetchApi('/rs_recipes/delete_sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, file })
    });
    return resp.json();
}

export async function listRecipes() {
    const resp = await api.fetchApi('/rs_recipes/list', { method: 'POST' });
    return resp.ok ? resp.json() : [];
}

export async function deleteRecipe(name) {
    const resp = await api.fetchApi('/rs_recipes/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return resp.json();
}

export async function sendRecipeToWorkflow(name) {
    const resp = await api.fetchApi('/rs_recipes/send_to_workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return resp.json();
}

// ==========================================
// 一键发送到工作流
// ==========================================

/** 子图在下拉选项里的说明文案。 */
function describeSubgraph(index, stat, size) {
    const parts = [];
    if (stat.image.length) parts.push(`图片×${stat.image.length}`);
    if (stat.video.length) parts.push(`视频×${stat.video.length}`);
    if (stat.audio.length) parts.push(`音频×${stat.audio.length}`);
    parts.push(stat.prompt ? '含 Neo Prompt' : '无 Neo Prompt');
    return `子图 ${index}（${parts.join(' · ')} · ${size} 节点）`;
}

/** 多个子图并列匹配或数量不匹配时，弹下拉让用户指定还原到哪个子图；取消返回 null。 */
function chooseSubgraphDialog(options) {
    return new Promise(resolve => {
        const select = $el('select', { className: 'neo-recipes-subgraph-select' });
        for (const o of options) select.appendChild($el('option', { value: o.value, textContent: o.label }));
        const close = (value) => { overlay.remove(); resolve(value); };
        const body = $el('div', { className: 'neo-recipes-detail-body neo-recipes-subgraph-body' }, [
            $el('div', { className: 'neo-recipes-detail-name', textContent: '请选择还原到的子图' }),
            $el('div', { className: 'neo-recipes-detail-prompt', textContent: '配方只还原到同一个子图。当前画布存在多个互不相连的子图，请指定目标：' }),
            select,
            $el('div', { className: 'neo-recipes-detail-foot' }, [
                $el('button', { className: 'rs-btn neo-recipes-detail-close', textContent: '取消', onclick: () => close(null) }),
                $el('button', { className: 'rs-btn neo-recipes-detail-send', textContent: '✈️ 还原到该子图', onclick: () => close(select.value) }),
            ]),
        ]);
        const overlay = $el('div', { className: 'neo-recipes-detail' }, [body]);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        document.body.appendChild(overlay);
    });
}


function setWidgetValue(target, filename) {
    const { widget } = target;
    if (widget.type === 'combo') {
        widget.value = filename;
        if (widget.callback) widget.callback(filename);
    } else {
        widget.value = { filename, subfolder: '', type: 'input' };
    }
    if (target.node.onWidgetChanged) {
        try { target.node.onWidgetChanged(widget.name, widget.value); } catch (e) { /* 忽略 */ }
    }
    target.node.graph?.setDirtyCanvas(true, true);
}

/**
 * 还原前的自动对齐：当配方资产数与目标子图内已启用的 conn Load 节点数不一致时：
 *   - 资产偏多：按参数位升序启用子图内已连线但被禁用（BYPASS/Never）的同类节点补齐，
 *     能补多少补多少，仍不足的部分由还原流程按缺额提示；
 *   - 资产偏少：若该类启用节点全部连到同一个下游目标节点（参数位可比），按参数位降序
 *     把多余的启用节点设为 BYPASS（保留参数位靠前的参与还原）。
 * 约束：仅影响目标子图内的同类 conn Load 节点。
 * @returns {Promise<boolean>} 是否改动过节点 mode（调用方据此重扫刷新统计）
 */
async function autoToggleByTarget(targetRoot, want, disabledConn, scanned, comps) {
    let toggled = false;
    for (const kind of ['image', 'video', 'audio']) {
        if (!want[kind]) continue;
        const need = want[kind];
        const enabled = scanned.filter(s => s.slot != null && s.widget && !isNodeDisabled(s.node) && comps.get(String(s.node.id)) === targetRoot && s.kind === kind);
        if (enabled.length === need) continue;

        if (enabled.length < need) {
            // 缺：按参数位升序启用已连线但被禁用的同类节点补齐，能补多少补多少
            let short = need - enabled.length;
            const disabled = disabledConn
                .filter(d => comps.get(String(d.node.id)) === targetRoot && d.kind === kind && d.widget)
                .sort((a, b) => a.slot - b.slot);
            for (const d of disabled) {
                if (short <= 0) break;
                if (!d.live || !isNodeDisabled(d.live)) continue;
                d.live.mode = 0; // 启用
                d.live.graph?.setDirtyCanvas(true, true);
                short--;
                toggled = true;
            }
            continue;
        }

        // 多：启用节点按 targetId 分组，要求全部连到同一个下游目标节点（参数位可比），
        // 按 slot 降序把多余的启用节点设为 Bypass，保留参数位靠前的参与还原
        const byTarget = new Map();
        for (const s of enabled) {
            const list = byTarget.get(s.targetId);
            if (list) list.push(s); else byTarget.set(s.targetId, [s]);
        }
        if (byTarget.size !== 1) continue; // 多个目标节点 → 该类不裁剪
        const [enabledNodes] = byTarget.values();
        enabledNodes.sort((a, b) => a.slot - b.slot);
        for (let i = enabledNodes.length - 1; i >= need; i--) {
            const s = enabledNodes[i];
            if (!s.live || isNodeDisabled(s.live)) continue;
            s.live.mode = 4; // Bypass（Ctrl+B，半透明）；mode 2 是 Mute/Never（深色）
            s.live.graph?.setDirtyCanvas(true, true);
            toggled = true;
        }
    }
    return toggled;
}

/** 一键发送：与保存时的编码规则互逆，把资产还原到原参数位置，禁用节点不参与。
 *  资产与提示词只写进同一个连通子图：节点内预设入口（fillPrompt=false）以 anchorNode
 *  所在子图为准（同样先做自动对齐，全程不弹窗）；侧边栏入口找「资源数与连线 Load
 *  节点数一致（且含 Neo Prompt）」的子图，
 *  唯一匹配或画布仅一张子图时直接还原（数量差异由自动对齐补齐），多张子图无匹配或
 *  并列时弹下拉由用户指定；整体禁用的子图不参与，容纳不下的部分提示只还原了部分。 */
export async function applyRecipeToWorkflow(recipe, { fillPrompt = true, anchorNode = null } = {}) {
    const result = await sendRecipeToWorkflow(recipe.name);
    if (!result.success) {
        app.extensionManager.toast.add({ severity: 'error', summary: '发送失败', detail: result.error, life: 4000 });
        return false;
    }

    let { media: scanned, comps, sizes, disabledConn } = await scanMediaNodes();
    // 按子图统计可用还原目标：已连线的 Load 节点（按类型分开）与可写的 Neo Prompt；未连线节点不参与
    const statByRoot = new Map();
    const statOf = (root) => {
        let stat = statByRoot.get(root);
        if (!stat) statByRoot.set(root, stat = { image: [], video: [], audio: [], prompt: false });
        return stat;
    };
    for (const s of scanned) {
        if (s.slot == null || !s.widget) continue;
        const root = comps.get(String(s.node.id));
        if (root != null) statOf(root)[s.kind].push(s);
    }
    const promptNodes = (app.graph?._nodes || [])
        .filter(n => n._rsPromptUIElements?.customTextarea && !isNodeDisabled(n))
        .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    for (const n of promptNodes) {
        const root = comps.get(String(n.id));
        if (root != null) statOf(root).prompt = true;
    }

    // 选定目标子图：anchorNode 直接指定；否则按数量一致性精确匹配
    let target = null;
    const want = { image: 0, video: 0, audio: 0 };
    for (const a of result.assets) if (want[a.kind] != null) want[a.kind]++;

    if (anchorNode) {
        const root = comps.get(String(anchorNode.id));
        if (root != null) target = { root, stat: statOf(root) };
    } else {
        const needPrompt = fillPrompt && !!recipe.prompt;
        const candidates = [...statByRoot.keys()]
            .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
            .map(root => ({ root, stat: statByRoot.get(root), size: sizes.get(root) || 0 }));
        const matched = candidates.filter(({ stat }) =>
            stat.image.length === want.image && stat.video.length === want.video
            && stat.audio.length === want.audio && (!needPrompt || stat.prompt));
        if (matched.length === 1) {
            target = matched[0];
        } else if (!candidates.length) {
            app.extensionManager.toast.add({ severity: 'info', summary: '配方已发送', detail: `${recipe.name}：工作流程中无可匹配的子图，未还原`, life: 4000 });
            return true;
        } else if (candidates.length === 1) {
            // 画布上只有一张工作流图：无需确认，数量差异交给下面的自动对齐
            target = candidates[0];
        } else {
            // 数量对不上或多个子图并列：由用户在下拉中指定目标子图，取消则不动工作流
            const options = (matched.length ? matched : candidates).map(({ root, stat, size }, i) => ({
                value: root,
                label: describeSubgraph(i + 1, stat, size),
            }));
            const picked = await chooseSubgraphDialog(options);
            if (picked == null) return false;
            target = { root: picked, stat: statByRoot.get(picked) };
        }
    }

    // 自动对齐：资产数与该子图 conn Load 节点数不一致时，按同目标节点启/禁用补齐或裁剪
    // （节点内入口与侧边栏入口均适用，全程不弹窗）
    if (target) {
        const toggled = await autoToggleByTarget(target.root, want, disabledConn, scanned, comps);
        if (toggled) {
            // 重新扫描以获取更新后的节点状态
            const { media: rescanned, comps: recomp } = await scanMediaNodes();
            const rescanStatByRoot = new Map();
            const rescanStatOf = (root) => {
                let stat = rescanStatByRoot.get(root);
                if (!stat) rescanStatByRoot.set(root, stat = { image: [], video: [], audio: [], prompt: false });
                return stat;
            };
            for (const s of rescanned) {
                if (s.slot == null || !s.widget) continue;
                const root = recomp.get(String(s.node.id));
                if (root != null) rescanStatOf(root)[s.kind].push(s);
            }
            for (const n of promptNodes) {
                const root = recomp.get(String(n.id));
                if (root != null) rescanStatOf(root).prompt = true;
            }
            target.stat = rescanStatOf(target.root);
            comps = recomp; // 更新 comps 用于后续 Neo Prompt 查找
        }
    }

    // 只还原到选定子图：连线节点按参数位升序与配方资产逐一配对
    let applied = 0, missing = 0;
    for (const kind of ['image', 'video', 'audio']) {
        const slots = target ? target.stat[kind] : [];
        slots.sort((a, b) => a.slot - b.slot);
        let si = 0;
        for (const asset of result.assets) {
            if (asset.kind !== kind) continue;
            const t = si < slots.length ? slots[si++] : null;
            if (!t) { missing++; continue; }
            setWidgetValue({ node: t.live, widget: t.widget }, asset.file);
            applied++;
        }
    }

    const wantPrompt = fillPrompt && !!recipe.prompt;
    let promptApplied = false;
    if (wantPrompt && target?.stat.prompt) {
        const promptNode = promptNodes.find(n => comps.get(String(n.id)) === target.root);
        const { customTextarea, textWidget } = promptNode._rsPromptUIElements;
        customTextarea.value = recipe.prompt;
        if (textWidget) textWidget.value = recipe.prompt;
        customTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        promptApplied = true;
    }

    const total = result.assets.length;
    const partial = missing > 0 || (wantPrompt && !promptApplied);
    const parts = [`按参数位还原 ${applied}/${total} 个资源`];
    if (missing) parts.push(`${missing} 个资源该子图无可用节点`);
    if (promptApplied) parts.push('提示词已写入');
    else if (wantPrompt) parts.push('提示词未写入：该子图无 Neo Prompt');
    app.extensionManager.toast.add({
        severity: partial ? 'warn' : (applied || promptApplied ? 'success' : 'info'),
        summary: '配方已发送',
        detail: `${recipe.name}：${partial ? '仅还原了部分，' : ''}${parts.join('，')}`,
        life: 4000
    });
    return true;
}

// ==========================================
// 侧边栏「配方」面板
// ==========================================

export async function createRecipesPanel() {
    const root = $el('div', { className: 'neo-recipes-panel' });

    const header = $el('div', { className: 'neo-recipes-header' }, [
        $el('h3', { className: 'neo-recipes-title', innerHTML: `${RECIPE_ICON_SVG}<span>配方</span>` }),
        $el('button', {
            className: 'rs-btn rs-action-btn neo-recipes-refresh',
            textContent: '↻', title: '刷新',
            onclick: () => renderList()
        })
    ]);
    root.appendChild(header);

    const listEl = $el('div', { className: 'neo-recipes-list' });
    root.appendChild(listEl);

    /** 详情浮层：完整标题 + 完整提示词 + 资源网格（视频可预览）+ 示例结果 + 发送入口。 */
    function openDetail(r) {
        document.querySelector('.neo-recipes-detail')?.remove();

        // 缩略图为静态预览：video/audio 不拦截点击，统一由外层容器打开 Lightbox（播放交给 Lightbox 内的 controls+autoplay）
        const makeMedia = (a, dir) => {
            const src = assetUrl(r.name, a.file, dir);
            if (a.kind === 'video') return $el('video', { src, preload: 'metadata' });
            if (a.kind === 'audio') return $el('div', { className: 'neo-recipes-detail-asset-audio', textContent: `🎵 ${a.file}` });
            return $el('img', { src, alt: a.file, loading: 'lazy' });
        };

        // 资产缩略图：点击用 Lightbox 查看大图（图片可缩放/拖拽，音视频可播放）
        const assetItems = (r.assets || []).map(a => ({ kind: a.kind, url: assetUrl(r.name, a.file), title: a.file }));
        const grid = $el('div', { className: 'neo-recipes-detail-grid' });
        (r.assets || []).forEach((a, i) => {
            grid.appendChild($el('div', {
                className: 'neo-recipes-detail-asset',
                title: '点击放大查看',
                onclick: () => Lightbox.open({ items: assetItems, index: i })
            }, [
                makeMedia(a),
                $el('div', { className: 'neo-recipes-detail-file', textContent: a.file, title: a.file })
            ]));
        });
        const bodyChildren = [
            $el('div', { className: 'neo-recipes-detail-head' }, [
                $el('div', { className: 'neo-recipes-detail-name', textContent: r.name }),
                $el('div', { className: 'neo-recipes-detail-source', textContent: r.source === 'preset' ? '内置预设' : '我的配方' })
            ]),
            $el('div', { className: 'neo-recipes-detail-prompt', textContent: r.prompt || '（无提示词）' }),
            ...((r.assets || []).length ? [grid] : []),
        ];

        const samples = r.samples || [];
        if (samples.length) {
            const sampleWorkflows = r.sample_workflows || {};
            const sampleGrid = $el('div', { className: 'neo-recipes-detail-grid' });
            const sampleItems = samples.map(s => ({ kind: s.kind, url: assetUrl(r.name, s.file, 'samples'), title: s.file }));
            samples.forEach((s, i) => {
                const item = $el('div', {
                    className: 'neo-recipes-detail-asset',
                    title: '点击放大查看',
                    onclick: () => Lightbox.open({
                        items: sampleItems,
                        index: i,
                        // 有工作流备份的示例在 Lightbox 内提供「复制工作流」动作
                        actions: (cur) => (sampleWorkflows[cur.file]
                            ? [{
                                label: '📋 复制工作流',
                                title: '把该示例对应的工作流快照加载到画布',
                                onClick: (it) => copySampleWorkflowToCanvas(r.name, sampleWorkflows[it.file]),
                            }]
                            : []),
                    })
                }, [
                    makeMedia(s, 'samples'),
                    $el('div', { className: 'neo-recipes-detail-file', textContent: s.file, title: s.file })
                ]);
                // 复制工作流：preset/custom 均可读回快照；无备份则提示
                const copyBtn = $el('button', {
                    className: 'neo-recipes-sample-copy',
                    textContent: '📋',
                    title: '复制该示例对应的工作流到画布',
                    onclick: async (e) => {
                        e.stopPropagation();
                        copyBtn.disabled = true;
                        await copySampleWorkflowToCanvas(r.name, sampleWorkflows[s.file]);
                        copyBtn.disabled = false;
                    }
                });
                item.appendChild(copyBtn);
                if (r.source !== 'preset') {
                    const delBtn = $el('button', {
                        className: 'neo-recipes-sample-del',
                        textContent: '🗑',
                        title: '删除该示例结果',
                        onclick: async (e) => {
                            e.stopPropagation();
                            if (!confirm(`删除示例「${s.file}」？`)) return;
                            delBtn.disabled = true;
                            const res = await deleteRecipeSample(r.name, s.file);
                            delBtn.disabled = false;
                            if (res?.success) {
                                overlay.remove();
                                const list = await listRecipes();
                                const fresh = list.find(x => x.name === r.name);
                                if (fresh) openDetail(fresh);
                            } else {
                                app.extensionManager.toast.add({ severity: 'error', summary: '删除失败', detail: res?.error || 'Unknown error', life: 4000 });
                            }
                        }
                    });
                    item.appendChild(delBtn);
                }
                sampleGrid.appendChild(item);
            });
            bodyChildren.push($el('div', { className: 'neo-recipes-detail-section', textContent: `示例结果（${samples.length}）` }));
            bodyChildren.push(sampleGrid);
        }

        const sendBtn = $el('button', {
            className: 'rs-btn neo-recipes-detail-send',
            textContent: '✈️ 发送到工作流',
            onclick: async () => {
                sendBtn.disabled = true;
                const ok = await applyRecipeToWorkflow(r);
                sendBtn.disabled = false;
                if (ok) { overlay.remove(); await renderList(); }
            }
        });
        const closeBtn = $el('button', { className: 'rs-btn neo-recipes-detail-close', textContent: '关闭', onclick: () => overlay.remove() });
        bodyChildren.push($el('div', { className: 'neo-recipes-detail-foot' }, [closeBtn, sendBtn]));

        const body = $el('div', { className: 'neo-recipes-detail-body' }, bodyChildren);
        const overlay = $el('div', { className: 'neo-recipes-detail' }, [body]);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    function buildCard(r) {
        const card = $el('div', { className: 'neo-recipes-card' });

        const cover = $el('div', { className: 'neo-recipes-card-cover', title: '查看资源', onclick: () => openDetail(r) });
        const coverFile = r.cover
            || (r.samples || []).find(s => s.kind === 'image')?.file
            || (r.assets || []).find(a => a.kind === 'image')?.file
            || null;
        if (coverFile) {
            const img = $el('img', { src: assetUrl(r.name, coverFile), alt: r.name });
            cover.appendChild(img);
        } else {
            cover.appendChild($el('div', { className: 'neo-recipes-card-no-cover', textContent: r.assets?.length ? '🎬' : '📝' }));
        }

        const body = $el('div', { className: 'neo-recipes-card-body' }, [
            $el('div', { className: 'neo-recipes-card-name', textContent: r.name, title: '查看资源', onclick: () => openDetail(r) }),
            $el('div', { className: 'neo-recipes-card-meta', textContent: [r.asset_count ? `${r.asset_count} 个资源` : '', r.sample_count ? `${r.sample_count} 个示例` : '', (r.prompt || '').slice(0, 120) || '无提示词'].filter(Boolean).join(' · ') })
        ]);

        const top = $el('div', { className: 'neo-recipes-card-top' }, [cover, body]);
        const actions = $el('div', { className: 'neo-recipes-card-actions' });
        if (r.source !== 'preset') {
            const appendBtn = $el('button', {
                className: 'rs-btn rs-action-btn neo-recipes-append',
                title: '把当前工作流最近一次执行的输出追加为示例结果',
                textContent: '📥',
                onclick: async (e) => {
                    e.stopPropagation();
                    appendBtn.disabled = true;
                    const results = collectWorkflowResults();
                    const workflow = await collectWorkflowSnapshot();
                    const res = await appendResultsToRecipe(r.name, results, workflow);
                    appendBtn.disabled = false;
                    if (res?.success) {
                        app.extensionManager.toast.add({ severity: res.added ? 'success' : 'info', summary: '示例结果追加', detail: `${r.name}：新增 ${res.added}，跳过重复 ${res.skipped}`, life: 4000 });
                        await renderList();
                    } else {
                        app.extensionManager.toast.add({ severity: 'error', summary: '追加失败', detail: res?.error || 'Unknown error', life: 4000 });
                    }
                }
            });
            actions.append(appendBtn);
        }

        const sendBtn = $el('button', {
            className: 'rs-btn rs-action-btn neo-recipes-send',
            title: '一键发送到工作流',
            textContent: '✈️',
            onclick: async (e) => {
                e.stopPropagation();
                sendBtn.disabled = true;
                const ok = await applyRecipeToWorkflow(r);
                sendBtn.disabled = false;
                if (ok) await renderList();
            }
        });
        actions.append(sendBtn);

        if (r.source !== 'preset') {
            const delBtn = $el('button', {
                className: 'rs-btn rs-action-btn neo-recipes-delete',
                title: '删除配方',
                textContent: '🗑',
                onclick: async (e) => {
                    e.stopPropagation();
                    if (!confirm(`删除配方「${r.name}」？`)) return;
                    delBtn.disabled = true;
                    const res = await deleteRecipe(r.name);
                    delBtn.disabled = false;
                    if (res?.success) await renderList();
                    else app.extensionManager.toast.add({ severity: 'error', summary: '删除失败', detail: res?.error || 'Unknown error', life: 4000 });
                }
            });
            actions.append(delBtn);
        }
        card.append(top, actions);
        return card;
    }

    async function renderList() {
        listEl.innerHTML = '';
        let recipes = [];
        try { recipes = await listRecipes(); } catch (e) { /* 忽略 */ }

        if (recipes.length === 0) {
            listEl.appendChild($el('div', { className: 'neo-recipes-empty', textContent: '暂无配方。在 Neo Prompt 节点点 💾 保存，点「保存配方」。' }));
            return;
        }

        const groups = [
            { label: '我的配方', items: recipes.filter(r => r.source !== 'preset') },
            { label: '内置预设', items: recipes.filter(r => r.source === 'preset') },
        ];
        for (const g of groups) {
            if (!g.items.length) continue;
            listEl.appendChild($el('div', { className: 'neo-recipes-group-title', textContent: g.label }));
            for (const r of g.items) listEl.appendChild(buildCard(r));
        }
    }

    await renderList();
    return root;
}

