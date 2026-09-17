/**
 * director.js — Neo-Nodes 多段视频导演编辑器（配方编辑窗口）。
 * 从 recipes.js 拆出：shared(宽高比/百万像素或自定义 W/H) + 逐段(skill/prompt/首帧/时长)
 * + 半自动故事生成/拆分。数据与保存仍走 recipes.js 的 saveRecipe / listVideoSkills / scanMediaNodes。
 */
import { app } from "../../../../scripts/app.js";
import { $el } from "../../../../scripts/ui.js";
import { DirectorTimeline } from "./director-timeline.js";
import { saveRecipe, listVideoSkills, scanMediaNodes, widgetValueToRef } from "./recipes.js";
import { attachSkillPickerToSelect } from "./skill.js";

// 配方编辑器保存成功后广播：节点内时间轴等监听方据此刷新下拉候选 + 重载 spec。
export const DIRECTOR_RECIPE_SAVED_EVENT = "neo-director-recipe-saved";

/** 从拖放事件的 dataTransfer 提取素材标识（Neo Gallery 自定义 MIME，回退 text/plain）。
 *  兼容传入 DropEvent（取 .dataTransfer）或 dataTransfer 本身。 */
function grabDataType(dt) {
    const target = (dt && typeof dt.getData === 'function') ? dt : (dt && dt.dataTransfer);
    if (!target || typeof target.getData !== 'function') return '';
    try {
        return target.getData('application/x-neo-gallery') || target.getData('text/plain') || '';
    } catch {
        return '';
    }
}

/** 把素材落地到 input/：返回落盘后的 input 文件名（失败返回 null）。 */
async function copyGalleryToInput(raw) {
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
        console.error('[Neo Recipes] Director: copy gallery image failed', err);
        return null;
    }
}

/** 打开/收起 ComfyUI 左侧素材面板（Neo Gallery 侧栏 tab）。 */
function toggleGallerySidebar() {
    const em = app.extensionManager;
    if (!em || !em.sidebarTab) return;
    em.sidebarTab.activeSidebarTabId = em.sidebarTab.activeSidebarTabId === 'neo.gallery' ? null : 'neo.gallery';
}

/** 上传本地文件到 ComfyUI input 目录（复用 /upload/image 端点，实际接受任意文件）。
 *  返回落盘后的文件名（失败返回 null）。 */
async function uploadLocalFile(file) {
    try {
        const fd = new FormData();
        fd.append('image', file);
        fd.append('type', 'input');
        const resp = await fetch('/upload/image', { method: 'POST', body: fd });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data && data.name ? data.name : null;
    } catch (err) {
        console.error('[Neo Recipes] Director: upload local file failed', err);
        return null;
    }
}

/** 创建本地上传用的隐藏 <input type=file>：accept 按素材类型过滤；open() 打开文件选择器，
 *  选择后上传并回调 onUploaded(fname)。返回 { input, open }（input 需挂进 DOM 才能弹出选择器）。 */
function buildLocalFilePicker(accept, onUploaded) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = accept;
    fileInput.style.display = 'none';
    fileInput.onchange = async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const fname = await uploadLocalFile(file);
        fileInput.value = '';  // 允许重复选择同名文件
        if (fname) onUploaded(fname);
    };
    return { input: fileInput, open: () => fileInput.click() };
}

/** 创建「从本地添加」按钮：点击弹出文件选择器，选择后上传并回调 onUploaded(fname)。 */
function buildLocalAddButton(accept, onUploaded) {
    const picker = buildLocalFilePicker(accept, onUploaded);
    const btn = $el('button', {
        className: 'neo-director-local-add',
        title: '从本地添加素材',
        onclick: picker.open,
    }, [
        $el('i', { className: 'pi pi-upload' }),
        $el('span', { textContent: '本地' }),
    ]);
    btn.appendChild(picker.input);
    return btn;
}

// ==========================================
// 多段导演分辨率选择（移植自 ComfyUI_MiniMaxH3_Director 的 ResolutionSelector 算法）：
// 宽高比 + 百万像素 → 宽/高（按 32 对齐）；「自定义」时手输 W/H。
// ==========================================

const DIRECTOR_ASPECTS = [
    ["1:1 (方形)", 1, 1],
    ["2:3 (竖版照片)", 2, 3],
    ["3:2 (横版照片)", 3, 2],
    ["3:4 (竖版标准)", 3, 4],
    ["4:3 (标准)", 4, 3],
    ["9:16 (竖屏)", 9, 16],
    ["16:9 (宽屏)", 16, 9],
    ["21:9 (超宽)", 21, 9],
];
const DIRECTOR_CUSTOM = "自定义";
const DIRECTOR_MULTIPLE = 32;   // MiniMax H3 画布对齐步长
const MP_MIN = 0.1, MP_MAX = 2, MP_DEFAULT = 0.5;   // 百万像素，取一位小数

function directorClampMp(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return MP_DEFAULT;
    return Math.round(Math.min(MP_MAX, Math.max(MP_MIN, n)) * 10) / 10;
}

// aspect + 百万像素 → {width,height}（32 对齐）；「自定义」返回 null
function directorResolution(label, mp) {
    const row = DIRECTOR_ASPECTS.find(([l]) => l === label);
    if (!row) return null;
    const [, rw, rh] = row;
    const total = directorClampMp(mp) * 1024 * 1024;
    const scale = Math.sqrt(total / (rw * rh));
    return {
        width: Math.round((rw * scale) / DIRECTOR_MULTIPLE) * DIRECTOR_MULTIPLE,
        height: Math.round((rh * scale) / DIRECTOR_MULTIPLE) * DIRECTOR_MULTIPLE,
    };
}

// 编辑旧配方（只存了 W/H）时：比例命中预设（±2%）则反推 aspect + 百万像素，否则按自定义处理
function directorInferAspect(w, h) {
    const row = DIRECTOR_ASPECTS.find(([, rw, rh]) => Math.abs(w / h - rw / rh) / (rw / rh) < 0.02);
    if (!row) return { label: DIRECTOR_CUSTOM, mp: MP_DEFAULT };
    return { label: row[0], mp: directorClampMp((w * h) / (1024 * 1024)) };
}

// 当前打开的导演编辑器 { name, close, requestClose, isDirty, overlay }：name=配方名（新建模式为 ''）。
// close=无条件关闭（保存成功/放弃修改后），requestClose=用户主动关闭（有未保存修改先出确认条）。
// 单例且支持「已打开时点击另一配方 → 重新加载为该配方」；overlay 仍在 DOM 才视为真正打开。
let _directorEditor = null;
function currentDirectorEditor() {
    if (_directorEditor && _directorEditor.overlay && _directorEditor.overlay.parentNode) return _directorEditor;
    _directorEditor = null; // 浮层已不在（外部清除 / 测试重置 body）→ 丢弃过期状态
    return null;
}

/** 打开多段视频导演编辑器：shared(宽高比/百万像素或自定义 W/H) + 逐段(skill/prompt/首帧/时长)。
 *  existing 为既有 director 配方 meta（编辑时预填），null = 新建；onSaved 保存成功后回调刷新。
 *  首帧候选取全图已连线的 LoadImage（以原始文件名引用，后端落盘后回写）。保存走 saveRecipe(director=...)。
 *  单例：已打开同一配方 → 忽略重复点击（但按 focusSeg 切换当前段）；已打开另一配方 → 关闭旧窗口并重新加载为该配方。
 *  focusSeg：打开时定位到该段（0 基；<0 表示不指定，保持默认第 1 段）。 */
