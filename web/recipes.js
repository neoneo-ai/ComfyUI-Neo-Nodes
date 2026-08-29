/**
 * recipes.js — Neo-Nodes 视频配方模块
 * 配方 = 提示词 + 有序多资产(图/视频)。负责：
 *   - 从当前工作流收集资源 (LoadImage / LoadVideo) 供「保存为配方」
 *   - 调用后端 /rs_recipes/* API
 *   - 侧边栏「配方」面板：列表 + 一键发送到工作流
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { $el } from "../../../../scripts/ui.js";

const assetUrl = (recipe, file) =>
    `${window.location.protocol}//${window.location.host}/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}`;

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

/** 是否禁用节点：参照 @ chips 过滤，跳过 BYPASS(mode 2) 与 NEVER(mode 4)。 */
function isNodeDisabled(n) {
    return n.mode === 2 || n.mode === 4;
}

function buildLinkMap(serializedLinks) {
    const linkMap = new Map();
    if (Array.isArray(serializedLinks)) {
        for (const l of serializedLinks) {
            // [id, origin_id, origin_slot, target_id, target_slot, type]
            if (Array.isArray(l)) linkMap.set(String(l[0]), { target_id: l[3], target_slot: l[4] });
        }
    } else {
        const gl = app.graph?.links;
        const iter = gl && typeof gl.forEach === 'function' ? gl : Object.values(gl || {});
        iter.forEach(l => { if (l && l.target_id != null) linkMap.set(String(l.id), l); });
    }
    return linkMap;
}

// 节点的媒体输出连到目标节点指定类型输入槽的参数序号（1-based）；无连线返回 null
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
                if (i === slotIdx) return count;
            }
        }
    }
    return null;
}

/** 找到 Load 节点上承载媒体文件引用的 widget（优先按名称匹配，退化为第一个像媒体引用的值）。 */
function findMediaWidget(n, isLoadImage, isLoadVideo) {
    const namePat = isLoadImage ? /image|upload/i : /video/i;
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
 * 扫描工作流中的 LoadImage / LoadVideo 节点，保存与还原共用同一编码规则：
 *   - 跳过禁用（BYPASS/NEVER）状态的节点；
 *   - 用 graphToPrompt 序列化连线，计算输出连到目标节点 IMAGE/VIDEO 输入槽的
 *     参数序号（1-based），未连线为 null；
 *   - 返回 { node, live, widget, value, kind, slot }，widget 是活动节点上可写的媒体 widget。
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
    const nodeById = new Map(nodes.map(n => [String(n.id), n]));
    const liveById = new Map((app.graph?._nodes || []).map(n => [String(n.id), n]));

    const out = [];
    for (const n of nodes) {
        if (isNodeDisabled(n)) continue;
        const cls = String(n.comfyClass || n.type || '');
        const isLoadImage = /load.?image/i.test(cls);
        const isLoadVideo = /load.?video/i.test(cls);
        if (!isLoadImage && !isLoadVideo) continue;
        const kind = isLoadVideo ? 'video' : 'image';
        const live = liveById.get(String(n.id)) || null;
        const widget = live ? findMediaWidget(live, isLoadImage, isLoadVideo) : null;
        const value = widget ? widget.value : findMediaValueFromWidgetsValues(n.widgets_values);
        const slot = computeSlotNo(n, kind.toUpperCase(), linkMap, nodeById);
        out.push({ node: n, live, widget, value, kind, slot });
    }
    return out;
}

/**
 * 扫描工作流，收集媒体文件引用（保存用）。与还原共用 scanMediaNodes 的编码规则：
 * 有参数位的资源（连到目标节点 IMAGE/VIDEO 输入槽）按参数序号在前，
 * 未连线资源按图序在后，图片组在前、视频组在后。
 */
export async function collectWorkflowAssets() {
    const scanned = await scanMediaNodes();
    const pick = (kind, conn) => {
        const arr = scanned.filter(s => s.kind === kind && (conn ? s.slot != null : s.slot == null));
        if (conn) arr.sort((a, b) => a.slot - b.slot);
        return arr.map(s => widgetValueToRef(s.value)).filter(Boolean);
    };
    // 保存时后端按此顺序写入配方 assets，还原时按同规则反解即可落回原参数位置
    return [
        ...pick('image', true), ...pick('image', false),
        ...pick('video', true), ...pick('video', false),
    ];
}

// ==========================================
// 后端 API
// ==========================================

