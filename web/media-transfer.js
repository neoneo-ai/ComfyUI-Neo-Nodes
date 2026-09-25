/**
 * media-transfer.js — 「素材 → input/ 目录」的共享搬运助手（自 director.js 拆出，ref-grid.js 共用）。
 * - grabDataType：从拖放 dataTransfer 提取 Neo Gallery 素材标识（自定义 MIME，回退 text/plain）
 * - copyGalleryToInput：画廊素材落盘 input/（/neo_gallery/copy_to_input）
 * - uploadLocalFiles：本地文件上传 input/（/upload/image），支持批量
 * - toggleGallerySidebar：开/关左侧 Neo Gallery 侧栏
 */
import { app } from "../../../../scripts/app.js";

/** 从拖放事件的 dataTransfer 提取素材标识（Neo Gallery 自定义 MIME，回退 text/plain）。
 *  兼容传入 DropEvent（取 .dataTransfer）或 dataTransfer 本身。 */
export function grabDataType(dt) {
    const target = (dt && typeof dt.getData === 'function') ? dt : (dt && dt.dataTransfer);
    if (!target || typeof target.getData !== 'function') return '';
    try {
        return target.getData('application/x-neo-gallery') || target.getData('text/plain') || '';
    } catch {
        return '';
    }
}

/** 把画廊素材落地到 input/：raw 为 grabDataType 取回的 JSON（{filename, subfolder}），
 *  返回落盘后的 input 文件名（失败返回 null）。 */
export async function copyGalleryToInput(raw) {
    let payload;
    try { payload = JSON.parse(raw); } catch { return null; }
    if (!payload || !payload.filename) return null;
    try {
        const qs = '/neo_gallery/copy_to_input?filename=' + encodeURIComponent(payload.filename)
            + (payload.subfolder ? '&subfolder=' + encodeURIComponent(payload.subfolder) : '');
        const res = await fetch(qs);
        if (!res.ok) return null;
        const data = await res.json();
        return data && data.success ? data.filename : null;
    } catch (err) {
        console.error('[Neo] copy gallery image to input failed', err);
        return null;
    }
}

/** 打开 ComfyUI 左侧素材面板（Neo Gallery 侧栏 tab）；传入 source/path 时直接导航到对应目录。
 *  无 target 时保持原有开/关切换行为。 */
export function toggleGallerySidebar(source, path) {
    const em = app.extensionManager;
    if (!em || !em.sidebarTab) return;
    if (!source) {
        em.sidebarTab.activeSidebarTabId = em.sidebarTab.activeSidebarTabId === 'neo.gallery' ? null : 'neo.gallery';
        return;
    }
    em.sidebarTab.activeSidebarTabId = 'neo.gallery';
    if (app.neoGallery && typeof app.neoGallery.showDirectoryStructure === 'function') {
        app.neoGallery.showDirectoryStructure(source, path || []);
    }
}

/** 上传本地文件到 ComfyUI input 目录（复用 /upload/image 端点，实际接受任意文件）。
 *  files 为 File 数组或单个 File；按序返回落盘后的文件名（失败项跳过）。 */
export async function uploadLocalFiles(files) {
    const list = Array.isArray(files) ? files : [files];
    const out = [];
    for (const file of list) {
        if (!file) continue;
        try {
            const fd = new FormData();
            fd.append('image', file);
            fd.append('type', 'input');
            const resp = await fetch('/upload/image', { method: 'POST', body: fd });
            if (!resp.ok) continue;
            const data = await resp.json();
            if (data && data.name) out.push(data.name);
        } catch (err) {
            console.error('[Neo] upload local file failed', err);
        }
    }
    return out;
}