export async function openDirectorEditor(existing = null, onSaved = null, focusSeg = -1) {
    const requestedName = (existing && existing.name) || '';
    const cur = currentDirectorEditor();
    if (cur) {
        if (cur.name === requestedName) { cur.focusSeg?.(focusSeg); return; } // 同一配方重复点击 → 只切换当前段
        if (cur.isDirty()) { cur.requestClose(); return; }   // 有未保存修改：先出确认条，本次不重载；用户选择后再点
        cur.close();                            // 另一配方 → 关闭旧窗口，重载为该配方
    } else if (document.querySelector('.neo-director-overlay')) {
        return; // 兜底：状态缺失但浮层仍在 → 忽略，避免叠加
    }
    // 已连线媒体候选（LoadImage / LoadVideo / LoadAudio）：图给首帧与参考图网格，视频/音频给各自参考网格
    const imageRefs = [], videoRefs = [], audioRefs = [];
    try {
        const { media } = await scanMediaNodes();
        for (const [kind, bucket] of [['image', imageRefs], ['video', videoRefs], ['audio', audioRefs]]) {
            for (const s of media) {
                if (s.kind !== kind || s.slot == null) continue;
                const ref = widgetValueToRef(s.value);
                if (ref) bucket.push(Object.assign(ref, { kind }));
            }
        }
    } catch (e) { console.error('[Neo Recipes] Director: collect media failed', e); }

    let skills = [];
    try { skills = await listVideoSkills(); } catch (e) {}

    const exShared = (existing && existing.shared) || {};
    const exSegs = (existing && Array.isArray(existing.segments)) ? existing.segments : [];
    const exStory = (existing && existing.story) || {};   // 自动故事板内容（主题/脚本/参考图/粒度），编辑旧配方时回显
    const exSetup = (existing && existing.setup) || {};   // 统一设置区状态（统一参考/首帧/尾帧 + 优化前后提示词对照），编辑旧配方时回显
    let origPrompts = Array.isArray(exSetup.orig_prompts) ? exSetup.orig_prompts : null;  // 首次优化前的各段原文快照，随 setup 落盘、重开回显
    let optPrompts = Array.isArray(exSetup.opt_prompts) ? exSetup.opt_prompts : null;    // 最近一次优化结果，随 setup 落盘、重开回显
    let segCounter = 0; // 段身份计数：时间轴颜色按段内容绑定，重排不变色
    let modeSel = null;   // 全局生成模式（文生/图生/混合），在时间线面板中创建后赋值

    // 未保存修改标记：任何会改变落盘内容的操作置位；成功保存 / 关闭后清零。
    let dirty = false;
    const markDirty = () => { dirty = true; };

    // 每段参考素材：三组多选网格，上限与 H3 参考节点（MiniMaxH3ReferenceToVideo）槽位一致
    const SEG_REF_GROUPS = [
        { key: 'images', kind: 'image', label: '参考图', max: 9 },
        { key: 'videos', kind: 'video', label: '参考视频', max: 3 },
        { key: 'audios', kind: 'audio', label: '参考音频', max: 3 },
    ];
    // 生成模式（与 ComfyUI_MiniMaxH3_Director 的任务模式对齐；mixed 仅全局可选）
    const SEG_MODES = [
        ['t2v', '文生视频'],
        ['i2v', '图生视频'],
        ['fl2v', '首尾帧生视频'],
        ['r2v', '全参考生视频'],
        ['v2v', '视频编辑'],
        ['rv2v', '视频+参考图编辑'],
    ];
    const SEG_MODE_KEYS = new Set(SEG_MODES.map(([k]) => k));
    const MODE_LABELS = new Map([...SEG_MODES, ['mixed', '混合模式']]);
    const segRefReaders = new Map();    // 段行 → [读取该段三组参考的函数]（保存时按当前 DOM 顺序取）
    const segRefSetters = new Map();    // 段行 → [设置该段三组参考的函数]（「同步到所有分段」用）
    const segFrameReaders = new Map();  // 段行 → {first, last} 读取该段首/尾帧的函数
    const segFrameSetters = new Map();  // 段行 → {first, last} 设置该段首/尾帧的函数（统一设置自动应用用）
    const segSvReaders = new Map();     // 段行 → 读取该段源视频（v2v/rv2v）的函数
    const segSvSetters = new Map();     // 段行 → 设置该段源视频的函数

    /** 一组参考素材的「已用列表」：只显示当前挂上的素材，拖入/本地上传直接插入；
     *  瓷砖可鼠标拖放调整顺序、✕ 移除。顺序即保存与时间轴展示顺序，数量受 group.max 上限约束。 */
    function buildSegRefRow(group, initialNames, headExtra, onChange) {
        const list = [];   // 已用素材文件名（有序）：顺序即该段参考素材的先后
        const grid = $el('div', { className: 'neo-director-refpick-grid' });
        const count = $el('span', { className: 'neo-director-refpick-count' });
        const REF_THUMB_H = 96;   // 瓷砖固定高度（与首帧缩略图 .neo-director-ff-thumb 一致）；宽度按画面比例自适应、紧密平铺不留空白
        const sizeTile = (tile, w, h) => { if (w && h) tile.style.width = Math.max(36, REF_THUMB_H * (w / h)) + 'px'; };
        const warn = (detail) => app.extensionManager.toast.add({ severity: 'warning', summary: '多段导演', detail, life: 4000 });
        let dragIdx = null;   // 正在拖放的瓷砖序号（内部重排用，区别于外部素材拖入）
        // 每次改动都整体重建瓷砖（列表 ≤9，开销可忽略），保证顺序始终对应当前排列
        const render = () => {
            grid.innerHTML = '';
            list.forEach((name, i) => {
                const url = `/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;
                let media;
                if (group.kind === 'image') media = $el('img', { className: 'neo-director-refpick-thumb', src: url, alt: name, loading: 'lazy', draggable: false });
                else if (group.kind === 'video') media = $el('video', { className: 'neo-director-refpick-thumb', src: url, muted: true, preload: 'metadata' });
                else media = $el('div', { className: 'neo-director-refpick-thumb neo-director-refpick-thumb-audio', textContent: '🎵' });
                const delBtn = $el('button', { className: 'neo-director-refpick-del', title: '移除该素材', textContent: '✕' });
                const tile = $el('div', { className: 'neo-director-refpick-item', title: name, draggable: true, dataset: { file: name } }, [media, delBtn]);
                // 加载后按画面比例设置瓷砖宽度（图 naturalWidth/Height、视频 videoWidth/Height）
                if (group.kind === 'image') media.addEventListener('load', () => sizeTile(tile, media.naturalWidth, media.naturalHeight));
                else if (group.kind === 'video') media.addEventListener('loadedmetadata', () => sizeTile(tile, media.videoWidth, media.videoHeight));
                delBtn.onclick = (e) => { e.stopPropagation(); list.splice(i, 1); render(); markDirty(); if (onChange) onChange(); };
                tile.addEventListener('dragstart', (e) => {
                    dragIdx = i;
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', name); } catch (_) {}
                    tile.classList.add('neo-director-refpick-dragging');
                });
                tile.addEventListener('dragend', () => {
                    dragIdx = null;
                    tile.classList.remove('neo-director-refpick-dragging');
                });
                grid.appendChild(tile);
            });
            grid.classList.toggle('has-items', list.length > 0);   // 有素材时去掉空态虚线框、瓷砖顶格紧密平铺
            count.textContent = `${list.length}/${group.max}`;
        };
        // 插入新素材（拖入/本地上传）：去重 + 上限校验，达上限则提示并拒绝
        const insert = (name) => {
            if (!name || list.includes(name)) return;
            if (list.length >= group.max) { warn(`${group.label}最多 ${group.max} 个`); return; }
            list.push(name);
            render();
            markDirty();
            if (onChange) onChange();
        };
        // 整体替换本组素材（「同步到所有分段」用）：去重 + 上限约束后重建
        const set = (names) => {
            list.length = 0;
            for (const n of (Array.isArray(names) ? names : [])) {
                if (n && !list.includes(n) && list.length < group.max) list.push(n);
            }
            render();
            markDirty();
        };
        for (const name of (Array.isArray(initialNames) ? initialNames : [])) {
            if (name && !list.includes(name)) list.push(name);   // 编辑旧配方回显（已存数据本就合规）
        }
        render();
        // 拖放重排：把被拖瓷砖移到指针所在瓷砖的前/后（按水平中线判断插入位）
        const reorderFromDrop = (e) => {
            const from = dragIdx;
            dragIdx = null;
            if (from == null || from >= list.length) return;
            const tiles = Array.from(grid.querySelectorAll('.neo-director-refpick-item'));
            let insertAt = tiles.length;
            for (let k = 0; k < tiles.length; k++) {
                const r = tiles[k].getBoundingClientRect();
                if (e.clientX < r.left + r.width / 2) { insertAt = k; break; }
            }
            let at = from < insertAt ? insertAt - 1 : insertAt;
            const item = list.splice(from, 1)[0];
            at = Math.max(0, Math.min(list.length, at));
            list.splice(at, 0, item);
            render();
            markDirty();
            if (onChange) onChange();
        };
        grid.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (dragIdx != null) { e.dataTransfer.dropEffect = 'move'; return; }   // 内部重排：不亮「新素材」高亮
            e.dataTransfer.dropEffect = 'copy';
            grid.classList.add('neo-director-drop');
        });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault(); grid.classList.remove('neo-director-drop');
            if (dragIdx != null) { reorderFromDrop(e); return; }   // 内部瓷砖拖放 = 重排
            const fname = await copyGalleryToInput(grabDataType(e));
            if (fname) insert(fname);
        });
        const acceptMap = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
        // 本地上传：去掉「本地」按钮，改为点击网格黑色空区弹出文件选择器（隐藏 input 挂在行上，避免被 render() 清空）
        const picker = buildLocalFilePicker(acceptMap[group.kind] || '*/*', (fname) => insert(fname));
        grid.addEventListener('click', (e) => {
            if (e.target.closest('.neo-director-refpick-item')) return;   // 点瓷砖（移除/拖拽）不触发上传
            picker.open();
        });
        const row = $el('div', { className: 'neo-director-segref-row' }, [
            $el('div', { className: 'neo-director-segref-head' }, [
                $el('span', { className: 'neo-director-field-label', textContent: `${group.label}（最多 ${group.max}）` }),
                ...(headExtra ? [headExtra] : []),
                count,
            ]),
            grid,
        ]);
        row.appendChild(picker.input);
        return { row, getSelected: () => list.slice(), set };
    }

    /** 单帧候选网格（首帧/尾帧共用）：「无」项 + 已连线 LoadImage 缩略图，单选。
     *  prefix 为类名前缀（首帧 `neo-director-ff` / 尾帧 `neo-director-lf`）；
     *  编辑旧配方时若已存文件名不在当前画布素材里，补占位项以免保存时被丢弃。 */
    function buildFrameGrid(prefix, initialName, emptyText, onChange) {
        const grid = $el('div', { className: `${prefix}-grid` });
        const candidates = imageRefs.slice();
        if (initialName && !candidates.some(r => r.filename === initialName)) {
            candidates.unshift({ filename: initialName, subfolder: '', type: 'input' });
        }
        const thumbUrl = (ref) => `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder || '')}&type=${ref.type || 'input'}`;
        const noneTile = $el('div', { className: `${prefix}-item`, title: emptyText }, [
            $el('div', { className: `${prefix}-thumb ${prefix}-thumb-empty`, textContent: '🎬' }),
            $el('div', { className: `${prefix}-name`, textContent: emptyText }),
        ]);
        grid.appendChild(noneTile);
        const select = (value) => {
            for (const it of Array.from(grid.children)) {
                it.classList.toggle(`${prefix}-active`, (it === noneTile) ? value === '' : it.dataset.file === value);
            }
        };
        // 移除素材格（✕）：从网格删除；若为当前选中项则回落到「无」；
        // 该文件不再被任何段引用时，同时从 imageRefs（保存资产）中清理
        const removeTile = (tile) => {
            const fname = tile.dataset.file;
            const wasActive = tile.classList.contains(`${prefix}-active`);
            tile.remove();
            markDirty();
            if (wasActive) { select(''); if (onChange) onChange(''); }
            if (!fname) return;
            const stillUsed = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))
                .some(row => Array.from(row.querySelectorAll(`.${prefix}-item`)).some(it => it.dataset.file === fname));
            if (!stillUsed) {
                const idx = imageRefs.findIndex(r => r.filename === fname);
                if (idx >= 0) imageRefs.splice(idx, 1);
            }
        };
        const makeTile = (ref) => {
            const delBtn = $el('button', { className: `${prefix}-del`, title: '移除该素材', textContent: '✕' });
            const tile = $el('div', { className: `${prefix}-item`, title: ref.filename, dataset: { file: ref.filename } }, [
                $el('img', { className: `${prefix}-thumb`, src: thumbUrl(ref), alt: ref.filename, loading: 'lazy' }),
                $el('div', { className: `${prefix}-name`, textContent: ref.filename }),
                delBtn,
            ]);
            delBtn.onclick = (e) => { e.stopPropagation(); removeTile(tile); };
            // 点选切换：已选中再点一次即取消（回落到「无」）
            tile.onclick = () => { const v = tile.classList.contains(`${prefix}-active`) ? '' : ref.filename; select(v); markDirty(); if (onChange) onChange(v); };
            return tile;
        };
        // 把素材加入候选并选中（网格拖放 / 时间轴拖放 / 画布素材共用）
        const addCandidate = (fname) => {
            if (!imageRefs.some(r => r.filename === fname)) {
                imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
            }
            let tile = Array.from(grid.children).find(it => it.dataset.file === fname);
            if (!tile) {
                tile = makeTile({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
                grid.appendChild(tile);
            }
            select(fname);
            markDirty();
            if (onChange) onChange(fname);
        };
        for (const r of candidates) grid.appendChild(makeTile(r));
        select(initialName || '');
        grid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; grid.classList.add('neo-director-drop'); });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault();
            grid.classList.remove('neo-director-drop');
            const fname = await copyGalleryToInput(grabDataType(e));
            if (fname) addCandidate(fname);
        });
        return {
            grid, addCandidate,
            getSelected: () => {
                const active = Array.from(grid.children).find(it => it.classList.contains(`${prefix}-active`));
                return (active && active.dataset.file) ? active.dataset.file : '';
            },
            setSelected: (value) => { select(value); markDirty(); },   // 程序化改选中（统一设置取消选择时清空各段用）
        };
    }

    /** 视频选择网格（v2v/rv2v 源视频用）：与 buildFrameGrid 类似但使用 videoRefs 候选、显示视频缩略图 */
    function buildVideoGrid(prefix, initialName, emptyText, onChange) {
        const grid = $el('div', { className: `${prefix}-grid` });
        const candidates = videoRefs.slice();
        if (initialName && !candidates.some(r => r.filename === initialName)) {
            candidates.unshift({ filename: initialName, subfolder: '', type: 'input' });
        }
        const thumbUrl = (ref) => `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder || '')}&type=${ref.type || 'input'}`;
        const noneTile = $el('div', { className: `${prefix}-item`, title: emptyText }, [
            $el('div', { className: `${prefix}-thumb ${prefix}-thumb-empty`, textContent: '🎬' }),
            $el('div', { className: `${prefix}-name`, textContent: emptyText }),
        ]);
        grid.appendChild(noneTile);
        const select = (value) => {
            for (const it of Array.from(grid.children)) {
                it.classList.toggle(`${prefix}-active`, (it === noneTile) ? value === '' : it.dataset.file === value);
            }
        };
        const removeTile = (tile) => {
            const fname = tile.dataset.file;
            const wasActive = tile.classList.contains(`${prefix}-active`);
            tile.remove();
            markDirty();
            if (wasActive) { select(''); if (onChange) onChange(''); }
            if (!fname) return;
            const stillUsed = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))
                .some(row => Array.from(row.querySelectorAll(`.${prefix}-item`)).some(it => it.dataset.file === fname));
            if (!stillUsed) {
                const idx = videoRefs.findIndex(r => r.filename === fname);
                if (idx >= 0) videoRefs.splice(idx, 1);
            }
        };
        const makeTile = (ref) => {
            const delBtn = $el('button', { className: `${prefix}-del`, title: '移除该素材', textContent: '✕' });
            const tile = $el('div', { className: `${prefix}-item`, title: ref.filename, dataset: { file: ref.filename } }, [
                $el('video', { className: `${prefix}-thumb`, src: thumbUrl(ref), muted: true, preload: 'metadata' }),
                $el('div', { className: `${prefix}-name`, textContent: ref.filename }),
                delBtn,
            ]);
            delBtn.onclick = (e) => { e.stopPropagation(); removeTile(tile); };
            tile.onclick = () => { const v = tile.classList.contains(`${prefix}-active`) ? '' : ref.filename; select(v); markDirty(); if (onChange) onChange(v); };
            return tile;
        };
        const addCandidate = (fname) => {
            if (!videoRefs.some(r => r.filename === fname)) {
                videoRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'video' });
            }
            let tile = Array.from(grid.children).find(it => it.dataset.file === fname);
            if (!tile) {
                tile = makeTile({ filename: fname, subfolder: '', type: 'input', kind: 'video' });
                grid.appendChild(tile);
            }
            select(fname);
            markDirty();
            if (onChange) onChange(fname);
        };
        for (const r of candidates) grid.appendChild(makeTile(r));
        select(initialName || '');
        grid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; grid.classList.add('neo-director-drop'); });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault();
            grid.classList.remove('neo-director-drop');
            const fname = await copyGalleryToInput(grabDataType(e));
            if (fname) addCandidate(fname);
        });
        return {
            grid, addCandidate,
            getSelected: () => {
                const active = Array.from(grid.children).find(it => it.classList.contains(`${prefix}-active`));
                return (active && active.dataset.file) ? active.dataset.file : '';
            },
            setSelected: (value) => { select(value); markDirty(); },
        };
    }

    /** 「素材库」按钮：打开/收起 ComfyUI 左侧 Neo Gallery 面板（首帧行 / 参考区共用）。 */
    const buildAssetLibButton = () => $el('button', {
        className: 'neo-director-ff-lib',
        title: '打开/收起左侧素材面板',
        onclick: () => toggleGallerySidebar(),
    }, [
        $el('i', { className: 'pi pi-images' }),
        $el('span', { textContent: '素材库' }),
    ]);

    /** 单帧区的标题行（字段名 + 「本地」+ 「素材库」按钮）。onLocalAdd(fname) 在本地上传成功后回调。 */
    const frameRow = (labelText, onLocalAdd) => $el('div', { className: 'neo-director-ff-row' }, [
        $el('label', { className: 'neo-director-field-label', textContent: labelText }),
        buildLocalAddButton('image/*', onLocalAdd),
        buildAssetLibButton(),
    ]);

    function buildSeg(seg = {}) {
        const skillSel = $el('select', { className: 'neo-director-skill' });
        if (!skills.length) skillSel.appendChild($el('option', { value: '', textContent: '（无可用视频技能）' }));
        for (const s of skills) {
            const opt = $el('option', { value: s.id, textContent: s.name || s.id });
            opt.dataset.source = s.source || 'custom'; // 行内查看/编辑按钮按 source 区分（预设只读）
            skillSel.appendChild(opt);
        }
        if (seg.skill_id) skillSel.value = seg.skill_id;
        // 点击弹居中搜索窗（替代原生下拉）；refreshSegSkillOptions 重建 options 后监听仍在 select 上生效
        attachSkillPickerToSelect(skillSel);

        const promptTa = $el('textarea', { className: 'neo-director-prompt', placeholder: '该段画面 / 运动描述（必填）', value: seg.prompt || '' });
        const durInp = $el('input', { className: 'neo-director-dur', type: 'number', min: 1, max: 3600, value: (seg.duration_sec != null ? seg.duration_sec : 5) });

        // 首帧 / 尾帧候选网格：「无」+ 已连线 LoadImage 缩略图，单选（首帧驱动 I2V 与连续性，尾帧锁 FL2V 收尾）
        const ffGrid = buildFrameGrid('neo-director-ff', seg.first_frame, '无（文生视频）');
        const lfGrid = buildFrameGrid('neo-director-lf', seg.last_frame, '无（不锁尾帧）');
        
        // 源视频选择（v2v/rv2v 用）：单文件选择，显示视频缩略图
        const svGrid = buildVideoGrid('neo-director-sv', seg.source_video, '无（源视频）');

        // 本段模式（仅全局“混合模式”下显示）：文生 / 图生 / 首尾帧 / 全参考
        const segModeSel = $el('select', { className: 'neo-director-segmode' });
        for (const [val, label] of SEG_MODES) segModeSel.appendChild($el('option', { value: val, textContent: label }));
        segModeSel.value = SEG_MODE_KEYS.has(seg.mode) ? seg.mode : 't2v';

        const removeBtn = $el('button', { className: 'neo-director-seg-del', title: '删除该段', textContent: '🗑' });
        // 首帧区 / 尾帧区（标题行 + 候选网格）各包一层，按有效模式显隐
        const ffBlock = $el('div', { className: 'neo-director-ff-block' }, [
            frameRow('首帧图（点选或从左侧素材栏拖入）', (fname) => ffGrid.addCandidate(fname)), ffGrid.grid,
        ]);
        const lfBlock = $el('div', { className: 'neo-director-lf-block' }, [
            frameRow('尾帧图（首尾帧模式：锁住该段收尾画面）', (fname) => lfGrid.addCandidate(fname)), lfGrid.grid,
        ]);
        // 源视频区（v2v/rv2v 显示）：标题行 + 单选网格
        const svBlock = $el('div', { className: 'neo-director-sv-block' }, [
            $el('div', { className: 'neo-director-ff-row' }, [
                $el('label', { className: 'neo-director-field-label', textContent: '源视频（视频编辑：提示词用 <Video 1> 指代）' }),
                buildLocalAddButton('video/*', (fname) => svGrid.addCandidate(fname)),
                buildAssetLibButton(),
            ]),
            svGrid.grid,
        ]);
        // 首帧区 + 尾帧区包一层容器：fl2v（两块都显示）时并排同一行，其余模式仅显示其一、纵向占满
        const ffLfWrap = $el('div', { className: 'neo-director-fflf' }, [ffBlock, lfBlock]);
        const segModeRow = $el('div', { className: 'neo-director-segmode-row' }, [
            $el('label', { className: 'neo-director-field-label', textContent: '本段模式' }), segModeSel,
        ]);

        // 「同步到所有分段」：把本段三组参考素材（图/视频/音频）一键覆盖式复制到其余各段
        let selfRowRef = null;   // 本段行引用（row 创建后赋值），供同步按钮定位同步源
        const syncBtn = $el('button', { className: 'neo-director-segref-sync', title: '把本段参考素材同步到所有分段' }, [
            $el('i', { className: 'pi pi-copy' }),
            $el('span', { textContent: '同步到所有分段' }),
        ]);
        syncBtn.onclick = () => {
            const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
            if (rows.length < 2) { app.extensionManager.toast.add({ severity: 'info', summary: '多段导演', detail: '只有一个分段，无需同步', life: 3000 }); return; }
            const src = (segRefReaders.get(selfRowRef) || []).map(r => r());   // [图, 视频, 音频]
            if (!src.some(a => a.length)) { app.extensionManager.toast.add({ severity: 'warning', summary: '多段导演', detail: '本段没有可同步的参考素材', life: 3000 }); return; }
            for (const other of rows) {
                const setters = segRefSetters.get(other) || [];
                setters.forEach((set, gi) => set && set(src[gi]));
            }
            app.extensionManager.toast.add({ severity: 'success', summary: '多段导演', detail: `已把本段参考素材同步到全部 ${rows.length} 个分段`, life: 3000 });
        };
        const segRefRows = SEG_REF_GROUPS.map((g) => buildSegRefRow(g, (seg.refs || {})[g.key]));
        const refsBlock = $el('div', { className: 'neo-director-refs-block' }, [
            $el('div', { className: 'neo-director-refs-head' }, [
                $el('span', { className: 'neo-director-field-label', textContent: '参考素材（参考生视频技能用：图 / 视频 / 音频）' }),
                syncBtn,
                buildAssetLibButton(),
            ]),
            segRefRows[0].row,  // 参考图独占一行（最多 9 个，需要更多空间）
            $el('div', { className: 'neo-director-ref-row-pair' }, [
                segRefRows[1].row,  // 参考视频
                segRefRows[2].row,  // 参考音频
            ]),
        ]);

        const row = $el('div', { className: 'neo-director-seg', dataset: { segId: 'seg-' + (++segCounter) } }, [
            $el('div', { className: 'neo-director-seg-head' }, [
                $el('span', { className: 'neo-director-seg-title', textContent: '段' }),
                segModeRow,   // 本段模式（仅混合模式显示）：紧跟段标题、位于技能之前，同一行
                $el('label', { className: 'neo-director-field-label', textContent: '技能（决定模板与模型）' }), skillSel,
                $el('label', { className: 'neo-director-field-label', textContent: '时长（秒）' }), durInp,
                removeBtn,
            ]),
            $el('label', { className: 'neo-director-field-label', textContent: '提示词（必填）' }), promptTa,
            ffLfWrap,
            svBlock,
            refsBlock,
        ]);

        // 本段模式切换 → 刷新该段首帧/尾帧/参考素材区显隐
        segModeSel.addEventListener('change', () => applyGlobalMode());
        row._addCandidate = ffGrid.addCandidate; // 时间轴拖放到该段 → 作为首帧（与首帧网格共用候选）
        row._lfAddCandidate = lfGrid.addCandidate; // 统一设置「应用到所有分段」写入尾帧用
        segFrameReaders.set(row, { first: ffGrid.getSelected, last: lfGrid.getSelected });
        segFrameSetters.set(row, { first: ffGrid.setSelected, last: lfGrid.setSelected });
        segSvReaders.set(row, svGrid.getSelected);
        segSvSetters.set(row, svGrid.setSelected);
        segRefReaders.set(row, segRefRows.map(r => r.getSelected));
        segRefSetters.set(row, segRefRows.map(r => r.set));
        selfRowRef = row;   // 同步按钮据此定位本段（作为同步源）
        removeBtn.onclick = () => {
            const idx = Array.from(segsWrap.querySelectorAll('.neo-director-seg')).indexOf(row);
            const wasCurrent = currentSegId === row.dataset.segId;
            row.remove();
            renumberSegs();
            markDirty();
            if (wasCurrent) showSeg(Math.max(0, idx - 1));
        };
        return row;
    }

    const segsWrap = $el('div', { className: 'neo-director-segs' });
    let timeline = null;
    let currentSegId = null; // 当前编辑段身份（dataset.segId，重排/删除后仍可追踪）
    let currentSegIdx = 0;   // 当前编辑段序号（首帧数据就绪后据此把该块滚入可视区）
    function renumberSegs() {
        segsWrap.querySelectorAll('.neo-director-seg').forEach((row, i) => {
            row.querySelector('.neo-director-seg-title').textContent = `段 ${i + 1}`;
        });
    }
    // 只显示当前段（其余段保留 DOM，readSegData/保存仍读取全部数据）；时间轴同步把该块滚进可视区
    function showSeg(i) {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) return;
        i = Math.max(0, Math.min(i, rows.length - 1));
        currentSegId = rows[i].dataset.segId;
        currentSegIdx = i;
        rows.forEach((row, k) => row.classList.toggle('neo-director-seg-current', k === i));
        if (timeline) timeline.revealSeg(i);
    }
    function showSegById(id) {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const i = rows.findIndex(r => r.dataset.segId === id);
        if (i < 0) showSeg(0); else showSeg(i);
    }
    for (const s of (exSegs.length ? exSegs : [{}])) segsWrap.appendChild(buildSeg(s));
    renumberSegs();

    // 按有效模式刷新各段：混合模式下显示“本段模式”下拉并逐段生效；
    // 首帧区（i2v/fl2v）、尾帧区（fl2v）、参考素材区（i2v/r2v）分别显隐。
    // 按该段有效模式过滤视频技能（skill.mode 由后端 frontmatter 提供）；无匹配时回退全量，避免空下拉。
    function refreshSegSkillOptions(skillSel, eff) {
        if (!skillSel) return;
        const prev = skillSel.value;
        // v2v/rv2v 复用 r2v 技能模板（H3 视频编辑走参考视频路径），按 r2v 过滤技能列表
        let pool = skills.filter(s => s.mode === (eff === 'v2v' || eff === 'rv2v' ? 'r2v' : eff));
        if (!pool.length) pool = skills;
        skillSel.innerHTML = '';
        if (!pool.length) {
            skillSel.appendChild($el('option', { value: '', textContent: '（无可用视频技能）' }));
            return;
        }
        for (const s of pool) {
            const opt = $el('option', { value: s.id, textContent: s.name || s.id });
            opt.dataset.source = s.source || 'custom';
            skillSel.appendChild(opt);
        }
        if ([...skillSel.options].some(o => o.value === prev)) skillSel.value = prev;
    }

    function applyGlobalMode() {
        if (!modeSel) return;
        const g = modeSel.value;   // 't2v' | 'i2v' | 'fl2v' | 'r2v' | 'mixed'
        for (const row of segsWrap.querySelectorAll('.neo-director-seg')) {
            const segModeSel = row.querySelector('.neo-director-segmode');
            const ffBlock = row.querySelector('.neo-director-ff-block');
            const lfBlock = row.querySelector('.neo-director-lf-block');
            const modeRow = row.querySelector('.neo-director-segmode-row');
            const ffLfWrap = row.querySelector('.neo-director-fflf');
            const svBlock = row.querySelector('.neo-director-sv-block');
            if (g === 'mixed' && segModeSel) {
                // 首次进入混合：按该段已有的首/尾帧或参考素材初始化本段模式
                if (!row.dataset.modeInit) {
                    const readers = segFrameReaders.get(row) || {};
                    const hasRef = (segRefReaders.get(row) || []).some(read => read().length);
                    const hasLast = !!(readers.last && readers.last());
                    const hasFirst = !!(readers.first && readers.first());
                    const hasSv = !!(segSvReaders.get(row) && segSvReaders.get(row)());
                    if (hasFirst && hasLast) segModeSel.value = 'fl2v';
                    else if (hasFirst) segModeSel.value = 'i2v';
                    else if (hasSv) segModeSel.value = 'v2v';
                    else if (hasRef) segModeSel.value = 'r2v';
                    row.dataset.modeInit = '1';
                }
            }
            const eff = (g === 'mixed' && segModeSel) ? segModeSel.value : g;
            refreshSegSkillOptions(row.querySelector('.neo-director-skill'), eff);
            if (modeRow) modeRow.style.display = (g === 'mixed') ? '' : 'none';
            if (ffBlock) ffBlock.style.display = (eff === 'i2v' || eff === 'fl2v') ? '' : 'none';
            if (lfBlock) lfBlock.style.display = (eff === 'fl2v') ? '' : 'none';
            if (ffLfWrap) ffLfWrap.classList.toggle('neo-director-fflf-row', eff === 'fl2v');
            const refsBlock = row.querySelector('.neo-director-refs-block');
            if (refsBlock) refsBlock.style.display = (eff === 'r2v' || eff === 'rv2v') ? '' : 'none';
            if (svBlock) svBlock.style.display = (eff === 'v2v' || eff === 'rv2v') ? '' : 'none';
        }
    }
    // 定位到指定段（节点时间轴上被点击的那一段）；未指定时仍默认显示第 1 段
    const focusSegAt = (i) => { const n = Number(i); if (Number.isFinite(n) && n >= 0) showSeg(n); };
    focusSegAt(focusSeg >= 0 ? focusSeg : 0);
    // 新增一段：追加后立即按当前全局模式初始化首帧区 / 本段模式显隐
    const appendNewSeg = () => {
        segsWrap.appendChild(buildSeg({}));
        renumberSegs();
        showSeg(segsWrap.children.length - 1);
        applyGlobalMode();
        markDirty();
    };
    const addBtn = $el('button', { className: 'rs-btn neo-director-add', textContent: '＋ 添加段', onclick: appendNewSeg });

    // 时间轴组件（复用 web/director-timeline.js）：按时长比例绘制分段块 + 秒尺，点击定位、拖拽重排。
    const tlWrap = $el('div', { className: 'neo-director-timeline' });
    const readSegData = () => Array.from(segsWrap.querySelectorAll('.neo-director-seg')).map(row => {
        const durInp = row.querySelector('.neo-director-dur');
        const promptTa = row.querySelector('.neo-director-prompt');
        const activeFf = row.querySelector('.neo-director-ff-item.neo-director-ff-active');
        let thumbUrl = null;
        if (activeFf && activeFf.dataset.file) {
            const imgEl = activeFf.querySelector('img.neo-director-ff-thumb');
            thumbUrl = imgEl ? imgEl.getAttribute('src') : null;
        }
        // 参考素材（r2v）：三组计数 + 全部参考图缩略（按顺序），供时间轴块平铺展示（增删改经 observer 自动刷新）
        const reads = segRefReaders.get(row) || [];
        const mat = { images: 0, videos: 0, audios: 0 };
        const matThumbs = [];
        reads.forEach((read, gi) => {
            const names = read ? read() : [];
            mat[SEG_REF_GROUPS[gi].key] = names.length;
            if (SEG_REF_GROUPS[gi].key === 'images') {
                for (const n of names) matThumbs.push(`/view?filename=${encodeURIComponent(n)}&subfolder=&type=input`);
            }
        });
        return { duration: Number(durInp.value) || 0, prompt: (promptTa.value || '').trim(), thumbUrl, mat, matThumbs };
    });
    const onSelectSeg = (i) => {
        const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
        if (!row) return;
        showSeg(i);
        const p = row.querySelector('.neo-director-prompt');
        if (p) p.focus();
    };
    const onReorderSegs = (order) => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        for (const idx of order) { const el = rows[idx]; if (el) segsWrap.appendChild(el); }
        renumberSegs();
        markDirty();
    };
    // 拖块右缘调时长：写回该段时长输入框（组件内已吸附 0.5s、最小 1s）
    const onResizeSeg = (i, durSec) => {
        const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
        if (!row) return;
        const inp = row.querySelector('.neo-director-dur');
        if (inp) { inp.value = String(Math.min(3600, Math.max(1, Number(durSec) || 1))); markDirty(); }
    };
    try {
        timeline = new DirectorTimeline(tlWrap, {
            height: 184,
            getSegments: readSegData,
            onSelect: onSelectSeg,
            onReorder: onReorderSegs,
            onResize: onResizeSeg,
            // 时间轴尾部「＋」：直接追加新段（等价于下方「＋ 添加段」按钮）
            onAdd: appendNewSeg,
            // 素材库图片直接拖到某段的时间轴块：落地到 input/ 加入该段候选并选中该段
            onDropImage: async (i, dt) => {
                const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
                if (!row || typeof row._addCandidate !== 'function') return;
                const fname = await copyGalleryToInput(grabDataType(dt));
                if (!fname) return;
                showSeg(i); // 先切到该段（保证其候选网格可见），再落素材选中
                row._addCandidate(fname);
            },
        });
    } catch (e) { console.error('[Neo Recipes] Director: timeline init failed', e); }
    // 首次定位（如节点上点的那一段）延后一帧：组件首帧数据就绪后 showSeg 才能算出块坐标并滚动
    requestAnimationFrame(() => showSeg(currentSegIdx));
    const tlObserver = new MutationObserver(() => { if (timeline) timeline.refresh(); });
    tlObserver.observe(segsWrap, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    segsWrap.addEventListener('input', (e) => {
        if (timeline && (e.target.classList.contains('neo-director-dur') || e.target.classList.contains('neo-director-prompt'))) timeline.refresh();
    });

    // 配方名称：钉在标题栏中间，默认以文本直接显示，点击进入行内编辑
    // （Enter / 失焦提交，Esc 还原为打开时的名称）
    const nameInp = $el('input', { className: 'neo-director-name', type: 'text', placeholder: '配方名称', value: (existing && existing.name) || '' });
    const nameView = $el('span', { className: 'neo-director-name-view', title: '点击编辑配方名称' });
    const nameWrap = $el('div', { className: 'neo-director-name-wrap' }, [nameView, nameInp]);
    const renderName = () => {
        const v = nameInp.value.trim();
        nameView.textContent = v || '未命名配方';
        nameView.classList.toggle('neo-director-name-empty', !v);
    };
    const stopNameEdit = () => {
        nameWrap.classList.remove('neo-director-name-editing');
        renderName();
    };
    renderName();
    nameView.onclick = () => {
        nameWrap.classList.add('neo-director-name-editing');
        nameInp.focus();
        nameInp.select();
        nameInp.scrollLeft = 0;    // 全选后回到开头，长名称不至于只显示尾部
    };
    nameInp.addEventListener('blur', stopNameEdit);
    nameInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stopNameEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); nameInp.value = requestedName; stopNameEdit(); }
    });
    // 分辨率：宽高比 + 百万像素 → W/H（32 对齐）；「自定义」手输 W/H。不再保存 seed（后端默认 0，节点输入可覆盖）
    const initRes = (() => {
        const w = Number(exShared.width) || 1344, h = Number(exShared.height) || 768;
        if (exShared.aspect_ratio && DIRECTOR_ASPECTS.some(([l]) => l === exShared.aspect_ratio)) {
            return { label: exShared.aspect_ratio, mp: directorClampMp(exShared.megapixels != null ? exShared.megapixels : MP_DEFAULT), cw: w, ch: h };
        }
        if (exShared.width != null && exShared.height != null) {
            const inf = directorInferAspect(w, h);
            return { label: inf.label, mp: inf.mp, cw: w, ch: h };
        }
        return { label: '16:9 (宽屏)', mp: MP_DEFAULT, cw: 0, ch: 0 };
    })();
    const aspectSel = $el('select', { className: 'neo-director-aspect' });
    for (const [label] of DIRECTOR_ASPECTS) aspectSel.appendChild($el('option', { value: label, textContent: label }));
    aspectSel.appendChild($el('option', { value: DIRECTOR_CUSTOM, textContent: DIRECTOR_CUSTOM + '（手输 W/H）' }));
    aspectSel.value = initRes.label;
    const mpInp = $el('input', { className: 'neo-director-num neo-director-mp', type: 'number', min: MP_MIN, max: MP_MAX, step: 0.1, value: initRes.mp });
    const cwInp = $el('input', { className: 'neo-director-num', type: 'number', min: 16, placeholder: '宽', value: initRes.cw || '' });
    const chInp = $el('input', { className: 'neo-director-num', type: 'number', min: 16, placeholder: '高', value: initRes.ch || '' });
    const resOut = $el('span', { className: 'neo-director-res' });
    const customRow = $el('div', { className: 'neo-director-row neo-director-shared' }, [
        $el('label', { textContent: '宽' }), cwInp,
        $el('label', { textContent: '高' }), chInp,
    ]);

    const updateRes = () => {
        const custom = aspectSel.value === DIRECTOR_CUSTOM;
        customRow.style.display = custom ? '' : 'none';
        if (custom) { resOut.textContent = ''; return; }
        const r = directorResolution(aspectSel.value, mpInp.value);
        if (r) resOut.textContent = `${r.width}×${r.height}`;
    };
    aspectSel.onchange = updateRes;
    mpInp.addEventListener('input', updateRes);
    updateRes();

    let overlay;
    const close = () => {   // 无条件关闭（保存成功 / 「放弃修改」后走这里）：清脏态并隐藏确认条
        dirty = false;
        dirtyConfirm.hidden = true;
        if (timeline) { try { timeline.destroy(); } catch (_) {} timeline = null; }
        if (overlay && overlay.parentNode) overlay.remove();
        if (_directorEditor && _directorEditor.close === close) _directorEditor = null;
    };
    // 用户主动关闭（✕ / 取消）：有未保存修改时先出确认条暂停关闭，等用户在确认条里选择
    const requestClose = () => {
        if (!dirty) { close(); return; }
        dirtyConfirm.hidden = false;
    };
    const saveBtn = $el('button', { className: 'rs-btn neo-director-save', textContent: '保存' });
    const cancelBtn = $el('button', { className: 'rs-btn neo-director-cancel', textContent: '取消', onclick: requestClose });
    // 未保存修改确认条（同自动增强菜单 rs-gen-dirty-confirm 模式）：「保存并关闭」复用完整保存路径，失败则留在窗口内重试
    const dirtyConfirm = $el('div', { className: 'neo-director-dirty-confirm' }, [
        $el('span', { className: 'neo-director-dirty-text', textContent: '⚠ 有未保存的修改' }),
        $el('button', { className: 'rs-btn neo-director-dirty-save', type: 'button', textContent: '💾 保存并关闭', onclick: () => saveBtn.onclick() }),
        $el('button', { className: 'rs-btn neo-director-dirty-discard', type: 'button', textContent: '放弃修改', onclick: close }),
        $el('button', { className: 'rs-btn neo-director-dirty-keep', type: 'button', textContent: '继续编辑', onclick: () => { dirtyConfirm.hidden = true; } }),
    ]);
    dirtyConfirm.hidden = true;

    saveBtn.onclick = async () => {
        const name = nameInp.value.trim();
        if (!name) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '请填写配方名称', life: 4000 }); return; }
        const gMode = modeSel.value;   // 't2v' | 'i2v' | 'mixed'
        const segments = [];
        const warnings = [];   // 内容不完整只提示、不阻止保存（允许先存草稿再补素材）
        let segNo = 0;
        for (const row of Array.from(segsWrap.querySelectorAll('.neo-director-seg'))) {
            segNo += 1;
            const skill_id = row.querySelector('.neo-director-skill').value;
            const prompt = row.querySelector('.neo-director-prompt').value.trim();
            if (!skill_id || !prompt) warnings.push(`第 ${segNo} 段未选择技能或未填提示词`);
            const eff = (gMode === 'mixed') ? row.querySelector('.neo-director-segmode').value : gMode;
            const frames = segFrameReaders.get(row) || {};
            const first = frames.first ? frames.first() : '';
            const last = frames.last ? frames.last() : '';
            const seg = {
                skill_id, prompt,
                duration_sec: Number(row.querySelector('.neo-director-dur').value) || null,
            };
            if (gMode === 'mixed') seg.mode = eff;
            const readers = segRefReaders.get(row) || [];
            const refs = {};
            readers.forEach((read, gi) => {
                const picked = read();
                if (picked.length) refs[SEG_REF_GROUPS[gi].key] = picked;
            });
            if (Object.keys(refs).length) seg.refs = refs;
            // 首帧：图生与首尾帧模式携带；尾帧：仅首尾帧模式携带
            if (eff === 'i2v' || eff === 'fl2v') {
                if (first) seg.first_frame = first;
            }
            if (eff === 'fl2v') {
                if (last) seg.last_frame = last;
            }
            // 源视频：仅视频编辑模式携带
            if (eff === 'v2v' || eff === 'rv2v') {
                const sv = segSvReaders.get(row) ? segSvReaders.get(row)() : '';
                if (sv) seg.source_video = sv;
            }
            // 各模式的内容完整性：只提示、不阻止保存（允许先存草稿再补素材）
            if ((eff === 'i2v' || eff === 'fl2v') && !seg.first_frame && !seg.refs) {
                warnings.push(`第 ${segNo} 段（${MODE_LABELS.get(eff)}）缺首帧图或参考素材`);
            }
            if (eff === 'fl2v' && !seg.last_frame) {
                warnings.push(`第 ${segNo} 段（首尾帧生视频）缺尾帧图`);
            }
            if (eff === 'r2v' && !seg.refs) {
                warnings.push(`第 ${segNo} 段（全参考生视频）缺参考素材（图 / 视频 / 音频）`);
            }
            if ((eff === 'v2v' || eff === 'rv2v') && !seg.source_video) {
                warnings.push(`第 ${segNo} 段（${MODE_LABELS.get(eff)}）缺源视频`);
            }
            if ((eff === 'i2v' || eff === 'fl2v') && seg.refs) {
                const extra = (seg.refs.images || []).length + (seg.refs.videos || []).length + (seg.refs.audios || []).length;
                if (extra > 0) warnings.push(`第 ${segNo} 段（${MODE_LABELS.get(eff)}）有 ${extra} 条参考素材，该模式仅使用首帧/尾帧，多余参考不会生效`);
            }
            segments.push(seg);
        }
        if (!segments.length) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '至少需要一个段', life: 4000 }); return; }
        if (warnings.length) {
            app.extensionManager.toast.add({ severity: 'warning', summary: '多段导演', detail: `有 ${warnings.length} 段待完善（不阻止保存）：${warnings.join('；')}`, life: 6000 });
        }
        // 参考素材（图/视频/音频）都需进配方 assets 才能在 load_director_spec 里解析成 input 相对名
        const assets = imageRefs.slice();
        const assetNames = new Set(assets.map(r => r.filename));
        for (const seg of segments) {
            for (const [key, kind] of [['images', 'image'], ['videos', 'video'], ['audios', 'audio']]) {
                for (const name of ((seg.refs || {})[key] || [])) {
                    if (assetNames.has(name)) continue;
                    assetNames.add(name);
                    assets.push({ filename: name, subfolder: '', type: 'input', kind });
                }
            }
            if (seg.source_video && !assetNames.has(seg.source_video)) {
                assetNames.add(seg.source_video);
                assets.push({ filename: seg.source_video, subfolder: '', type: 'input', kind: 'video' });
            }
        }
        const custom = aspectSel.value === DIRECTOR_CUSTOM;
        let outW, outH;
        if (custom) {
            outW = Number(cwInp.value) || 1344;
            outH = Number(chInp.value) || 768;
        } else {
            const r = directorResolution(aspectSel.value, mpInp.value);
            outW = r.width; outH = r.height;
        }
        // 统一设置区状态（统一参考/首帧/尾帧）：随配方落盘，重新打开时回显；全空不写
        const uniRefs = {};
        uniRefRows.forEach((r, gi) => { const picked = r.getSelected(); if (picked.length) uniRefs[SEG_REF_GROUPS[gi].key] = picked; });
        const setupPayload = {};
        if (Object.keys(uniRefs).length) setupPayload.refs = uniRefs;
        const uniFFSel = uniFFGrid.getSelected(); if (uniFFSel) setupPayload.first_frame = uniFFSel;
        const uniLFSel = uniLFGrid.getSelected(); if (uniLFSel) setupPayload.last_frame = uniLFSel;
        if (origPrompts) setupPayload.orig_prompts = origPrompts;   // 优化前后提示词对照：随配方落盘，重开时回显两栏
        if (optPrompts) setupPayload.opt_prompts = optPrompts;
        saveBtn.disabled = true;
        try {
            const result = await saveRecipe(name, '', assets, [], [], {
                shared: Object.assign(
                    custom
                        ? { width: outW, height: outH, aspect_ratio: DIRECTOR_CUSTOM }
                        : { width: outW, height: outH, aspect_ratio: aspectSel.value, megapixels: directorClampMp(mpInp.value) },
                    { mode: gMode },
                ),
                segments,
                // 自动故事板内容（主题 / 脚本 / 粒度）：随配方落盘，重新打开编辑器回显。
                // 空内容由后端判空后不写入，前端无需分支。
                story: {
                    idea: ideaInp.value.trim() || null,
                    story: storyTa.value.trim() || null,
                    segment_seconds: Number(segLenSel.value) || null,
                },
                setup: Object.keys(setupPayload).length ? setupPayload : null,
            }, "video");
            if (result.success) {
                app.extensionManager.toast.add({ severity: 'success', summary: '多段导演已保存', detail: `${name}（${segments.length} 段）`, life: 4000 });
                close();
                // 广播配方已落盘：节点内时间轴据此刷新下拉 + 重载 spec。created=true 表示新建，供节点自动选中刚保存的配方。
                window.dispatchEvent(new CustomEvent(DIRECTOR_RECIPE_SAVED_EVENT, { detail: { name, created: !existing } }));
                if (typeof onSaved === 'function') onSaved();
            } else {
                app.extensionManager.toast.add({ severity: 'error', summary: '保存失败', detail: result.error || 'Unknown error', life: 5000 });
            }
        } catch (e) {
            console.error('[Neo Recipes] Director save failed:', e);
            app.extensionManager.toast.add({ severity: 'error', summary: '保存失败', detail: e.message, life: 5000 });
        } finally {
            saveBtn.disabled = false;
        }
    };

    // ==========================================
    // 📖 故事生成（半自动）：主题→LLM 生成故事→确认拆分填充时间轴
    // ==========================================

    // 右栏：分段后的故事（优化前原文）——打开旧配方时回显、拆分成功后刷新；左栏是分段前的完整故事。
    // 优化结果只写时间轴与统一设置页对照表，右栏保持拆分时的原文不变。
    const segPreview = $el('div', { className: 'neo-director-story-segs' });
    function renderSegPreview(segments) {
        segPreview.innerHTML = '';
        if (!segments || !segments.length) {
            segPreview.appendChild($el('div', { className: 'neo-director-story-segs-empty', textContent: '（点击左侧「拆分」后，这里显示分段后的故事）' }));
            return;
        }
        segments.forEach((s, i) => {
            segPreview.appendChild($el('div', { className: 'neo-director-story-seg-item' }, [
                $el('div', { className: 'neo-director-story-seg-head' }, [
                    $el('span', { textContent: `#${i + 1}` }),
                    $el('span', { textContent: s.duration_sec ? `${s.duration_sec}s` : '' }),
                ]),
                $el('div', { className: 'neo-director-story-seg-prompt', textContent: s.prompt || '' }),
            ]));
        });
    }
    // 打开旧配方时回显分段后的故事（右栏显示优化前原文：优先用落盘的对照快照，否则用段内当前提示词）；新建显示占位提示
    const exSegPreview = exSegs.map((s, i) => ({ ...s, prompt: (origPrompts && origPrompts[i]) || s.prompt }));
    renderSegPreview(exSegPreview.length ? exSegPreview : []);

    const ideaInp = $el('textarea', { className: 'neo-director-story-idea', placeholder: '输入故事主题 / 想法（如：一只机器猫在雨夜的城市寻找回家的路）' });
    const genBtn = $el('button', { className: 'rs-btn neo-director-gen-story', textContent: '✨ 自动生成故事' });
    const storyTa = $el('textarea', { className: 'neo-director-story', placeholder: '（生成后可编辑，或直接手写故事脚本）' });
    ideaInp.value = exStory.idea || '';   // textarea 用属性赋值回显（$el 的 value 选项对 textarea 不生效）
    storyTa.value = exStory.story || '';
    const storyStatus = $el('span', { className: 'neo-director-story-status' });
    const segLenSel = $el('select', { className: 'neo-director-seglen' });
    for (const s of [5, 10, 15]) segLenSel.appendChild($el('option', { value: String(s), textContent: `${s} 秒 / 段` }));
    segLenSel.value = '10';
    if (exStory.segment_seconds) segLenSel.value = String(exStory.segment_seconds);
    if (!segLenSel.value) segLenSel.value = '10'; // 存了非预设粒度时落回默认
    const splitBtn = $el('button', { className: 'rs-btn neo-director-split', textContent: '✅ 确认并拆分到时间轴' });

    // 新建配方：标题随「主题/想法」输入实时同步（超 20 字截断）；手动命名后不再覆盖，编辑已有配方不同步
    let nameManuallySet = false;
    nameInp.addEventListener('input', () => { nameManuallySet = true; });
    ideaInp.addEventListener('input', () => {
        if (existing || nameManuallySet) return;
        const v = ideaInp.value.trim();
        nameInp.value = v.length > 20 ? v.slice(0, 20) + '…' : v;
        renderName();
    });
    // 新建配方：直接在时间轴输入段提示词时，若尚未手动命名则同样截取生成标题（与「主题/想法」一致）
    segsWrap.addEventListener('input', (e) => {
        if (!e.target.classList.contains('neo-director-prompt')) return;
        if (existing || nameManuallySet) return;
        const v = e.target.value.trim();
        nameInp.value = v.length > 20 ? v.slice(0, 20) + '…' : v;
        renderName();
    });

    genBtn.onclick = async () => {
        const idea = ideaInp.value.trim();
        if (!idea) { app.extensionManager.toast.add({ severity: 'error', summary: '故事生成', detail: '请先填写故事主题', life: 4000 }); return; }
        genBtn.disabled = true; storyStatus.textContent = '正在生成故事…';
        try {
            const res = await fetch('/rs_recipes/director_generate_story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea }) });
            const data = await res.json();
            if (data.success) { storyTa.value = data.story || ''; storyStatus.textContent = '已生成，可编辑后拆分'; markDirty(); }
            else { storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '故事生成失败', detail: data.error || 'Unknown error', life: 5000 }); }
        } catch (e) {
            console.error('[Neo Recipes] Director: generate story failed', e);
            storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '故事生成失败', detail: e.message, life: 5000 });
        } finally { genBtn.disabled = false; }
    };

    splitBtn.onclick = async () => {
        const story = storyTa.value.trim();
        if (!story) { app.extensionManager.toast.add({ severity: 'error', summary: '拆分', detail: '请先生成或填写故事', life: 4000 }); return; }
        splitBtn.disabled = true; storyStatus.textContent = '正在拆分…';
        try {
            const res = await fetch('/rs_recipes/director_split_segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story, segment_seconds: Number(segLenSel.value) }) });
            const data = await res.json();
            if (!data.success) { storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '拆分失败', detail: data.error || 'Unknown error', life: 5000 }); return; }
            const defaultSkill = skills.length ? skills[0].id : '';
            segsWrap.innerHTML = '';
            for (const s of data.segments) {
                segsWrap.appendChild(buildSeg({ skill_id: defaultSkill, prompt: s.prompt, duration_sec: s.duration_sec, mode: 't2v' }));
            }
            renumberSegs(); showSeg(0); applyGlobalMode();
            renderSegPreview(data.segments); // 右栏显示分段后的故事（留在本页，保留左右两栏对照）
            storyStatus.textContent = `已拆分 ${data.segments.length} 段，详见右侧`;
            markDirty();
            app.extensionManager.toast.add({ severity: 'success', summary: '已填充时间轴', detail: `${data.segments.length} 段`, life: 4000 });
            switchTab('setup');   // 拆分后进入中间步骤：统一设置（模式 / 参考素材 / 提示词优化）
        } catch (e) {
            console.error('[Neo Recipes] Director: split segments failed', e);
            storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '拆分失败', detail: e.message, life: 5000 });
        } finally { splitBtn.disabled = false; }
    };

    // ---- 两个可切换页签：自动故事板 / 时间轴分段（避免单页过于复杂）----
    const storyboardPane = $el('div', { className: 'neo-director-pane neo-director-pane-story' }, [
        $el('div', { className: 'neo-director-story-cols' }, [
            // 左栏：分段前故事（主题 + 生成 + 脚本 + 拆分控制）
            $el('div', { className: 'neo-director-story-col neo-director-story-left' }, [
                $el('div', { className: 'neo-director-story-idea-row' }, [ideaInp, genBtn]),
                storyTa,
                storyStatus,
                $el('div', { className: 'neo-director-story-actions' }, [
                    $el('label', { className: 'neo-director-seglen-wrap' }, [$el('span', { textContent: '分段粒度' }), segLenSel]),
                    splitBtn,
                ]),
            ]),
            // 右栏：分段后的故事（拆分成功后显示）
            $el('div', { className: 'neo-director-story-col neo-director-story-right' }, [
                $el('label', { className: 'neo-director-field-label neo-director-story-segs-title', textContent: '分段的故事' }),
                segPreview,
            ]),
        ]),
    ]);

    // 「拉伸」控制条：放在时间轴说明行最右侧（不独占一行），驱动 timeline.setZoom()。
    const zoomSlider = $el('input', { className: 'neo-director-zoom-slider', type: 'range', min: 0.25, max: 4, step: 0.25, value: 1 });
    zoomSlider.addEventListener('input', () => { if (timeline) timeline.setZoom(Number(zoomSlider.value)); });
    const zoomToggle = $el('button', { className: 'neo-director-zoom-toggle', type: 'button', title: '拉伸时间轴', textContent: '↔ 拉伸' });
    zoomToggle.addEventListener('click', () => {
        if (!timeline) return;
        const next = timeline.getZoom() <= 1 ? 2 : 1;
        timeline.setZoom(next);
        zoomSlider.value = String(next);
    });
    const tlLabelRow = $el('div', { className: 'neo-director-tl-label' }, [
        $el('span', { textContent: '时间轴（拖拽重排 · 点击定位分段 · 尾部 ＋ 添加段）' }),
        addBtn,
        $el('div', { className: 'neo-director-zoom' }, [zoomToggle, zoomSlider]),
    ]);
    // 全局生成模式：文生 / 图生 / 首尾帧 / 全参考 / 混合（决定各段携带哪些帧与参考）。
    // 旧配方无 shared.mode 时按各段内容推断：有尾帧=fl2v、有首帧=i2v、有参考=r2v、全无=t2v、混合=mixed。
    const initMode = (() => {
        if (MODE_LABELS.has(exShared.mode)) return exShared.mode;
        const hasFirst = exSegs.some(s => s && s.first_frame);
        const hasLast = exSegs.some(s => s && s.last_frame);
        const hasSource = exSegs.some(s => s && s.source_video);
        const hasRef = exSegs.some(s => s && s.refs && Object.keys(s.refs).length);
        if (hasLast) return 'fl2v';
        if (hasSource) return hasRef ? 'rv2v' : 'v2v';
        if (hasFirst && hasRef) return 'mixed';
        if (hasFirst) return 'i2v';
        if (hasRef) return 'r2v';
        return 't2v';
    })();
    modeSel = $el('select', { className: 'neo-director-mode' });
    for (const [val, label] of MODE_LABELS) {
        modeSel.appendChild($el('option', { value: val, textContent: label }));
    }
    modeSel.value = initMode;
    modeSel.addEventListener('change', () => applyGlobalMode());
    applyGlobalMode();   // 初始化各段首帧/尾帧/参考素材区与模式选择器的显隐

    // ==========================================
    // 🎯 统一设置（中间步骤）：选模式 → 统一参考素材 → 按 H3 官方格式批量重写提示词，再到时间轴逐段微调
    // ==========================================
    const setupModeSel = $el('select', { className: 'neo-director-mode neo-director-setup-mode' });
    for (const [val, label] of MODE_LABELS) setupModeSel.appendChild($el('option', { value: val, textContent: label }));
    setupModeSel.value = modeSel.value;
    // 两处「生成模式」下拉双向同步（同一状态，改哪边都生效），并刷新统一素材区显隐
    modeSel.addEventListener('change', () => { setupModeSel.value = modeSel.value; refreshSetupRefs(); });
    setupModeSel.addEventListener('change', () => { modeSel.value = setupModeSel.value; applyGlobalMode(); refreshSetupRefs(); });

    // 统一素材区：按全局模式显示（与各段素材要求一致）——
    // r2v → 三组参考素材网格；i2v → 统一首帧；fl2v → 统一首帧+尾帧；t2v / mixed → 说明文字。
    // 改动即自动覆盖式应用到所有分段（无需手动点应用）。
    const applyUniRefs = () => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) return;
        const src = uniRefRows.map(r => r.getSelected());
        for (const row of rows) {
            const setters = segRefSetters.get(row) || [];
            setters.forEach((set, gi) => set && set(src[gi]));
        }
    };
    const uniRefRows = SEG_REF_GROUPS.map((g) => buildSegRefRow(g, (exSetup.refs || {})[g.key], null, applyUniRefs));
    const uniR2vBlock = $el('div', { className: 'neo-director-setup-refs' }, [
        $el('div', { className: 'neo-director-refs-head' }, [
            $el('span', { className: 'neo-director-field-label', textContent: '统一参考素材（改动自动应用到所有分段；图 ≤9 / 视频 ≤3 / 音频 ≤3）' }),
            buildAssetLibButton(),
        ]),
        uniRefRows[0].row,   // 参考图独占一行（与每段布局一致）
        $el('div', { className: 'neo-director-ref-row-pair' }, [uniRefRows[1].row, uniRefRows[2].row]),
    ]);

    // 统一首帧/尾帧选中变化 → 自动应用到所有分段（取消选择则清空各段对应帧）
    const applyUniFrames = (fname, last) => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) return;
        for (const row of rows) {
            const setters = segFrameSetters.get(row);
            if (!setters) continue;
            if (last) { if (fname) row._lfAddCandidate(fname); else setters.last(''); }
            else { if (fname) row._addCandidate(fname); else setters.first(''); }
        }
    };
    const uniFFGrid = buildFrameGrid('neo-director-ff', exSetup.first_frame || '', '无', (f) => applyUniFrames(f, false));
    const uniLFGrid = buildFrameGrid('neo-director-lf', exSetup.last_frame || '', '无', (f) => applyUniFrames(f, true));
    const uniFrameLabel = $el('span', { className: 'neo-director-field-label', textContent: '统一首帧（改动自动应用到所有分段）' });
    // 首/尾帧各包一块（与时间轴分段页同构）：fl2v 两块都显示时并排同一行、各占一半
    const uniFfBlock = $el('div', { className: 'neo-director-ff-block' }, [
        frameRow('首帧图（点选或从左侧素材栏拖入）', (fname) => uniFFGrid.addCandidate(fname)), uniFFGrid.grid,
    ]);
    const uniLfBlock = $el('div', { className: 'neo-director-lf-block' }, [
        frameRow('尾帧图（首尾帧模式：锁住该段收尾画面）', (fname) => uniLFGrid.addCandidate(fname)), uniLFGrid.grid,
    ]);
    const uniFrameBlock = $el('div', { className: 'neo-director-setup-frames' }, [
        // 「素材库」按钮只留在各帧行上（与逐段布局一致），head 不再重复挂一个
        $el('div', { className: 'neo-director-refs-head' }, [uniFrameLabel]),
        $el('div', { className: 'neo-director-fflf neo-director-fflf-row' }, [uniFfBlock, uniLfBlock]),
    ]);

    const uniT2vHint = $el('div', { className: 'neo-director-setup-hint', textContent: '文生视频不需要参考素材，直接为各段填写提示词即可' });
    const uniMixedHint = $el('div', { className: 'neo-director-setup-hint', textContent: '混合模式：统一参考图会应用到所有分段（仅 r2v 段生效），i2v/fl2v 段请到「🎞️ 时间轴分段」页逐段设置首帧' });
    const uniV2vHint = $el('div', { className: 'neo-director-setup-hint', textContent: '视频编辑：源视频请到「🎞️ 时间轴分段」页逐段设置（每段一段切片），提示词用 <Video 1> 指代源视频' });

    // 按全局模式切换统一素材区（与每段有效模式的显隐规则一致）
    function refreshSetupRefs() {
        const m = setupModeSel.value;
        uniR2vBlock.style.display = (m === 'r2v' || m === 'mixed') ? '' : 'none';
        uniFrameBlock.style.display = (m === 'i2v' || m === 'fl2v') ? '' : 'none';
        uniLfBlock.style.display = (m === 'fl2v') ? '' : 'none';
        uniFrameLabel.textContent = (m === 'fl2v') ? '统一首帧 / 尾帧（改动自动应用到所有分段）' : '统一首帧（改动自动应用到所有分段）';
        uniT2vHint.style.display = (m === 't2v') ? '' : 'none';
        uniMixedHint.style.display = (m === 'mixed') ? '' : 'none';
        uniV2vHint.style.display = (m === 'v2v' || m === 'rv2v') ? '' : 'none';
    }

    // 提示词批量优化：各段现有提示词 + 模式 + 统一参考 → LLM 重写为 H3 官方格式，逐段写回编辑器
    const optBtn = $el('button', { className: 'rs-btn neo-director-optimize', textContent: '✨ 优化所有分段提示词（H3 官方格式）' });
    const optStatus = $el('span', { className: 'neo-director-story-status' });
    optBtn.onclick = async () => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '还没有分段，请先在故事板页拆分', life: 3000 }); return; }
        // 首次优化前快照各段原文；之后重新点优化始终基于该原文再试（不叠加上一轮结果）
        if (!origPrompts) origPrompts = rows.map((row) => row.querySelector('.neo-director-prompt').value);
        const segs = rows.map((row, i) => ({
            prompt: (origPrompts[i] || '').trim(),
            duration_sec: Number(row.querySelector('.neo-director-dur').value) || null,
        }));
        if (segs.some(s => !s.prompt)) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '有分段未填提示词，请先补齐再优化', life: 4000 }); return; }
        const refs = {};
        if (setupModeSel.value === 'r2v') {   // 参考素材仅全参考模式使用，其余模式不带
            uniRefRows.forEach((r, gi) => { const picked = r.getSelected(); if (picked.length) refs[SEG_REF_GROUPS[gi].key] = picked; });
        }
        optBtn.disabled = true;
        optStatus.textContent = '正在按 H3 官方格式优化各段提示词…';
        try {
            const res = await fetch('/rs_recipes/director_optimize_prompts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ segments: segs, mode: setupModeSel.value, refs }),
            });
            const data = await res.json();
            if (!data.success) { optStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '提示词优化失败', detail: data.error || `HTTP ${res.status}`, life: 5000 }); return; }
            rows.forEach((row, i) => { row.querySelector('.neo-director-prompt').value = data.prompts[i] || ''; });
            optPrompts = data.prompts;
            segs.forEach((s, i) => { s.prompt = data.prompts[i] || ''; });   // 优化结果只写时间轴；故事板右栏保持优化前原文
            renderSetupSegs();        // 本页直接显示优化后的分段内容
            optStatus.textContent = `已优化 ${data.prompts.length} 段，可到时间轴页逐段微调`;
            markDirty();
            app.extensionManager.toast.add({ severity: 'success', summary: '提示词优化完成', detail: `${data.prompts.length} 段已按 H3 官方格式重写`, life: 4000 });
        } catch (e) {
            console.error('[Neo Recipes] Director optimize prompts failed:', e);
            optStatus.textContent = '';
            app.extensionManager.toast.add({ severity: 'error', summary: '提示词优化失败', detail: e.message, life: 5000 });
        } finally {
            optBtn.disabled = false;
        }
    };

    // 统一设置页：各段提示词两栏对照（类似表格）——左 = 未优化原文，右 = 最近一次优化结果。
    // 首次点优化前快照原文（origPrompts），之后重新点优化始终基于该原文再试、不叠加上一轮结果；
    // 两份快照随 setup 落盘，打开旧配方时回显两栏。数据读时间轴分段行（唯一事实来源）。
    const setupSegPreview = $el('div', { className: 'neo-director-setup-segs' });
    function renderSetupSegs() {
        setupSegPreview.innerHTML = '';
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) {
            setupSegPreview.appendChild($el('div', { className: 'neo-director-story-segs-empty', textContent: '（还没有分段，请先在故事板页拆分）' }));
            return;
        }
        setupSegPreview.appendChild($el('div', { className: 'neo-director-setup-seg-cols neo-director-setup-seg-labels' }, [
            $el('span', { textContent: '优化前' }),
            $el('span', { textContent: '优化后' }),
        ]));
        rows.forEach((row, i) => {
            const dur = row.querySelector('.neo-director-dur').value;
            const before = (origPrompts && origPrompts[i]) || row.querySelector('.neo-director-prompt').value || '';
            const after = (optPrompts && optPrompts[i]) || '（未优化）';
            setupSegPreview.appendChild($el('div', { className: 'neo-director-story-seg-item' }, [
                $el('div', { className: 'neo-director-story-seg-head' }, [
                    $el('span', { textContent: `#${i + 1}` }),
                    $el('span', { textContent: dur ? `${dur}s` : '' }),
                ]),
                $el('div', { className: 'neo-director-setup-seg-cols' }, [
                    $el('div', { className: 'neo-director-story-seg-prompt', textContent: before }),
                    $el('div', { className: 'neo-director-story-seg-prompt', textContent: after }),
                ]),
            ]));
        });
    }

    const setupPane = $el('div', { className: 'neo-director-pane neo-director-pane-setup' }, [
        $el('div', { className: 'neo-director-row neo-director-shared' }, [
            $el('label', { textContent: '生成模式（全局统一）' }), setupModeSel,
        ]),
        uniR2vBlock,     // 全参考：三组参考素材
        uniFrameBlock,   // 图生 / 首尾帧：统一首帧（+ 尾帧）
        uniT2vHint,      // 文生：无需素材说明
        uniMixedHint,    // 混合：逐段设置提示
        uniV2vHint,      // 视频编辑：逐段设置源视频提示
        $el('div', { className: 'neo-director-setup-opt' }, [optBtn, optStatus]),
        $el('label', { className: 'neo-director-field-label neo-director-story-segs-title', textContent: '各段提示词对照（左 = 优化前 · 右 = 优化后，重新点优化基于原文再试）' }),
        setupSegPreview,
    ]);
    refreshSetupRefs();   // 按当前模式初始化统一素材区显隐
    renderSetupSegs();    // 打开旧配方时回显各段当前内容


    const timelinePane = $el('div', { className: 'neo-director-pane neo-director-pane-timeline' }, [
        $el('div', { className: 'neo-director-row neo-director-shared' }, [
            $el('label', { textContent: '生成模式' }), modeSel,
            $el('label', { textContent: '宽高比' }), aspectSel,
            $el('label', { textContent: '百万像素' }), mpInp,
            resOut,
        ]),
        customRow,
        tlLabelRow,
        tlWrap,
        segsWrap,
    ]);

    const tabStory = $el('button', { className: 'neo-director-tab', type: 'button', textContent: '📖 自动故事板' });
    const tabSetup = $el('button', { className: 'neo-director-tab', type: 'button', textContent: '🎯 统一设置' });
    const tabTimeline = $el('button', { className: 'neo-director-tab', type: 'button', textContent: '🎞️ 时间轴分段' });
    function switchTab(which) {
        tabStory.classList.toggle('active', which === 'story');
        tabSetup.classList.toggle('active', which === 'setup');
        tabTimeline.classList.toggle('active', which === 'timeline');
        storyboardPane.style.display = (which === 'story') ? '' : 'none';
        setupPane.style.display = (which === 'setup') ? '' : 'none';
        timelinePane.style.display = (which === 'timeline') ? '' : 'none';
        if (which === 'setup') renderSetupSegs();   // 切到统一设置页时刷新各段当前内容（含时间轴页的改动）
        else if (which === 'timeline' && timeline) timeline.refresh(); // 切回时间轴时按真实宽度重绘 canvas
    }
    tabStory.onclick = () => switchTab('story');
    tabSetup.onclick = () => switchTab('setup');
    tabTimeline.onclick = () => switchTab('timeline');
    const tabBar = $el('div', { className: 'neo-director-tabs' }, [tabStory, tabSetup, tabTimeline]);

    const body = $el('div', { className: 'neo-director-body' }, [
        storyboardPane,
        setupPane,
        timelinePane,
    ]);
    switchTab(existing ? 'timeline' : 'story'); // 新建默认自动故事板，编辑保持时间轴分段
    const foot = $el('div', { className: 'neo-director-foot' }, [cancelBtn, saveBtn]);
    // 「放大到最大」：标题栏 ⛶ 按钮 / 双击标题栏均可切换。放大=铺满视口（留 8px
    // 边距，高度受 CSS max-height:88vh 约束），还原=回到放大前几何。
    let maximized = false;
    let prevRect = null;
    const maxBtn = $el('button', { className: 'neo-director-maximize', type: 'button', title: '放大到最大', textContent: '⛶' });
    const toggleMaximize = () => {
        if (!maximized) {
            const r = panel.getBoundingClientRect();
            prevRect = { left: r.left, top: r.top, width: r.width, height: r.height };
            if (!panel.style.left) panel.style.position = 'absolute';
            panel.style.left = '8px';
            panel.style.top = '8px';
            panel.style.width = (window.innerWidth - 16) + 'px';
            panel.style.height = (window.innerHeight - 16) + 'px';
            maximized = true;
        } else {
            panel.style.left = prevRect.left + 'px';
            panel.style.top = prevRect.top + 'px';
            panel.style.width = prevRect.width + 'px';
            panel.style.height = prevRect.height + 'px';
            maximized = false;
            prevRect = null;
        }
        maxBtn.classList.toggle('neo-director-maximized', maximized);
        maxBtn.title = maximized ? '还原窗口' : '放大到最大';
    };
    maxBtn.onclick = toggleMaximize;

    const titleBar = $el('div', { className: 'neo-director-title' }, [
        $el('div', { className: 'neo-director-title-left' }, [
            $el('span', { textContent: '🎬 多段视频导演' }),
            nameWrap,
        ]),
        tabBar,
        $el('div', { className: 'neo-director-title-btns' }, [
            maxBtn,
            $el('button', { className: 'neo-director-close', textContent: '✕', onclick: requestClose }),
        ]),
    ]);
    const resizeHandle = $el('div', { className: 'neo-director-resize', title: '拖拽调整窗口大小' });
    const panel = $el('div', { className: 'neo-director-panel' }, [titleBar, body, dirtyConfirm, foot, resizeHandle]);

    // 窗口内表单控件统一脏标记：数据字段（名称/提示词/时长/模式/分辨率…）的 input/change 都算未保存修改；
    // 拉伸滑块只是视图状态，排除。程序化写回（生成/拆分/优化/同步）不触发事件，由各自路径显式 markDirty。
    const isViewOnlyControl = (el) => el && el.classList && el.classList.contains('neo-director-zoom-slider');
    panel.addEventListener('input', (e) => { if (!isViewOnlyControl(e.target)) markDirty(); }, true);
    panel.addEventListener('change', (e) => { if (!isViewOnlyControl(e.target)) markDirty(); }, true);

    // 标题栏拖动：首次按下从 flex 居中切到绝对定位并记录起点，之后按鼠标位移更新 left/top；
    // 钳制保证窗口不会被拖出视口（始终留一条可点到的标题栏 / ✕）。
    let dragging = false;
    let startMX = 0, startMY = 0, startL = 0, startT = 0;
    const onTitleMove = (e) => {
        if (!dragging) return;
        let left = startL + (e.clientX - startMX);
        let top = startT + (e.clientY - startMY);
        const w = panel.offsetWidth;
        left = Math.max(-w + 80, Math.min(left, window.innerWidth - 80));
        top = Math.max(0, Math.min(top, window.innerHeight - 44));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    };
    const onTitleUp = () => {
        dragging = false;
        window.removeEventListener('mousemove', onTitleMove);
        window.removeEventListener('mouseup', onTitleUp);
    };
    titleBar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button') || e.target.closest('.neo-director-name-view, .neo-director-name')) return; // 仅按钮（⛶/✕/页签）与配方名输入/显示区不触发拖动，标题栏其余空白可拖窗口
        const r = panel.getBoundingClientRect();
        if (!panel.style.left) { // 首次：从居中切到绝对定位，无跳变
            panel.style.position = 'absolute';
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
        }
        startMX = e.clientX; startMY = e.clientY;
        startL = parseFloat(panel.style.left); startT = parseFloat(panel.style.top);
        dragging = true;
        window.addEventListener('mousemove', onTitleMove);
        window.addEventListener('mouseup', onTitleUp);
    });

    titleBar.addEventListener('dblclick', (e) => {
        if (e.target.closest('button') || e.target.closest('.neo-director-name-view, .neo-director-name')) return; // 仅双击按钮（⛶/✕/页签）与配方名区不触发放大还原，其余空白可最大化
        toggleMaximize();
    });

    // 右下角手柄拖拽缩放：改面板 width/height（首次同样从居中切到绝对定位）；
    // 宽度下限保证内容不塌，上限钳制在视口内。时间轴经 ResizeObserver 自动跟随重排。
    let resizing = false;
    let rStartMX = 0, rStartMY = 0, rStartW = 0, rStartH = 0;
    const DT_MIN_W = 420, DT_MIN_H = 360; // 高度下限实际由 CSS .neo-director-panel min-height:480px 强制，此处仅兜底防负数
    const onResizeMove = (e) => {
        if (!resizing) return;
        let w = rStartW + (e.clientX - rStartMX);
        let h = rStartH + (e.clientY - rStartMY);
        w = Math.max(DT_MIN_W, Math.min(w, window.innerWidth - 16));
        h = Math.max(DT_MIN_H, Math.min(h, window.innerHeight - 16));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
    };
    const onResizeUp = () => {
        resizing = false;
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
    };
    resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // 避免拖动时选中文字 / 图片
        if (!panel.style.left) { // 首次：从居中切到绝对定位，无跳变
            const r = panel.getBoundingClientRect();
            panel.style.position = 'absolute';
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
        }
        rStartMX = e.clientX; rStartMY = e.clientY;
        rStartW = panel.offsetWidth; rStartH = panel.offsetHeight;
        resizing = true;
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', onResizeUp);
    });
    overlay = $el('div', { className: 'neo-director-overlay' }, [panel]);
    document.body.appendChild(overlay);
    _directorEditor = { name: requestedName, close, requestClose, isDirty: () => dirty, overlay, focusSeg: focusSegAt };
}