export async function saveRecipe(name, prompt, assets) {
    const resp = await api.fetchApi('/rs_recipes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt, assets })
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

/** 把当前提示词写入第一个可用的 Neo Prompt 节点。 */
function applyPromptToNeo(prompt) {
    if (!prompt) return false;
    let sent = false;
    const nodes = app.graph?._nodes || [];
    for (const n of nodes) {
        if (sent || !n._rsPromptUIElements || isNodeDisabled(n)) continue;
        const { customTextarea, textWidget } = n._rsPromptUIElements;
        if (customTextarea) {
            customTextarea.value = prompt;
            if (textWidget) textWidget.value = prompt;
            customTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            sent = true;
        }
    }
    return sent;
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

/** 一键发送：与保存时的编码规则互逆，把资产还原到原参数位置，禁用节点不参与；提示词写入 Neo Prompt 节点。 */
export async function applyRecipeToWorkflow(recipe) {
    const result = await sendRecipeToWorkflow(recipe.name);
    if (!result.success) {
        app.extensionManager.toast.add({ severity: 'error', summary: '发送失败', detail: result.error, life: 4000 });
        return false;
    }

    const scanned = await scanMediaNodes();
    let applied = 0, missing = 0;
    for (const kind of ['image', 'video']) {
        // 连线槽按参数序号升序，与配方中该类资产（保存时即按参数位序编码）逐一配对还原；
        // 未连线节点作为备用槽承接剩余资产；禁用节点不在 scanned 中，不会被改写
        const conn = scanned.filter(s => s.kind === kind && s.widget && s.slot != null)
            .sort((a, b) => a.slot - b.slot);
        const spare = scanned.filter(s => s.kind === kind && s.widget && s.slot == null);
        let ci = 0;
        for (const asset of result.assets) {
            if (asset.kind !== kind) continue;
            let t = null;
            if (ci < conn.length) t = conn[ci++];
            else if (spare.length) t = spare.shift();
            if (!t) { missing++; continue; }
            setWidgetValue({ node: t.live, widget: t.widget }, asset.file);
            applied++;
        }
    }

    const promptApplied = applyPromptToNeo(recipe.prompt);
    const detail = [`${recipe.name}：按参数位还原 ${applied} 个资源`];
    if (missing) detail.push(`${missing} 个无可用节点`);
    if (promptApplied) detail.push('提示词已写入');
    app.extensionManager.toast.add({
        severity: applied || promptApplied ? 'success' : 'info',
        summary: '配方已发送',
        detail: detail.join('，'),
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
        $el('h3', { className: 'neo-recipes-title', textContent: '🍱 视频配方' }),
        $el('button', {
            className: 'rs-btn rs-action-btn neo-recipes-refresh',
            textContent: '↻', title: '刷新',
            onclick: () => renderList()
        })
    ]);
    root.appendChild(header);

    const listEl = $el('div', { className: 'neo-recipes-list' });
    root.appendChild(listEl);

    async function renderList() {
        listEl.innerHTML = '';
        let recipes = [];
        try { recipes = await listRecipes(); } catch (e) { /* 忽略 */ }

        if (recipes.length === 0) {
            listEl.appendChild($el('div', { className: 'neo-recipes-empty', textContent: '暂无配方。在 Neo Prompt Agent 节点点 💾 保存，选择「🍱 配方」模式。' }));
            return;
        }

        for (const r of recipes) {
            const card = $el('div', { className: 'neo-recipes-card' });

            const cover = $el('div', { className: 'neo-recipes-card-cover' });
            const coverFile = r.cover || (r.assets?.[0]?.kind === 'image' ? r.assets[0].file : null);
            if (coverFile) {
                const img = $el('img', { src: assetUrl(r.name, coverFile), alt: r.name });
                cover.appendChild(img);
            } else {
                cover.appendChild($el('div', { className: 'neo-recipes-card-no-cover', textContent: r.assets?.length ? '🎬' : '📝' }));
            }

            const body = $el('div', { className: 'neo-recipes-card-body' }, [
                $el('div', { className: 'neo-recipes-card-name', textContent: r.name, title: r.name }),
                $el('div', { className: 'neo-recipes-card-meta', textContent: `${r.asset_count ?? 0} 个资源 · ${(r.prompt || '').slice(0, 40) || '无提示词'}` })
            ]);

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

            card.append(cover, body, sendBtn);
            listEl.appendChild(card);
        }
    }

    await renderList();
    return root;
}

