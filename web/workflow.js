/**
 * workflow.js — 工作流功能前端模块
 * 合并自 workflow-repair.js 与 workflow-repair-toolbar.js，便于后续扩展更多工作流功能。
 *
 * 1. 工作流模型路径修复（与素材/配方模块解耦）：任何工作流（UI 或 API 格式）
 *    载入画布前可调用后端 /neo_nodes/repair 检测失效的模型路径，并以二次确认弹窗
 *    让用户选择「修复后载入 / 按原样载入 / 取消」；确认的每次修复按工作流关联写入本地
 *    修复日志（localStorage），供后续复查该工作流的修改点。
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
 */
export async function repairWorkflow(workflow) {
    if (!workflow || typeof workflow !== 'object') return { ok: true, data: null };
    try {
        const resp = await api.fetchApi('/neo_nodes/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow })
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
export const SOURCE_LABELS = { canvas: '画布', gallery: '素材库', recipes: '配方', unknown: '其他' };

/**
 * 构建修改点表格（3 列：节点·输入 / 原路径 / 修复为）。
 * 确认弹窗与修复记录共用；修复记录按次分组，时间/来源在各组标题中显示一次。
 */
export function buildChangesTable(changes) {
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
        tr.appendChild(cell(newPathEl(c)));
        table.appendChild(tr);
    }
    return table;
}

/** 二次确认弹窗。返回 Promise<'repair' | 'original' | 'cancel'>。 */
export function showRepairConfirmDialog(changes) {
    return new Promise((resolve) => {
        const existing = document.querySelector('.neo-repair-dialog');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.className = 'neo-repair-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:900px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;gap:8px;font-size:13px;';
        const close = (action) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(action);
        };
        const onKey = (e) => { if (e.key === 'Escape') close('cancel'); };
        document.addEventListener('keydown', onKey);

        const applied = changes.filter((c) => c.new).length;
        const missing = changes.length - applied;
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
        title.textContent = missing
            ? `检测到 ${changes.length} 处失效的模型路径，其中 ${applied} 处已匹配到可用文件`
            : `检测到 ${applied} 处模型路径已失效，已匹配到可用文件`;
        box.appendChild(title);

        const body = document.createElement('div');
        body.style.cssText = 'overflow:auto;max-height:50vh;';
        body.appendChild(buildChangesTable(changes));
        box.appendChild(body);

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
        const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
        const mkBtn = (text, css, action) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.style.cssText = css;
            b.onclick = () => close(action);
            btns.appendChild(b);
        };
        if (applied) mkBtn('修复并载入', base + 'background:#3a7a3a;color:#fff;', 'repair');
        mkBtn('按原样载入', base + 'background:#444;color:#ddd;', 'original');
        mkBtn('取消', base + 'background:transparent;color:#999;border:1px solid #555;', 'cancel');
        box.appendChild(btns);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

/**
 * 载入前修复检查 + 二次确认。
 * source：修复来源（'canvas' / 'gallery' / 'recipes'），写入修复日志。
 * 返回 { workflow, cancelled, repairedCount, repairUnavailable }：
 *   workflow — 最终应载入画布的工作流（修复后或原样）
 *   cancelled — 用户取消载入（调用方应中止）
 *   repairedCount — 实际应用的修复数（用于提示）
 *   repairUnavailable — 修复接口不可用，已按原样处理，调用方应给出警告提示
 */
export async function confirmWorkflowRepair(workflow, source) {
    const { ok, data, error } = await repairWorkflow(workflow);
    if (!ok) {
        console.warn('[Neo Repair] repair API unavailable, loading as-is:', error);
        return { workflow, cancelled: false, repairedCount: 0, repairUnavailable: true };
    }
    if (!data || !data.changes || !data.changes.length) {
        return { workflow, cancelled: false, repairedCount: 0 };
    }
    const action = await showRepairConfirmDialog(data.changes);
    if (action === 'cancel') return { workflow, cancelled: true, repairedCount: 0 };
    if (action === 'repair') {
        recordRepairLog(data, source, workflow);
        return { workflow: data.workflow, cancelled: false, repairedCount: data.applied || 0 };
    }
    return { workflow, cancelled: false, repairedCount: 0 };
}

// ===== 顶栏操作按钮（actionBarButtons） =====

// 修复期间防止重复触发（actionBarButtons 为声明式渲染，无法直接改按钮 disabled/opacity）
let repairBusy = false;

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
        const r = await confirmWorkflowRepair(app.graph.serialize(), 'canvas');
        if (r.cancelled) return;
        if (r.repairUnavailable) {
            showToast(app, 'warning', '修复检测不可用，画布保持原样', '后端修复接口未响应');
            return;
        }
        if (r.repairedCount > 0) {
            await app.loadGraphData(r.workflow);
            fitToContent();
            showToast(app, 'success', `已修复 ${r.repairedCount} 处模型路径`);
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
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = base + 'background:#444;color:#ddd;';
    closeBtn.onclick = close;
    btns.append(clearBtn, closeBtn);
    box.appendChild(btns);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

app.registerExtension({
    name: "comfy.neo.workflowRepairToolbar",
    // ComfyUI 前端（≥1.33.9）将下列声明渲染进顶栏操作区 [data-testid="action-bar-buttons"]，
    // 与系统操作按钮同行；切页/焦点模式等重建由前端托管，无需手动挂载。
    // size-5 放大图标、h-full 撑满顶栏高度、hover 用官方按钮高亮色，使按钮更突出。
    actionBarButtons: [
        {
            icon: "icon-[lucide--wrench] size-5",
            tooltip: "修复工作流 — 检测并修复当前画布中的失效模型路径",
            onClick: runRepair,
            class: "h-full hover:bg-button-hover-surface",
        },
        {
            icon: "icon-[lucide--history] size-5",
            tooltip: "修复记录 — 查看当前工作流的本地修复日志",
            onClick: showRepairLogDialog,
            class: "h-full hover:bg-button-hover-surface",
        },
    ],
});
