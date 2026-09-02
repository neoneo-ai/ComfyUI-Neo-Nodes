/**
 * workflow.js — 工作流功能前端模块
 * 合并自 workflow-repair.js 与 workflow-repair-toolbar.js，便于后续扩展更多工作流功能。
 *
 * 1. 工作流模型路径修复（与素材/配方模块解耦）：任何工作流（UI 或 API 格式）
 *    载入画布前可调用后端 /neo_nodes/repair 检测失效的模型路径，并以二次确认弹窗
 *    让用户选择「修复并载入 / 取消」；自动匹配失败的项可在弹窗中手动选择替换文件，
 *    勾选「记住手动选择」后保存为服务端修复映射，之后相同失效路径自动替换；
 *    确认的每次修复按工作流关联写入本地修复日志（localStorage），供后续复查修改点。
 * 2. 顶栏操作按钮（actionBarButtons）：「修复工作流」一键按钮 + 「修复记录」表格，
 *    由前端渲染进 [data-testid="action-bar-buttons"]（与其他操作按钮同行）。
 */
import { api } from "../../../../scripts/api.js";
import { app } from "../../../../scripts/app.js";
import { showToast } from './gallery-utils.js';

/**
 * 调用修复 API。返回 { ok, data, error }：
 *   ok=true  — 请求成功，data 为后端载荷（无失效项时 data.changes 为空数组）
 *   ok=false — 请求失败（网络/HTTP/后端错误），调用方应退回原工作流并提示用户
 * decisions/remember：修复弹窗中的手动选择与「记住」勾选，提交后端套用并保存映射。
 */
