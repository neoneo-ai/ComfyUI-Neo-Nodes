/**
 * gallery-node-drop.js
 * 把 Gallery 卡片（图/视频/音频）直接拖放到画布上对应的 Load 节点：命中指针下方的
 * LoadImage / LoadVideo / LoadAudio，以及用 filename combo 接收图片的 Neo Grid Split，
 * 复用 image-gen 的 copy_to_input 通道写入（与「发送到节点」同一逻辑）。载荷媒体类型须与目标节点匹配，否则不写入。
 * 只处理 application/x-neo-gallery 载荷；ComfyUI 自身的资产/文件拖放不受影响。
 */

import { app } from "../../../../scripts/app.js";
import { applyImageToTarget } from "./image-gen.js";
import { isImageFile, isVideoFile, isAudioFile, showToast } from "./gallery-utils.js";

const NEO_GALLERY_MIME = "application/x-neo-gallery";

// 画布变换对：命中检测用 client→graph，高亮用 graph→client。
// 两者由同一个仿射变换导出、互为逆变换，保证高亮框与命中区域严格对齐。
// 优先取 canvasPosToGraph（核心 LoadImage 拖放用的是它）；缺失时回退 ds 手算，
// 注意 LiteGraph 的屏幕变换是 screen=(graph+offset)*scale，offset 同样要乘 scale。
function makeCanvasTransforms(cv) {
    const rect = cv.canvas.getBoundingClientRect();
    const f = cv.canvasPosToGraph;
    if (typeof f === "function") {
        const p0 = f([0, 0]), p1 = f([1, 0]), p2 = f([0, 1]);
        if ([p0, p1, p2].every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
            // graph = M · canvas + t；t=p0，M 两列 = p1-p0、p2-p0
            const m11 = p1[0] - p0[0], m21 = p1[1] - p0[1];
            const m12 = p2[0] - p0[0], m22 = p2[1] - p0[1];
            const det = m11 * m22 - m12 * m21;
            if (Math.abs(det) > 1e-9) {
                return {
                    toGraph: (clientX, clientY) => {
                        const cx = clientX - rect.left, cy = clientY - rect.top;
                        return [m11 * cx + m12 * cy + p0[0], m21 * cx + m22 * cy + p0[1]];
                    },
                    toClient: (gx, gy) => {
                        const dx = gx - p0[0], dy = gy - p0[1];
                        return [rect.left + (m22 * dx - m12 * dy) / det,
                            rect.top + (-m21 * dx + m11 * dy) / det];
                    },
                };
            }
        }
    }
    const s = cv.ds?.scale ?? 1, ox = cv.ds?.offset?.[0] ?? 0, oy = cv.ds?.offset?.[1] ?? 0;
    return {
        toGraph: (clientX, clientY) => [(clientX - rect.left) / s - ox, (clientY - rect.top) / s - oy],
        toClient: (gx, gy) => [rect.left + (gx + ox) * s, rect.top + (gy + oy) * s],
    };
}

// 由节点类名判断媒体类型：LoadVideo / LoadAudio / LoadImage；Neo Grid Split 用
// filename combo（image_upload）接收图片，同样作为图片落点。非媒体节点返回 null。
function nodeMediaKind(node) {
    const cls = String(node.comfyClass || node.type || "");
    if (/load.?video/i.test(cls)) return "video";
    if (/load.?audio/i.test(cls)) return "audio";
    if (/load.?image/i.test(cls)) return "image";
    if (/^neogridsplit$/i.test(cls)) return "image";
    return null;
}

// 找到可写入的文件 combo widget。标准 Load 节点只有一个 combo，优先按名称匹配
// （LoadVideo 的 combo 名为 file、Neo Grid Split 为 filename），退化到第一个 combo。
function findMediaWidget(node, kind) {
    const widgets = node.widgets || [];
    const byName = (pat) => widgets.find(w => w.type === "combo" && pat.test(w.name || ""));
    const firstCombo = () => widgets.find(w => w.type === "combo");
    if (kind === "video") return byName(/video|file/i) || firstCombo();
    if (kind === "audio") return byName(/audio/i) || firstCombo();
    return byName(/image|filename/i) || firstCombo();
}

