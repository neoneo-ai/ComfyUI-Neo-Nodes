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
    let imageRefs = [];
    try {
        const { media } = await scanMediaNodes();
        imageRefs = media.filter(s => s.kind === 'image' && s.slot != null)
            .map(s => widgetValueToRef(s.value)).filter(Boolean);
    } catch (e) { console.error('[Neo Recipes] Director: collect images failed', e); }

    let skills = [];
    try { skills = await listVideoSkills(); } catch (e) {}

    const exShared = (existing && existing.shared) || {};
    const exSegs = (existing && Array.isArray(existing.segments)) ? existing.segments : [];
    const exStory = (existing && existing.story) || {};   // 自动故事板内容（主题/脚本/参考图/粒度），编辑旧配方时回显
    let segCounter = 0; // 段身份计数：时间轴颜色按段内容绑定，重排不变色

    function buildSeg(seg = {}) {
        const skillSel = $el('select', { className: 'neo-director-skill' });
        if (!skills.length) skillSel.appendChild($el('option', { value: '', textContent: '（无可用视频技能）' }));
        for (const s of skills) skillSel.appendChild($el('option', { value: s.id, textContent: s.name || s.id }));
        if (seg.skill_id) skillSel.value = seg.skill_id;

        const promptTa = $el('textarea', { className: 'neo-director-prompt', placeholder: '该段画面 / 运动描述（必填）', value: seg.prompt || '' });
        const durInp = $el('input', { className: 'neo-director-dur', type: 'number', min: 1, max: 3600, value: (seg.duration_sec != null ? seg.duration_sec : 5) });

        // 首帧候选网格：「无（文生视频）」+ 已连线 LoadImage 缩略图，单选；
        // 编辑旧配方时若 first_frame 指向当前未连线的文件，补占位项以免保存时被丢弃
        const ffThumbUrl = (ref) => `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder || '')}&type=${ref.type || 'input'}`;
        const candidates = imageRefs.slice();
        if (seg.first_frame && !candidates.some(r => r.filename === seg.first_frame)) {
            candidates.unshift({ filename: seg.first_frame, subfolder: '', type: 'input' });
        }
        const ffGrid = $el('div', { className: 'neo-director-ff-grid' });
        const noneTile = $el('div', { className: 'neo-director-ff-item', title: '无（文生视频）' }, [
            $el('div', { className: 'neo-director-ff-thumb neo-director-ff-thumb-empty', textContent: '🎬' }),
            $el('div', { className: 'neo-director-ff-name', textContent: '无（文生视频）' })
        ]);
        ffGrid.appendChild(noneTile);

        const selectFf = (value) => {
            for (const it of Array.from(ffGrid.children)) {
                it.classList.toggle('neo-director-ff-active', (it === noneTile) ? value === '' : it.dataset.file === value);
            }
        };
        // 移除素材格（✕）：从网格删除；若为当前选中项则回落到「无」；
        // 该文件不再被任何段引用时，同时从 imageRefs（保存资产）中清理
        const removeFf = (tile) => {
            const fname = tile.dataset.file;
            const wasActive = tile.classList.contains('neo-director-ff-active');
            tile.remove();
            if (wasActive) selectFf('');
            if (!fname) return;
            const stillUsed = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))
                .some(row => Array.from(row.querySelectorAll('.neo-director-ff-item')).some(it => it.dataset.file === fname));
            if (!stillUsed) {
                const idx = imageRefs.findIndex(r => r.filename === fname);
                if (idx >= 0) imageRefs.splice(idx, 1);
            }
        };
        const makeFfTile = (ref) => {
            const delBtn = $el('button', { className: 'neo-director-ff-del', title: '移除该素材', textContent: '✕' });
            const tile = $el('div', { className: 'neo-director-ff-item', title: ref.filename, dataset: { file: ref.filename } }, [
                $el('img', { className: 'neo-director-ff-thumb', src: ffThumbUrl(ref), alt: ref.filename, loading: 'lazy' }),
                $el('div', { className: 'neo-director-ff-name', textContent: ref.filename }),
                delBtn,
            ]);
            delBtn.onclick = (e) => { e.stopPropagation(); removeFf(tile); };
            // 点选切换：已选中再点一次即取消（回落到「无 / 文生视频」）
            tile.onclick = () => selectFf(tile.classList.contains('neo-director-ff-active') ? '' : ref.filename);
            return tile;
        };
        // 把素材加入本段候选并选中（时间轴拖放 / 网格拖放 / 画布素材共用）
        const addCandidate = (fname) => {
            if (!imageRefs.some(r => r.filename === fname)) {
                imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
            }
            let tile = Array.from(ffGrid.children).find(it => it.dataset.file === fname);
            if (!tile) {
                tile = makeFfTile({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
                ffGrid.appendChild(tile);
            }
            selectFf(fname);
        };
        for (const r of candidates) ffGrid.appendChild(makeFfTile(r));
        selectFf(seg.first_frame || '');

        // 从左侧 Neo Gallery（或画布网格）拖入图片 → 落到 input/ 并设为该段首帧
        const acceptGalleryDrop = async (e) => {
            e.preventDefault();
            ffGrid.classList.remove('neo-director-drop');
            const raw = grabDataType(e);
            const fname = await copyGalleryToInput(raw);
            if (fname) addCandidate(fname);
        };
        ffGrid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; ffGrid.classList.add('neo-director-drop'); });
        ffGrid.addEventListener('dragleave', (e) => { if (!ffGrid.contains(e.relatedTarget)) ffGrid.classList.remove('neo-director-drop'); });
        ffGrid.addEventListener('drop', acceptGalleryDrop);

        const removeBtn = $el('button', { className: 'neo-director-seg-del', title: '删除该段', textContent: '🗑' });
        const row = $el('div', { className: 'neo-director-seg', dataset: { segId: 'seg-' + (++segCounter) } }, [
            $el('div', { className: 'neo-director-seg-head' }, [$el('span', { className: 'neo-director-seg-title', textContent: '段' }), removeBtn]),
            $el('label', { className: 'neo-director-field-label', textContent: '技能（决定模板与模型）' }), skillSel,
            $el('label', { className: 'neo-director-field-label', textContent: '提示词（必填）' }), promptTa,
            $el('div', { className: 'neo-director-ff-row' }, [
                $el('label', { className: 'neo-director-field-label', textContent: '首帧图（点选或从左侧素材栏拖入；不选 = 文生视频）' }),
                $el('button', {
                    className: 'neo-director-ff-lib',
                    title: '打开/收起左侧素材面板',
                    onclick: () => toggleGallerySidebar(),
                }, [
                    $el('i', { className: 'pi pi-images' }),
                    $el('span', { textContent: '素材库' }),
                ]),
            ]),
            ffGrid,
            $el('div', { className: 'neo-director-dur-row' }, [$el('label', { className: 'neo-director-field-label', textContent: '时长（秒）' }), durInp]),
        ]);
        row._addCandidate = addCandidate; // 供时间轴拖放到该段时复用
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
    // 定位到指定段（节点时间轴上被点击的那一段）；未指定时仍默认显示第 1 段
    const focusSegAt = (i) => { const n = Number(i); if (Number.isFinite(n) && n >= 0) showSeg(n); };
    focusSegAt(focusSeg >= 0 ? focusSeg : 0);
    const addBtn = $el('button', { className: 'rs-btn neo-director-add', textContent: '＋ 添加段', onclick: () => { segsWrap.appendChild(buildSeg({})); renumberSegs(); showSeg(segsWrap.children.length - 1); } });

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
            onAdd: () => { segsWrap.appendChild(buildSeg({})); renumberSegs(); showSeg(segsWrap.children.length - 1); },
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
        const segments = [];
        for (const row of Array.from(segsWrap.querySelectorAll('.neo-director-seg'))) {
            const skill_id = row.querySelector('.neo-director-skill').value;
            const prompt = row.querySelector('.neo-director-prompt').value.trim();
            if (!skill_id || !prompt) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '每段需选择技能并填写提示词', life: 4000 }); return; }
            const seg = {
                skill_id, prompt,
                duration_sec: Number(row.querySelector('.neo-director-dur').value) || null,
            };
            const activeFf = row.querySelector('.neo-director-ff-item.neo-director-ff-active');
            const ff = (activeFf && activeFf.dataset.file) ? activeFf.dataset.file : '';
            if (ff) seg.first_frame = ff;
            segments.push(seg);
        }
        if (!segments.length) { app.extensionManager.toast.add({ severity: 'error', summary: '多段导演', detail: '至少需要一个段', life: 4000 }); return; }
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
            const result = await saveRecipe(name, '', imageRefs, [], [], {
                shared: custom
                    ? { width: outW, height: outH, aspect_ratio: DIRECTOR_CUSTOM }
                    : { width: outW, height: outH, aspect_ratio: aspectSel.value, megapixels: directorClampMp(mpInp.value) },
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
                const seg = { skill_id: defaultSkill, prompt: s.prompt, duration_sec: s.duration_sec };
                if (ffFile) seg.first_frame = ffFile;
                segsWrap.appendChild(buildSeg(seg));
            }
            renumberSegs(); showSeg(0);
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
    const timelinePane = $el('div', { className: 'neo-director-pane neo-director-pane-timeline' }, [
        $el('div', { className: 'neo-director-row neo-director-shared' }, [
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