export async function repairWorkflow(workflow, decisions, remember) {
    if (!workflow || typeof workflow !== 'object') return { ok: true, data: null };
    try {
        const resp = await api.fetchApi('/neo_nodes/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow, decisions, remember })
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const data = await resp.json();
        return data && data.success ? { ok: true, data } : { ok: false, error: (data && data.error) || 'invalid response' };
    } catch (e) {
        console.warn('[Neo Repair] repairWorkflow:', e);
        return { ok: false, error: e };
    }
}

// ===== 修复日志（localStorage，按工作流关联，新→旧，每工作流上限 LOG_LIMIT 条） =====
const LOG_KEY = 'neo.workflowRepairLog';
const LOG_LIMIT = 50;

function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// 工作流结构标识：取节点 id+type 的稳定集合（与模型路径的修复值无关）。
// 修复只改 widget 值、不改节点结构，故同一工作流修复前后标识一致，据此把记录绑定到具体工作流。
// 兼容 UI 格式（nodes 数组，节点含 id/type）与 API 格式（{ "<id>": { class_type } }）。
function workflowKey(workflow) {
    if (!workflow || typeof workflow !== 'object') return '';
    const pairs = [];
    const nodes = workflow.nodes;
    if (Array.isArray(nodes)) {
        for (const n of nodes) if (n && n.id != null) pairs.push(`${n.id}:${n.type || ''}`);
    } else {
        for (const k in workflow) {
            const v = workflow[k];
            if (v && typeof v === 'object' && typeof v.class_type === 'string') pairs.push(`${k}:${v.class_type}`);
        }
    }
    pairs.sort();
    return hashString(pairs.join(','));
}

function readLog() {
    try {
        const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
        return Array.isArray(log) ? log : [];
    } catch (e) {
        return [];
    }
}

function writeLog(log) {
    try {
        localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch (e) {
        console.warn('[Neo Repair] 修复日志写入失败:', e);
    }
}

/** 读取指定工作流的修复日志。条目：{ key, time, source, applied, missing, changes } */
export function getRepairLog(workflow) {
    const key = workflowKey(workflow);
    return readLog().filter((e) => e.key === key);
}

/** 清空指定工作流的修复记录。 */
export function clearRepairLog(workflow) {
    const key = workflowKey(workflow);
    writeLog(readLog().filter((e) => e.key !== key));
}

function recordRepairLog(data, source, workflow) {
    const key = workflowKey(workflow);
    const log = readLog();
    const mine = log.filter((e) => e.key === key);
    const others = log.filter((e) => e.key !== key);
    mine.unshift({
        key,
        time: new Date().toISOString(),
        source: source || 'unknown',
        applied: data.applied || 0,
        missing: data.missing || 0,
        changes: data.changes || []
    });
    writeLog([...mine.slice(0, LOG_LIMIT), ...others]);
}

// ===== 修改行元素（确认弹窗与修复记录表格共用） =====

/** 原路径（红色删除线） */
export function oldPathEl(value) {
    const s = document.createElement('span');
    s.textContent = value;
    s.title = value;
    s.style.cssText = 'color:#e88;text-decoration:line-through;';
    return s;
}

/** 修复结果（绿色）；无法修复时显示「未找到」，候选文件放入 title */
export function newPathEl(c) {
    const s = document.createElement('span');
    if (c.new) {
        s.textContent = c.new;
        s.title = c.new;
        s.style.cssText = 'color:#7d7;';
    } else {
        s.textContent = '未找到可用文件';
        s.style.cssText = 'color:#da6;';
        if (c.candidates && c.candidates.length) s.title = `候选文件：${c.candidates.join('、')}`;
    }
    return s;
}

/** 修复来源显示名（确认弹窗与修复记录共用） */
export const SOURCE_LABELS = { canvas: '画布', gallery: '素材库', recipes: '配方', import: '导入', unknown: '其他' };

/**
 * 构建修改点表格（3 列：节点·输入 / 原路径 / 修复为）。
 * 确认弹窗与修复记录共用；修复记录按次分组，时间/来源在各组标题中显示一次。
 * 传入 onPick 时为交互模式：未匹配且存在候选的行渲染手动选择下拉框。
 */
/** 交互模式下的手动选择下拉框：候选文件列表，空值 = 保持缺失。 */
function buildPickSelect(c, onPick) {
    const select = document.createElement('select');
    select.style.cssText = 'width:100%;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;font-size:12.5px;';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— 手动选择替换文件 —';
    select.appendChild(placeholder);
    for (const cand of c.candidates) {
        const opt = document.createElement('option');
        opt.value = cand;
        opt.textContent = cand;
        opt.title = cand;
        select.appendChild(opt);
    }
    select.onchange = () => onPick(c, select.value);
    return select;
}

export function buildChangesTable(changes, onPick) {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;font-size:12.5px;';
    const col = (w) => {
        const c = document.createElement('col');
        c.style.width = w;
        return c;
    };
    const header = (h) => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'position:sticky;top:0;background:#2a2a2a;color:#9ab;text-align:left;padding:6px 8px;border-bottom:1px solid #444;';
        return th;
    };
    const cell = (content) => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:5px 8px;border-bottom:1px solid #333;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        if (typeof content === 'string') td.textContent = content;
        else td.appendChild(content);
        return td;
    };
    const headRow = document.createElement('tr');
    for (const h of ['节点 · 输入', '原路径', '修复为']) headRow.appendChild(header(h));
    table.appendChild(headRow);
    table.append(col('220px'), col('1fr'), col('1fr'));
    // 字段名（unet_name / lora_name 等）默认省略；同一节点有多个失效输入时才显示以区分
    const inputsPerNode = {};
    for (const c of changes) {
        (inputsPerNode[c.node] || (inputsPerNode[c.node] = new Set())).add(c.input);
    }
    const nodeLabel = (c) => inputsPerNode[c.node].size > 1 ? `${c.type} · ${c.input}` : c.type;
    for (const c of changes) {
        const tr = document.createElement('tr');
        tr.appendChild(cell(nodeLabel(c)));
        tr.appendChild(cell(oldPathEl(c.old)));
        if (onPick && !c.new && Array.isArray(c.candidates) && c.candidates.length) {
            tr.appendChild(cell(buildPickSelect(c, onPick)));
        } else {
            tr.appendChild(cell(newPathEl(c)));
        }
        table.appendChild(tr);
    }
    return table;
}