// 命中指针下方、可写入媒体的 Load 节点，返回 { node, widget, kind }，否则 null
function mediaNodeAt(transforms, graph, clientX, clientY) {
    const nodes = graph?._nodes;
    if (!nodes?.length) return null;
    const [gx, gy] = transforms.toGraph(clientX, clientY);
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.mode === 4) continue; // 跳过禁用节点
        if (!node.isPointInside || !node.isPointInside(gx, gy)) continue;
        const kind = nodeMediaKind(node);
        if (!kind) continue;
        const widget = findMediaWidget(node, kind);
        if (widget) return { node, widget, kind };
    }
    return null;
}

// 由文件名扩展名判断媒体类型，非图/视频/音频返回 null
function mediaKindOf(filename) {
    if (isImageFile(filename)) return "image";
    if (isVideoFile(filename)) return "video";
    if (isAudioFile(filename)) return "audio";
    return null;
}

// 读取拖拽载荷，仅图/视频/音频可落到对应 Load 节点；附带推断出的 kind
function readMediaPayload(e) {
    const raw = e.dataTransfer?.getData(NEO_GALLERY_MIME);
    if (!raw) return null;
    try {
        const p = JSON.parse(raw);
        if (p && p.filename) {
            const kind = mediaKindOf(p.filename);
            if (kind) return { ...p, kind };
        }
    } catch { /* 非 Gallery 拖拽 */ }
    return null;
}

let _attached = false;

export function attachGalleryNodeDrop() {
    if (_attached) return;
    _attached = true;

    let highlight = null;
    function showHighlight(transforms, node) {
        if (!highlight) {
            highlight = document.createElement("div");
            highlight.className = "neo-gallery-node-drop-highlight";
            document.body.appendChild(highlight);
        }
        const [px, py] = node.pos || [0, 0];
        const [w, h] = node.size || [0, 0];
        const [lx, ly] = transforms.toClient(px, py);
        const [rx, ry] = transforms.toClient(px + w, py + h);
        highlight.style.left = `${lx}px`;
        highlight.style.top = `${ly}px`;
        highlight.style.width = `${Math.abs(rx - lx)}px`;
        highlight.style.height = `${Math.abs(ry - ly)}px`;
        highlight.style.display = "block";
    }
    function hideHighlight() { if (highlight) highlight.style.display = "none"; }

    // capture 阶段先于 LiteGraph/核心处理，命中媒体 Load 节点时独占该次拖放。
    // 注意：dragover 阶段浏览器不允许读取自定义 MIME 的数据，只能用 types 判断是否 Gallery 拖拽；
    // 具体 filename 在 drop 阶段才可读（readMediaPayload），故高亮对任意媒体 Load 节点生效、
    // 类型匹配在 drop 阶段校验。
    document.addEventListener("dragover", (e) => {
        const cv = app.canvas;
        if (!cv?.canvas || !app.graph) return;
        const dt = e.dataTransfer;
        if (!dt || !dt.types.includes(NEO_GALLERY_MIME)) { hideHighlight(); return; }
        const transforms = makeCanvasTransforms(cv);
        const target = mediaNodeAt(transforms, app.graph, e.clientX, e.clientY);
        if (target) {
            e.preventDefault();
            dt.dropEffect = "copy";
            showHighlight(transforms, target.node);
        } else {
            hideHighlight();
        }
    }, true);

    document.addEventListener("drop", async (e) => {
        const cv = app.canvas;
        if (!cv?.canvas || !app.graph) return;
        const payload = readMediaPayload(e);
        if (!payload) return;
        const target = mediaNodeAt(makeCanvasTransforms(cv), app.graph, e.clientX, e.clientY);
        hideHighlight();
        // 载荷媒体类型须与目标节点匹配，否则静默 no-op（拖拽中读不到文件名，只能落放时校验）
        if (!target || target.kind !== payload.kind) return;
        e.preventDefault();
        e.stopPropagation();
        try {
            await applyImageToTarget(target, payload);
            showToast(app, "success", "已发送", `写入 ${target.node.title || target.node.comfyClass || target.node.type || "节点"} #${target.node.id}`);
        } catch (err) {
            showToast(app, "error", "发送失败", err?.message || String(err));
        }
    }, true);

    document.addEventListener("dragend", hideHighlight, true);
}