/**
 * director.js — Neo-Nodes 多段视频导演编辑器（配方编辑窗口）。
 * 从 recipes.js 拆出：shared(宽高比/百万像素或自定义 W/H) + 逐段(skill/prompt/首帧/时长)
 * + 半自动故事生成/拆分。数据与保存仍走 recipes.js 的 saveRecipe / listVideoSkills / scanMediaNodes。
 */
import { app } from "../../../../scripts/app.js";
import { $el } from "../../../../scripts/ui.js";
import { DirectorTimeline } from "./director-timeline.js";
import { saveRecipe, listVideoSkills, scanMediaNodes, widgetValueToRef } from "./recipes.js";
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

/** 创建「从本地添加」按钮：点击弹出文件选择器，选择后上传并回调 onUploaded(fname)。
 *  accept 按素材类型过滤（image/video/audio/all）。 */
function buildLocalAddButton(accept, onUploaded) {
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
    const btn = $el('button', {
        className: 'neo-director-local-add',
        title: '从本地添加素材',
        onclick: () => fileInput.click(),
    }, [
        $el('i', { className: 'pi pi-upload' }),
        $el('span', { textContent: '本地' }),
    ]);
    btn.appendChild(fileInput);
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

// 当前打开的导演编辑器 { name, close, overlay }：name=配方名（新建模式为 ''）。
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
    let segCounter = 0; // 段身份计数：时间轴颜色按段内容绑定，重排不变色
    let modeSel = null;   // 全局生成模式（文生/图生/混合），在时间线面板中创建后赋值

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
        ['r2v', '参考主体生视频'],
    ];
    const SEG_MODE_KEYS = new Set(SEG_MODES.map(([k]) => k));
    const MODE_LABELS = new Map([...SEG_MODES, ['mixed', '混合模式']]);
    const segRefReaders = new Map();    // 段行 → [读取该段三组参考的函数]（保存时按当前 DOM 顺序取）
    const segFrameReaders = new Map();  // 段行 → {first, last} 读取该段首/尾帧的函数

    /** 一组参考素材的多选网格：候选 = 已连线同类媒体（可拖入新素材），点选/取消，✕ 移除候选。 */
    function buildSegRefRow(group, initialNames) {
        const candidates = { image: imageRefs, video: videoRefs, audio: audioRefs }[group.kind];
        const selected = new Set(Array.isArray(initialNames) ? initialNames : []);
        const shown = new Set();
        const grid = $el('div', { className: 'neo-director-refpick-grid' });
        const count = $el('span', { className: 'neo-director-refpick-count' });
        const thumb = (name) => {
            const url = `/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;
            if (group.kind === 'image') return $el('img', { className: 'neo-director-refpick-thumb', src: url, alt: name, loading: 'lazy' });
            if (group.kind === 'video') return $el('video', { className: 'neo-director-refpick-thumb', src: url, muted: true, preload: 'metadata' });
            return $el('div', { className: 'neo-director-refpick-thumb neo-director-refpick-thumb-audio', textContent: '🎵' });
        };
        const syncSel = () => {
            for (const it of Array.from(grid.children)) {
                it.classList.toggle('neo-director-refpick-active', selected.has(it.dataset.file));
            }
            count.textContent = `${selected.size}/${group.max}`;
        };
        const warn = (detail) => app.extensionManager.toast.add({ severity: 'warning', summary: '多段导演', detail, life: 4000 });
        const makeTile = (name) => {
            const delBtn = $el('button', { className: 'neo-director-refpick-del', title: '移除该素材', textContent: '✕' });
            const tile = $el('div', { className: 'neo-director-refpick-item', title: name, dataset: { file: name } }, [
                thumb(name), $el('div', { className: 'neo-director-refpick-name', textContent: name }), delBtn,
            ]);
            tile.onclick = () => {
                if (selected.has(name)) selected.delete(name);
                else if (selected.size >= group.max) { warn(`${group.label}最多 ${group.max} 个`); return; }
                else selected.add(name);
                syncSel();
            };
            delBtn.onclick = (e) => {
                e.stopPropagation();
                selected.delete(name);
                shown.delete(name);
                tile.remove();
                const idx = candidates.findIndex(r => r.filename === name);
                if (idx >= 0) candidates.splice(idx, 1);   // 不再作为候选（保存资产也随之去掉）
                syncSel();
            };
            return tile;
        };
        const addTile = (name) => {
            if (shown.has(name)) return;
            shown.add(name);
            grid.appendChild(makeTile(name));
        };
        for (const r of candidates) addTile(r.filename);
        for (const name of selected) addTile(name);
        syncSel();
        grid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; grid.classList.add('neo-director-drop'); });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault(); grid.classList.remove('neo-director-drop');
            const fname = await copyGalleryToInput(grabDataType(e));
            if (!fname) return;
            if (!candidates.some(r => r.filename === fname)) {
                candidates.push({ filename: fname, subfolder: '', type: 'input', kind: group.kind });
            }
            addTile(fname);
            if (selected.size >= group.max) { warn(`${group.label}最多 ${group.max} 个`); return; }
            selected.add(fname);
            syncSel();
        });
        const acceptMap = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
        const localBtn = buildLocalAddButton(acceptMap[group.kind] || '*/*', (fname) => {
            if (!candidates.some(r => r.filename === fname)) {
                candidates.push({ filename: fname, subfolder: '', type: 'input', kind: group.kind });
            }
            addTile(fname);
            if (selected.size >= group.max) { warn(`${group.label}最多 ${group.max} 个`); return; }
            selected.add(fname);
            syncSel();
        });
        const row = $el('div', { className: 'neo-director-segref-row' }, [
            $el('div', { className: 'neo-director-segref-head' }, [
                $el('span', { className: 'neo-director-field-label', textContent: `${group.label}（最多 ${group.max}）` }),
                count,
                localBtn,
            ]),
            grid,
        ]);
        return { row, getSelected: () => Array.from(selected) };
    }

    /** 单帧候选网格（首帧/尾帧共用）：「无」项 + 已连线 LoadImage 缩略图，单选。
     *  prefix 为类名前缀（首帧 `neo-director-ff` / 尾帧 `neo-director-lf`）；
     *  编辑旧配方时若已存文件名不在当前画布素材里，补占位项以免保存时被丢弃。 */
    function buildFrameGrid(prefix, initialName, emptyText) {
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
            if (wasActive) select('');
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
            tile.onclick = () => select(tile.classList.contains(`${prefix}-active`) ? '' : ref.filename);
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
        };
    }

    /** 单帧区的标题行（字段名 + 「本地」+ 「素材库」按钮）。onLocalAdd(fname) 在本地上传成功后回调。 */
    const frameRow = (labelText, onLocalAdd) => $el('div', { className: 'neo-director-ff-row' }, [
        $el('label', { className: 'neo-director-field-label', textContent: labelText }),
        buildLocalAddButton('image/*', onLocalAdd),
        $el('button', {
            className: 'neo-director-ff-lib',
            title: '打开/收起左侧素材面板',
            onclick: () => toggleGallerySidebar(),
        }, [
            $el('i', { className: 'pi pi-images' }),
            $el('span', { textContent: '素材库' }),
        ]),
    ]);

    function buildSeg(seg = {}) {
        const skillSel = $el('select', { className: 'neo-director-skill' });
        if (!skills.length) skillSel.appendChild($el('option', { value: '', textContent: '（无可用视频技能）' }));
        for (const s of skills) skillSel.appendChild($el('option', { value: s.id, textContent: s.name || s.id }));
        if (seg.skill_id) skillSel.value = seg.skill_id;

        const promptTa = $el('textarea', { className: 'neo-director-prompt', placeholder: '该段画面 / 运动描述（必填）', value: seg.prompt || '' });
        const durInp = $el('input', { className: 'neo-director-dur', type: 'number', min: 1, max: 3600, value: (seg.duration_sec != null ? seg.duration_sec : 5) });

        // 首帧 / 尾帧候选网格：「无」+ 已连线 LoadImage 缩略图，单选（首帧驱动 I2V 与连续性，尾帧锁 FL2V 收尾）
        const ffGrid = buildFrameGrid('neo-director-ff', seg.first_frame, '无（文生视频）');
        const lfGrid = buildFrameGrid('neo-director-lf', seg.last_frame, '无（不锁尾帧）');

        // 本段模式（仅全局“混合模式”下显示）：文生 / 图生 / 首尾帧 / 参考主体
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
        const segModeRow = $el('div', { className: 'neo-director-row neo-director-segmode-row' }, [
            $el('label', { className: 'neo-director-field-label', textContent: '本段模式' }), segModeSel,
        ]);

        const segRefRows = SEG_REF_GROUPS.map(g => buildSegRefRow(g, (seg.refs || {})[g.key]));
        const refsBlock = $el('div', { className: 'neo-director-refs-block' }, [
            $el('div', { className: 'neo-director-field-label', textContent: '参考素材（参考生视频技能用：图 / 视频 / 音频）' }),
            segRefRows[0].row,  // 参考图独占一行（最多 9 个，需要更多空间）
            $el('div', { className: 'neo-director-ref-row-pair' }, [
                segRefRows[1].row,  // 参考视频
                segRefRows[2].row,  // 参考音频
            ]),
        ]);

        const row = $el('div', { className: 'neo-director-seg', dataset: { segId: 'seg-' + (++segCounter) } }, [
            $el('div', { className: 'neo-director-seg-head' }, [$el('span', { className: 'neo-director-seg-title', textContent: '段' }), removeBtn]),
            $el('label', { className: 'neo-director-field-label', textContent: '技能（决定模板与模型）' }), skillSel,
            segModeRow,
            $el('label', { className: 'neo-director-field-label', textContent: '提示词（必填）' }), promptTa,
            ffBlock,
            lfBlock,
            refsBlock,
            $el('div', { className: 'neo-director-dur-row' }, [$el('label', { className: 'neo-director-field-label', textContent: '时长（秒）' }), durInp]),
        ]);

        // 本段模式切换 → 刷新该段首帧/尾帧/参考素材区显隐
        segModeSel.addEventListener('change', () => applyGlobalMode());
        row._addCandidate = ffGrid.addCandidate; // 时间轴拖放到该段 → 作为首帧（与首帧网格共用候选）
        segFrameReaders.set(row, { first: ffGrid.getSelected, last: lfGrid.getSelected });
        segRefReaders.set(row, segRefRows.map(r => r.getSelected));
        removeBtn.onclick = () => {
            const idx = Array.from(segsWrap.querySelectorAll('.neo-director-seg')).indexOf(row);
            const wasCurrent = currentSegId === row.dataset.segId;
            row.remove();
            renumberSegs();
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
    function applyGlobalMode() {
        if (!modeSel) return;
        const g = modeSel.value;   // 't2v' | 'i2v' | 'fl2v' | 'r2v' | 'mixed'
        for (const row of segsWrap.querySelectorAll('.neo-director-seg')) {
            const segModeSel = row.querySelector('.neo-director-segmode');
            const ffBlock = row.querySelector('.neo-director-ff-block');
            const lfBlock = row.querySelector('.neo-director-lf-block');
            const modeRow = row.querySelector('.neo-director-segmode-row');
            if (g === 'mixed' && segModeSel) {
                // 首次进入混合：按该段已有的首/尾帧或参考素材初始化本段模式
                if (!row.dataset.modeInit) {
                    const readers = segFrameReaders.get(row) || {};
                    const hasRef = (segRefReaders.get(row) || []).some(read => read().length);
                    const hasLast = !!(readers.last && readers.last());
                    const hasFirst = !!(readers.first && readers.first());
                    if (hasFirst && hasLast) segModeSel.value = 'fl2v';
                    else if (hasFirst) segModeSel.value = 'i2v';
                    else if (hasRef) segModeSel.value = 'r2v';
                    row.dataset.modeInit = '1';
                }
            }
            const eff = (g === 'mixed' && segModeSel) ? segModeSel.value : g;
            if (modeRow) modeRow.style.display = (g === 'mixed') ? '' : 'none';
            if (ffBlock) ffBlock.style.display = (eff === 'i2v' || eff === 'fl2v') ? '' : 'none';
            if (lfBlock) lfBlock.style.display = (eff === 'fl2v') ? '' : 'none';
            const refsBlock = row.querySelector('.neo-director-refs-block');
            if (refsBlock) refsBlock.style.display = (eff === 'r2v') ? '' : 'none';
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
        return { id: row.dataset.segId, duration: Number(durInp.value) || 0, prompt: (promptTa.value || '').trim(), thumbUrl };
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
    };
    // 拖块右缘调时长：写回该段时长输入框（组件内已吸附 0.5s、最小 1s）
    const onResizeSeg = (i, durSec) => {
        const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
        if (!row) return;
        const inp = row.querySelector('.neo-director-dur');
        if (inp) inp.value = String(Math.min(3600, Math.max(1, Number(durSec) || 1)));
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
    const close = () => {
        if (timeline) { try { timeline.destroy(); } catch (_) {} timeline = null; }
        if (overlay && overlay.parentNode) overlay.remove();
        if (_directorEditor && _directorEditor.close === close) _directorEditor = null;
    };
    const saveBtn = $el('button', { className: 'rs-btn neo-director-save', textContent: '保存' });
    const cancelBtn = $el('button', { className: 'rs-btn neo-director-cancel', textContent: '取消', onclick: close });

    saveBtn.onclick = async () => {
        const name = nameInp.value.trim();
        if (!name) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '请填写配方名称', life: 4000 }); return; }
        const gMode = modeSel.value;   // 't2v' | 'i2v' | 'mixed'
        const segments = [];
        for (const row of Array.from(segsWrap.querySelectorAll('.neo-director-seg'))) {
            const skill_id = row.querySelector('.neo-director-skill').value;
            const prompt = row.querySelector('.neo-director-prompt').value.trim();
            if (!skill_id || !prompt) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '每段需选择技能并填写提示词', life: 4000 }); return; }
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
            // 各模式的最低要求（与后端校验一致；连续性链入由节点上的 continuity 决定）
            if ((eff === 'i2v' || eff === 'fl2v') && !seg.first_frame && !seg.refs) {
                app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: `${MODE_LABELS.get(eff)}段需选择首帧图或参考素材`, life: 4000 });
                return;
            }
            if (eff === 'fl2v' && !seg.last_frame) {
                app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '首尾帧生视频段需选择尾帧图', life: 4000 });
                return;
            }
            if (eff === 'r2v' && !seg.refs) {
                app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '参考主体生视频段需挂参考素材（图 / 视频 / 音频）', life: 4000 });
                return;
            }
            segments.push(seg);
        }
        if (!segments.length) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '至少需要一个段', life: 4000 }); return; }
        // 参考视频/音频需进配方 assets 才能在 load_director_spec 里解析成 input 相对名；参考图已在 imageRefs 中
        const assets = imageRefs.slice();
        const assetNames = new Set(assets.map(r => r.filename));
        for (const seg of segments) {
            for (const [key, kind] of [['videos', 'video'], ['audios', 'audio']]) {
                for (const name of ((seg.refs || {})[key] || [])) {
                    if (assetNames.has(name)) continue;
                    assetNames.add(name);
                    assets.push({ filename: name, subfolder: '', type: 'input', kind });
                }
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
                // 自动故事板内容（主题 / 脚本 / 参考图 / 粒度）：随配方落盘，重新打开编辑器回显。
                // 空内容由后端判空后不写入，前端无需分支。
                story: {
                    idea: ideaInp.value.trim() || null,
                    story: storyTa.value.trim() || null,
                    characters: charGrid.getRefs(),
                    backgrounds: bgGrid.getRefs(),
                    segment_seconds: Number(segLenSel.value) || null,
                },
            }, "video");
            if (result.success) {
                app.extensionManager.toast.add({ severity: 'success', summary: '多段导演已保存', detail: `${name}（${segments.length} 段）`, life: 4000 });
                close();
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
    // 📖 故事生成（半自动）：主题→LLM 生成故事→确认拆分填充时间轴；可选角色/背景参考图
    // ==========================================
    function buildRefGrid(initialRefs = []) {
        const grid = $el('div', { className: 'neo-director-refgrid' });
        const selected = new Map(); // filename -> desc
        // 编辑旧配方：先回填已保存的参考图（含描述），使下面按素材建瓷砖时即为选中态
        for (const r of (Array.isArray(initialRefs) ? initialRefs : [])) {
            const fname = (r && r.filename) || '';
            if (fname) selected.set(fname, (r && r.desc) || '');
        }
        const thumbUrl = (ref) => `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder || '')}&type=${ref.type || 'input'}`;
        const ensureInRefs = (fname) => { if (!imageRefs.some(r => r.filename === fname)) imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' }); };
        function makeTile(ref) {
            const descInp = $el('input', { className: 'neo-director-ref-desc', type: 'text', placeholder: '描述（可选）', value: selected.has(ref.filename) ? selected.get(ref.filename) : '' });
            const delBtn = $el('button', { className: 'neo-director-ref-del', title: '移除', textContent: '✕' });
            const tile = $el('div', { className: 'neo-director-ref-item' + (selected.has(ref.filename) ? ' neo-director-ref-active' : ''), dataset: { file: ref.filename } }, [
                $el('img', { className: 'neo-director-ref-thumb', src: thumbUrl(ref), alt: ref.filename, loading: 'lazy' }),
                descInp, delBtn,
            ]);
            tile.onclick = (e) => {
                if (e.target === delBtn || e.target === descInp) return;
                if (selected.has(ref.filename)) selected.delete(ref.filename); else selected.set(ref.filename, '');
                ensureInRefs(ref.filename);
                tile.classList.toggle('neo-director-ref-active', selected.has(ref.filename));
            };
            descInp.onclick = (e) => e.stopPropagation();
            descInp.oninput = () => { if (selected.has(ref.filename)) selected.set(ref.filename, descInp.value.trim()); };
            delBtn.onclick = (e) => { e.stopPropagation(); selected.delete(ref.filename); tile.remove(); };
            return tile;
        }
        for (const r of imageRefs) grid.appendChild(makeTile(r));
        // 已存参考图若不在当前画布素材里，补占位瓷砖（同段首帧的旧配方处理），否则回显会丢
        for (const fname of selected.keys()) {
            if (!Array.from(grid.children).some(el => el.dataset.file === fname)) {
                grid.appendChild(makeTile({ filename: fname, subfolder: '', type: 'input' }));
            }
        }
        grid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; grid.classList.add('neo-director-drop'); });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault(); grid.classList.remove('neo-director-drop');
            const fname = await copyGalleryToInput(grabDataType(e));
            if (!fname) return;
            ensureInRefs(fname);
            selected.set(fname, '');
            grid.appendChild(makeTile({ filename: fname, subfolder: '', type: 'input', kind: 'image' }));
        });
        return { el: grid, getRefs: () => Array.from(selected.entries()).map(([filename, desc]) => ({ filename, desc })) };
    }

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
    const charGrid = buildRefGrid(exStory.characters);
    const bgGrid = buildRefGrid(exStory.backgrounds);
    const setFfChk = $el('input', { className: 'neo-director-setff', type: 'checkbox' });
    const splitBtn = $el('button', { className: 'rs-btn neo-director-split', textContent: '✅ 确认并拆分到时间轴' });

    genBtn.onclick = async () => {
        const idea = ideaInp.value.trim();
        if (!idea) { app.extensionManager.toast.add({ severity: 'error', summary: '故事生成', detail: '请先填写故事主题', life: 4000 }); return; }
        genBtn.disabled = true; storyStatus.textContent = '正在生成故事…';
        try {
            const res = await fetch('/rs_recipes/director_generate_story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea, characters: charGrid.getRefs(), backgrounds: bgGrid.getRefs() }) });
            const data = await res.json();
            if (data.success) { storyTa.value = data.story || ''; storyStatus.textContent = '已生成，可编辑后拆分'; }
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
            const res = await fetch('/rs_recipes/director_split_segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story, segment_seconds: Number(segLenSel.value), characters: charGrid.getRefs(), backgrounds: bgGrid.getRefs() }) });
            const data = await res.json();
            if (!data.success) { storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '拆分失败', detail: data.error || 'Unknown error', life: 5000 }); return; }
            const defaultSkill = skills.length ? skills[0].id : '';
            let ffFile = '';
            if (setFfChk.checked) {
                const bg = bgGrid.getRefs()[0]; const ch = charGrid.getRefs()[0];
                ffFile = (bg && bg.filename) || (ch && ch.filename) || '';
            }
            segsWrap.innerHTML = '';
            for (const s of data.segments) {
                const seg = { skill_id: defaultSkill, prompt: s.prompt, duration_sec: s.duration_sec, mode: ffFile ? 'i2v' : 't2v' };
                if (ffFile) seg.first_frame = ffFile;
                segsWrap.appendChild(buildSeg(seg));
            }
            renumberSegs(); showSeg(0); applyGlobalMode();
            switchTab('timeline'); // 拆分后切到时间轴页查看/微调结果
            storyStatus.textContent = `已拆分 ${data.segments.length} 段，可在下方逐段微调`;
            app.extensionManager.toast.add({ severity: 'success', summary: '已填充时间轴', detail: `${data.segments.length} 段`, life: 4000 });
        } catch (e) {
            console.error('[Neo Recipes] Director: split segments failed', e);
            storyStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: '拆分失败', detail: e.message, life: 5000 });
        } finally { splitBtn.disabled = false; }
    };

    // ---- 两个可切换页签：自动故事板 / 时间轴分段（避免单页过于复杂）----
    const storyboardPane = $el('div', { className: 'neo-director-pane neo-director-pane-story' }, [
        $el('div', { className: 'neo-director-story-idea-row' }, [ideaInp, genBtn]),
        storyTa,
        storyStatus,
        $el('div', { className: 'neo-director-story-refs' }, [
            $el('div', { className: 'neo-director-ref-col' }, [
                $el('label', { className: 'neo-director-field-label', textContent: '角色参考图（可选，点选 / 从左侧素材栏拖入）' }), charGrid.el,
            ]),
            $el('div', { className: 'neo-director-ref-col neo-director-ref-col-bg' }, [
                $el('label', { className: 'neo-director-field-label', textContent: '背景参考图（可选，点选 / 从左侧素材栏拖入）' }), bgGrid.el,
            ]),
        ]),
        $el('div', { className: 'neo-director-story-actions' }, [
            $el('label', { className: 'neo-director-seglen-wrap' }, [$el('span', { textContent: '分段粒度' }), segLenSel]),
            $el('label', { className: 'neo-director-setff-wrap' }, [setFfChk, $el('span', { textContent: '将选中参考图设为各段首帧' })]),
            splitBtn,
        ]),
    ]);

    // 「拉伸」控制条：放在时间轴说明行最右侧（不独占一行），驱动 timeline.setZoom()。
    const zoomSlider = $el('input', { className: 'neo-director-zoom-slider', type: 'range', min: 0.25, max: 4, step: 0.25, value: 1 });
    zoomSlider.addEventListener('input', () => { if (timeline) timeline.setZoom(Number(zoomSlider.value)); });
    const zoomToggle = $el('button', { className: 'neo-director-zoom-toggle', type: 'button', title: '拉伸时间轴', textContent: '🔍 拉伸' });
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
    // 全局生成模式：文生 / 图生 / 首尾帧 / 参考主体 / 混合（决定各段携带哪些帧与参考）。
    // 旧配方无 shared.mode 时按各段内容推断：有尾帧=fl2v、有首帧=i2v、有参考=r2v、全无=t2v、混合=mixed。
    const initMode = (() => {
        if (MODE_LABELS.has(exShared.mode)) return exShared.mode;
        const hasFirst = exSegs.some(s => s && s.first_frame);
        const hasLast = exSegs.some(s => s && s.last_frame);
        const hasRef = exSegs.some(s => s && s.refs && Object.keys(s.refs).length);
        if (hasLast) return 'fl2v';
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
    const tabTimeline = $el('button', { className: 'neo-director-tab', type: 'button', textContent: '🎞️ 时间轴分段' });
    function switchTab(which) {
        const story = which === 'story';
        tabStory.classList.toggle('active', story);
        tabTimeline.classList.toggle('active', !story);
        storyboardPane.style.display = story ? '' : 'none';
        timelinePane.style.display = story ? 'none' : '';
        if (!story && timeline) timeline.refresh(); // 切回时间轴时按真实宽度重绘 canvas
    }
    tabStory.onclick = () => switchTab('story');
    tabTimeline.onclick = () => switchTab('timeline');
    const tabBar = $el('div', { className: 'neo-director-tabs' }, [tabStory, tabTimeline]);

    const body = $el('div', { className: 'neo-director-body' }, [
        tabBar,
        storyboardPane,
        timelinePane,
    ]);
    switchTab('timeline'); // 默认落在时间轴分段页，故事板作为可选页签
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
        $el('span', { textContent: '🎬 多段视频导演' }),
        nameWrap,
        $el('div', { className: 'neo-director-title-btns' }, [
            maxBtn,
            $el('button', { className: 'neo-director-close', textContent: '✕', onclick: close }),
        ]),
    ]);
    const resizeHandle = $el('div', { className: 'neo-director-resize', title: '拖拽调整窗口大小' });
    const panel = $el('div', { className: 'neo-director-panel' }, [titleBar, body, foot, resizeHandle]);

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
        if (e.button !== 0 || e.target.closest('button') || e.target.closest('.neo-director-name-wrap')) return; // ✕ / 配方名区不触发拖动
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
        if (e.target.closest('button') || e.target.closest('.neo-director-name-wrap')) return; // 双击 ⛶ / ✕ / 配方名区不触发放大还原
        toggleMaximize();
    });

    // 右下角手柄拖拽缩放：改面板 width/height（首次同样从居中切到绝对定位）；
    // 宽度下限保证内容不塌，上限钳制在视口内。时间轴经 ResizeObserver 自动跟随重排。
    let resizing = false;
    let rStartMX = 0, rStartMY = 0, rStartW = 0, rStartH = 0;
    const DT_MIN_W = 420, DT_MIN_H = 360; // 高度下限实际由 CSS .neo-director-panel min-height:min(840px,88vh) 强制，此处仅兜底防负数
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
    _directorEditor = { name: requestedName, close, overlay, focusSeg: focusSegAt };
}