/**
 * 修复确认弹窗：只有「修复并载入 / 取消」两个按钮（按原样载入与取消等价，已移除）。
 * 未匹配且存在候选的行在「修复为」列渲染下拉框，可手动选择替换文件；
 * 勾选「记住手动选择」后，本次选择由后端保存为修复映射，之后相同失效路径自动替换。
 * 返回 Promise<{ action: 'repair' | 'cancel', decisions: [...], remember: bool }>。
 */
export function showRepairConfirmDialog(changes) {
    return new Promise((resolve) => {
        const existing = document.querySelector('.neo-repair-dialog');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.className = 'neo-repair-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:900px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;gap:8px;font-size:13px;';
        const close = (result) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e) => { if (e.key === 'Escape') close({ action: 'cancel', decisions: [], remember: false }); };
        document.addEventListener('keydown', onKey);

        const applied = changes.filter((c) => c.new).length;
        const missing = changes.length - applied;
        const pickable = changes.filter((c) => !c.new && c.candidates && c.candidates.length);
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
        title.textContent = missing
            ? `检测到 ${changes.length} 处失效的模型路径，${applied} 处已自动匹配${pickable.length ? '，其余可手动选择替换文件' : ''}`
            : `检测到 ${applied} 处模型路径已失效，已匹配到可用文件`;
        box.appendChild(title);

        // 手动选择：change -> 选中的替换文件（选回空值 = 保持缺失）
        const picks = new Map();
        const body = document.createElement('div');
        body.style.cssText = 'overflow:auto;max-height:50vh;';
        body.appendChild(buildChangesTable(changes, (c, value) => {
            if (value) picks.set(c, value); else picks.delete(c);
        }));
        box.appendChild(body);

        let rememberBox = null;
        if (pickable.length) {
            const rememberRow = document.createElement('label');
            rememberRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:#9ab;font-size:12.5px;cursor:pointer;';
            rememberBox = document.createElement('input');
            rememberBox.type = 'checkbox';
            rememberBox.checked = true;
            const rememberText = document.createElement('span');
            rememberText.textContent = '记住手动选择 — 以后遇到相同的失效路径自动修复';
            rememberRow.append(rememberBox, rememberText);
            box.appendChild(rememberRow);
        }

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
        const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
        const repairBtn = document.createElement('button');
        repairBtn.textContent = '修复并载入';
        repairBtn.style.cssText = base + 'background:#3a7a3a;color:#fff;';
        repairBtn.onclick = () => close({
            action: 'repair',
            decisions: [...picks.entries()].map(([c, value]) => ({
                node: c.node, input: c.input, old: c.old, value, folder: c.folder || null,
            })),
            remember: rememberBox ? rememberBox.checked : false,
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = base + 'background:transparent;color:#999;border:1px solid #555;';
        cancelBtn.onclick = () => close({ action: 'cancel', decisions: [], remember: false });
        btns.append(repairBtn, cancelBtn);
        box.appendChild(btns);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

/**
 * 载入前修复检查 + 二次确认。
 * source：修复来源（'canvas' / 'gallery' / 'recipes' / 'import'），写入修复日志。
 * 返回 { workflow, cancelled, repairedCount, missingCount, repairUnavailable }：
 *   workflow — 最终应载入画布的工作流（修复后或原样）
 *   cancelled — 用户取消载入（调用方应中止）
 *   repairedCount — 实际应用的修复数（用于提示）
 *   missingCount — 确认载入时仍未匹配的失效路径数（用于提示）
 *   repairUnavailable — 修复接口不可用，已按原样处理，调用方应给出警告提示
 */
export async function confirmWorkflowRepair(workflow, source) {
    const { ok, data, error } = await repairWorkflow(workflow);
    if (!ok) {
        console.warn('[Neo Repair] repair API unavailable, loading as-is:', error);
        return { workflow, cancelled: false, repairedCount: 0, missingCount: 0, repairUnavailable: true };
    }
    if (!data || !data.changes || !data.changes.length) {
        return { workflow, cancelled: false, repairedCount: 0, missingCount: 0 };
    }
    const { action, decisions, remember } = await showRepairConfirmDialog(data.changes);
    if (action !== 'repair') return { workflow, cancelled: true, repairedCount: 0, missingCount: 0 };
    let result = data;
    if (decisions.length) {
        // 手动选择提交给后端套用到修复结果；勾选「记住」时后端同时保存修复映射
        const second = await repairWorkflow(workflow, decisions, remember);
        if (second.ok && second.data) {
            result = second.data;
        } else {
            console.warn('[Neo Repair] apply manual picks failed:', second.error);
            showToast(app, 'warning', '手动选择的修复未应用，已按自动匹配结果载入');
        }
    }
    recordRepairLog(result, source, workflow);
    return {
        workflow: result.workflow,
        cancelled: false,
        repairedCount: result.applied || 0,
        missingCount: result.missing || 0,
    };
}

// ===== 导入工作流后自动检测失效模型路径并提示修复 =====
// 统一挂在载入入口 app.loadGraphData / app.loadApiJson：任何途径（打开/拖拽/最近/配方/素材/画布，
// UI 或 API 格式）的工作流先照常载入画布，随后静默检测；发现失效路径就给顶部扳手按钮提示（不弹窗），
// 弹窗只在用户点击扳手（runRepair）时触发，各导入途径流程一致。
let _detectingImport = false;

// 载入完成后的静默检测：只判断当前画布是否存在失效模型路径（不弹窗），有则给顶部扳手按钮加提示，
// 无则清除。弹窗只在用户点击按钮（runRepair）时触发。画布在检测期间被切换则丢弃本次结果。
async function afterLoadDetect() {
    if (_detectingImport || !app.graph?.nodes?.length) return;
    const key = workflowKey(app.graph.serialize());
    if (!key) return;
    _detectingImport = true;
    try {
        const wf = app.graph.serialize();
        const { ok, data } = await repairWorkflow(wf);
        if (app.graph && workflowKey(app.graph.serialize()) !== key) return; // 画布已切换，忽略
        setRepairHint(ok && data && data.changes ? data.changes.length : 0);
    } catch (e) {
        console.warn('[Neo Repair] import auto-detect:', e);
        setRepairHint(0);
    } finally {
        _detectingImport = false;
    }
}

function installImportRepairHook() {
    if (typeof app.loadGraphData === 'function' && !app.loadGraphData.__neoRepairHook) {
        const original = app.loadGraphData;
        const wrapped = async function () {
            const result = await original.apply(app, arguments);
            await afterLoadDetect();
            return result;
        };
        wrapped.__neoRepairHook = true;
        app.loadGraphData = wrapped;
    }
    if (typeof app.loadApiJson === 'function' && !app.loadApiJson.__neoRepairHook) {
        const original = app.loadApiJson;
        const wrapped = async function () {
            const result = await original.apply(app, arguments);
            await afterLoadDetect();
            return result;
        };
        wrapped.__neoRepairHook = true;
        app.loadApiJson = wrapped;
    }
}

// ===== 顶栏操作按钮（actionBarButtons） =====

// 修复期间防止重复触发（actionBarButtons 为声明式渲染，无法直接改按钮 disabled/opacity）
let repairBusy = false;

// 右键「修复工作流」按钮 → 修复映射管理；setup 可能多次触发，只绑定一次
let _ctxMenuBound = false;

// 顶部扳手按钮提示：检测到失效模型路径时给按钮加红框和右上角红点（不弹窗），点击按钮后清除。
// actionBarButtons 为声明式渲染，切页/焦点模式等会重建按钮，故用 MutationObserver 同步提示
// （与 LoRA Manager 一致）。观察器在首次需要提示时懒启动——此时画布已载入、操作栏已渲染。
let _repairHintCount = 0;
let _hintObserver = null;
const REPAIR_BTN_BASE_LABEL = '修复工作流 — 检测并修复当前画布中的失效模型路径（右键管理修复映射）';

function applyRepairHint() {
    const btn = document.querySelector('.neo-repair-btn');
    if (!btn) return;
    if (_repairHintCount > 0) {
        btn.classList.add('neo-repair-hint');
        btn.setAttribute('aria-label', `修复工作流：检测到 ${_repairHintCount} 处失效模型路径，点击修复`);
    } else {
        btn.classList.remove('neo-repair-hint');
        if (btn.getAttribute('aria-label') !== REPAIR_BTN_BASE_LABEL) {
            btn.setAttribute('aria-label', REPAIR_BTN_BASE_LABEL);
        }
    }
}

function setRepairHint(count) {
    _repairHintCount = Math.max(0, count | 0);
    if (_repairHintCount > 0) startHintObserver();
    applyRepairHint();
}

function startHintObserver() {
    if (_hintObserver || typeof MutationObserver === 'undefined') return;
    _hintObserver = new MutationObserver(() => applyRepairHint());
    const watchNode = document.querySelector('[data-testid="action-bar-buttons"]')
        || document.querySelector('.actionbar-container')
        || document.body;
    _hintObserver.observe(watchNode, { childList: true, subtree: true });
}

function fitToContent() {
    requestAnimationFrame(() => {
        const canvas = app.canvas;
        const nodes = canvas?.graph?.nodes;
        if (!nodes?.length || !canvas.ds?.fitToBounds) return;
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const n of nodes) {
            const r = n.boundingRect || [n.pos[0], n.pos[1], n.size?.[0] || 0, n.size?.[1] || 0];
            b[0] = Math.min(b[0], r[0]);
            b[1] = Math.min(b[1], r[1]);
            b[2] = Math.max(b[2], r[0] + r[2]);
            b[3] = Math.max(b[3], r[1] + r[3]);
        }
        if (!b.every(isFinite)) return;
        canvas.ds.fitToBounds([b[0] - 10, b[1] - 10, b[2] - b[0] + 20, b[3] - b[1] + 20]);
        canvas.setDirty?.(true, true);
    });
}

async function runRepair() {
    if (repairBusy) return;
    if (!app.graph?.nodes?.length) {
        showToast(app, 'info', '画布为空，无需修复');
        return;
    }
    repairBusy = true;
    try {
        setRepairHint(null); // 点击后由确认弹窗承载状态，先清除按钮提示
        const r = await confirmWorkflowRepair(app.graph.serialize(), 'canvas');
        if (r.cancelled) return;
        if (r.repairUnavailable) {
            showToast(app, 'warning', '修复检测不可用，画布保持原样', '后端修复接口未响应');
            return;
        }
        if (r.repairedCount > 0) {
            await app.loadGraphData(r.workflow);
            fitToContent();
            showToast(app, 'success', r.missingCount
                ? `已修复 ${r.repairedCount} 处模型路径，${r.missingCount} 处未能匹配`
                : `已修复 ${r.repairedCount} 处模型路径`);
        } else if (r.missingCount > 0) {
            showToast(app, 'warning', `仍有 ${r.missingCount} 处失效模型路径未能匹配`);
        } else {
            showToast(app, 'info', '检查完成：未发现失效模型路径');
        }
    } catch (err) {
        showToast(app, 'error', '修复失败', String(err.message || err));
    } finally {
        repairBusy = false;
    }
}

function showRepairLogDialog() {
    const existing = document.querySelector('.neo-repair-log-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'neo-repair-log-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:1080px;max-width:92vw;max-height:75vh;display:flex;flex-direction:column;gap:10px;font-size:13px;';
    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const current = app.graph ? app.graph.serialize() : null;
    const wfName = (typeof app.graph?.name === 'string' && app.graph.name.trim()) ? app.graph.name.trim() : '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
    title.textContent = wfName ? `修复记录 · ${wfName}` : '修复记录';
    box.appendChild(title);

    const log = getRepairLog(current);
    const total = log.reduce((n, e) => n + (e.changes?.length || 0), 0);
    const missing = log.reduce((n, e) => n + (e.missing || 0), 0);
    const summary = document.createElement('div');
    summary.style.cssText = 'color:#999;font-size:12px;';
    summary.textContent = log.length
        ? `共 ${log.length} 次修复 · ${total} 处修改（未匹配 ${missing} 处）`
        : '当前工作流暂无修复记录 — 在画布/素材/配方中确认修复后，修改点会按工作流记录在这里。';
    box.appendChild(summary);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;min-height:60px;';
    for (const entry of log) {
        const changes = entry.changes || [];
        if (!changes.length) continue;
        const group = document.createElement('div');
        group.style.cssText = 'margin-bottom:14px;';
        const label = document.createElement('div');
        label.style.cssText = 'padding:0 2px 4px;font-weight:bold;color:#8cf;font-size:12.5px;';
        label.textContent = `${new Date(entry.time).toLocaleString('zh-CN', { hour12: false })} · ${SOURCE_LABELS[entry.source] || '其他'}`;
        group.appendChild(label);
        group.appendChild(buildChangesTable(changes));
        body.appendChild(group);
    }
    box.appendChild(body);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空记录';
    clearBtn.style.cssText = base + 'background:transparent;color:#a66;border:1px solid #555;';
    clearBtn.onclick = () => {
        clearRepairLog(current);
        close();
        showToast(app, 'info', '当前工作流修复记录已清空');
    };
    const mappingsBtn = document.createElement('button');
    mappingsBtn.textContent = '修复映射';
    mappingsBtn.style.cssText = base + 'background:#444;color:#ddd;';
    mappingsBtn.onclick = () => { close(); showRepairMappingsDialog(); };
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = base + 'background:#444;color:#ddd;';
    closeBtn.onclick = close;
    btns.append(clearBtn, mappingsBtn, closeBtn);
    box.appendChild(btns);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

// ===== 修复映射管理：查看 / 删除手动选择保存的「失效路径 → 替换文件」映射 =====

async function showRepairMappingsDialog() {
    const existing = document.querySelector('.neo-repair-mappings-dialog');
    if (existing) existing.remove();
    let mappings = [];
    let loadError = false;
    try {
        const resp = await api.fetchApi('/neo_nodes/repair_mappings');
        const data = resp.ok ? await resp.json() : null;
        mappings = data && Array.isArray(data.mappings) ? data.mappings : [];
    } catch (e) {
        console.warn('[Neo Repair] load mappings:', e);
        loadError = true;
    }

    const overlay = document.createElement('div');
    overlay.className = 'neo-repair-mappings-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:820px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;gap:10px;font-size:13px;';
    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
    title.textContent = '修复映射';
    box.appendChild(title);

    const summary = document.createElement('div');
    summary.style.cssText = 'color:#999;font-size:12px;';
    box.appendChild(summary);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;min-height:60px;';
    box.appendChild(body);

    const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空全部';
    clearBtn.style.cssText = base + 'background:transparent;color:#a66;border:1px solid #555;';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = base + 'background:#444;color:#ddd;';
    closeBtn.onclick = close;
    btns.append(clearBtn, closeBtn);
    box.appendChild(btns);

    const refreshSummary = () => {
        summary.textContent = loadError
            ? '映射列表读取失败 — 后端接口未响应'
            : mappings.length
                ? `共 ${mappings.length} 条映射 — 载入遇到相同失效路径（含大小写/扩展名差异）时自动替换`
                : '暂无修复映射 — 在修复弹窗中手动选择替换文件并勾选「记住手动选择」后保存到这里。';
        clearBtn.disabled = loadError || !mappings.length;
        clearBtn.style.opacity = clearBtn.disabled ? '0.5' : '1';
    };

    const renderRows = () => {
        body.textContent = '';
        refreshSummary();
        for (const m of mappings) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid #333;';
            const label = document.createElement('span');
            label.style.cssText = 'flex:1;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            label.textContent = `[${m.folder}] ${m.wanted} → ${m.replacement}`;
            label.title = label.textContent;
            const del = document.createElement('button');
            del.textContent = '删除';
            del.style.cssText = 'flex:none;padding:2px 10px;border:1px solid #555;border-radius:4px;background:transparent;color:#a66;cursor:pointer;font-size:12px;';
            del.onclick = async () => {
                try {
                    const resp = await api.fetchApi(`/neo_nodes/repair_mappings?key=${encodeURIComponent(m.key)}`, { method: 'DELETE' });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    mappings = mappings.filter((x) => x.key !== m.key);
                    renderRows();
                } catch (e) {
                    console.warn('[Neo Repair] delete mapping:', e);
                    showToast(app, 'error', '映射删除失败', String(e.message || e));
                }
            };
            row.append(label, del);
            body.appendChild(row);
        }
    };

    clearBtn.onclick = async () => {
        try {
            const resp = await api.fetchApi('/neo_nodes/repair_mappings?key=all', { method: 'DELETE' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            mappings = [];
            renderRows();
        } catch (e) {
            console.warn('[Neo Repair] clear mappings:', e);
            showToast(app, 'error', '映射清空失败', String(e.message || e));
        }
    };

    renderRows();
    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

app.registerExtension({
    name: "comfy.neo.workflowRepairToolbar",
    // ComfyUI 前端（≥1.33.9）将下列声明渲染进顶栏操作区 [data-testid="action-bar-buttons"]，
    // 与系统操作按钮同行；切页/焦点模式等重建由前端托管，无需手动挂载。
    // 「修复工作流」按钮套用前端主题高亮背景（--primary-bg，参考 LoRA Manager 的做法）使其突出：
    // 前端为构建期 Tailwind，不保证打包自定义颜色 class，故用独立 <style> 规则 + 既有主题变量
    // （--primary-bg/--primary-hover-bg，默认主题色 #60a5fa）保证高亮始终渲染且随主题切换。
    setup() {
        const styleId = "neo-repair-btn-style";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            style.textContent =
                ".neo-repair-btn{background-color:var(--primary-bg,#60a5fa);border-radius:6px;border:1px solid transparent;position:relative;color:#fff;transition:background-color .2s ease;}" +
                ".neo-repair-btn:hover{background-color:var(--primary-hover-bg,var(--primary-bg,#60a5fa));}" +
                ".neo-repair-btn svg{color:inherit;}" +
                // 静态提示（同 ComfyUI 错误指示风格）：红框 + 右上角红点
                ".neo-repair-btn.neo-repair-hint{border-color:var(--error-red,#f87171);box-shadow:0 0 0 1px rgba(248,113,113,.3);}" +
                ".neo-repair-btn.neo-repair-hint::after{content:\"\";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--error-red,#f87171);box-shadow:0 0 0 2px rgba(0,0,0,.25);}";
            document.head.appendChild(style);
        }
        // 导入工作流后自动检测失效模型路径并提示修复（挂载 loadGraphData / loadApiJson）
        installImportRepairHook();
        // 右键「修复工作流」按钮：打开修复映射管理（actionBarButtons 为声明式渲染，
        // 无法在按钮对象上挂事件，用 document 级监听按按钮 class 拦截）
        if (!_ctxMenuBound) {
            _ctxMenuBound = true;
            document.addEventListener('contextmenu', (e) => {
                if (e.target instanceof Element && e.target.closest('.neo-repair-btn')) {
                    e.preventDefault();
                    showRepairMappingsDialog();
                }
            });
        }
    },
    actionBarButtons: [
        {
            icon: "icon-[lucide--wrench] size-5",
            tooltip: "修复工作流 — 检测并修复当前画布中的失效模型路径（右键管理修复映射）",
            onClick: runRepair,
            class: "neo-repair-btn h-full",
        },
        {
            icon: "icon-[lucide--history] size-5",
            tooltip: "修复记录 — 查看当前工作流的本地修复日志",
            onClick: showRepairLogDialog,
            class: "h-full hover:bg-button-hover-surface",
        },
    ],
});
