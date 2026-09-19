// NeoH3VideoDirector 节点：在节点内嵌入只读导演时间轴（复用 web/director-timeline.js）。
// 按当前 recipe 下拉值拉取配方 spec，按时长比例绘制分段块 + 秒尺；点击分段块直接打开编辑器（只读，不重排）。
// 采样期间另有一块实时预览面板：后端 h3_preview.py 每步抽多帧、经自有 WS 事件推来，
// 这里自动循环播放该段的动作，并可暂停 / 逐帧 / 逐采样步回看（核心的单图预览通道后端已关掉）。
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { DirectorTimeline } from "./director-timeline.js";
import { openDirectorEditor, DIRECTOR_RECIPE_SAVED_EVENT } from "./director.js";
import { listRecipes } from "./recipes.js";
import { showToast } from "./gallery-utils.js";
import { attachSkillPickerToComboWidget } from "./skill.js";
import { getSkillGenConfig } from "./image-gen.js";

const TL_H = 120; // 节点内时间轴显示区高度（px），canvas 高 TL_H-8=112，与预览卡一致
const ACT_H = 28; // 时间轴下方操作条高度（「＋ 新增导演配方」按钮行）
const PREVIEW_H = 300; // 运行时实时预览面板高度（px）：运行中为面板加高节点，结束还原
const PREVIEW_EVENT = "rs.h3.preview"; // 后端每步推来的多帧载荷（见 h3_preview.py）
const PREVIEW_STEPS = 40; // 保留的采样步数上限，超出丢最旧（每步 PREVIEW_FRAMES 张 JPEG）
const PREVIEW_FPS = 4; // 载荷未带 fps 时的兜底播放帧率（与后端 PREVIEW_FPS 同值）
const H3_FPS = 24; // 与后端 h3_video_director.H3_FPS 同值：skill config 的 length（帧）折算时长（秒）用

// 画布上存活的预览面板：事件按 node_id 路由（node.id 可能被克隆/载入改写，匹配时现读）
const livePreviews = new Set();

function onPreviewEvent(e) {
    const data = e?.detail;
    if (!data || data.node_id == null) return;
    const wanted = String(data.node_id).split(":").pop(); // 子图里的 UNIQUE_ID 形如 "12:7"
    for (const live of livePreviews) {
        if (String(live.node.id) === wanted) live.apply(data);
    }
}

api.addEventListener(PREVIEW_EVENT, onPreviewEvent);

// 选择窗预览卡的配方 spec 缓存：name -> {shared, segments}；配方保存（新建/编辑/重命名）后清空，避免显示旧分段
const _recipeSpecCache = new Map();
async function fetchRecipeSpec(name) {
    if (_recipeSpecCache.has(name)) return _recipeSpecCache.get(name);
    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
    const data = resp.ok ? await resp.json() : null;
    if (data && data.success) { _recipeSpecCache.set(name, data); return data; }
    return null;
}

// 预览卡时间轴实例（只读，与节点内嵌同款组件）：焦点切换 / 选择窗关闭时销毁，避免残留 ResizeObserver
let _previewCardTL = null;
function destroyPreviewTimeline() {
    if (_previewCardTL) { _previewCardTL.destroy(); _previewCardTL = null; }
}
const PREVIEW_TL_H = 112; // 预览卡时间轴高度（与节点内嵌 canvas 同高）
/** 在预览卡里用只读时间轴画出焦点配方的分段（与节点内嵌同款组件、同映射，含首帧缩略图） */
function mountPreviewTimeline(body, segments) {
    body.innerHTML = "";
    if (!segments || !segments.length) { body.textContent = "（无分段）"; return; }
    const box = document.createElement("div");
    body.appendChild(box);
    try {
        _previewCardTL = new DirectorTimeline(box, {
            height: PREVIEW_TL_H,
            readOnly: true,
            getSegments: () => segments.map(s => ({
                // 内容派生身份：与节点内嵌时间轴同配色规则
                id: `${s.prompt || ''}|${Number(s.duration_sec) || 0}|${s.ref_input || ''}`,
                duration: Number(s.duration_sec) || 0,
                prompt: s.prompt || "",
                thumbUrl: s.ref_input ? `/view?filename=${encodeURIComponent(s.ref_input)}&subfolder=&type=input` : null,
            })),
        });
    } catch (e) {
        console.error("[Neo Nodes] recipe preview timeline init failed", e);
        _previewCardTL = null;
        body.textContent = "加载失败";
    }
}

/** 配方选择窗的浮动预览卡（替代技能详情预览）：焦点配方的只读时间轴；点击卡片由 onPreviewClick 打开该配方编辑器 */
function renderRecipePreview(preview, it) {
    destroyPreviewTimeline();
    preview.innerHTML = "";
    if (!it) {
        const hint = document.createElement("div");
        hint.className = "rs-skill-preview-empty";
        hint.textContent = "用 ↑ / ↓ 或悬停浏览配方";
        preview.appendChild(hint);
        return;
    }
    preview.dataset.focusId = it.value;
    const nameEl = document.createElement("div");
    nameEl.className = "rs-skill-preview-name";
    nameEl.textContent = it.label;
    nameEl.title = it.label;
    const body = document.createElement("div");
    body.textContent = "加载中…";
    const hint = document.createElement("div");
    hint.className = "rs-skill-preview-hint";
    hint.textContent = "点击卡片打开配方编辑器";
    preview.append(nameEl, body, hint);
    fetchRecipeSpec(it.value).then((spec) => {
        if (preview.dataset.focusId !== it.value || !preview.isConnected) return; // 焦点已切走或选择窗已关，丢弃过期结果
        mountPreviewTimeline(body, spec ? spec.segments || [] : null);
    }).catch(() => {
        if (preview.dataset.focusId === it.value && preview.isConnected) body.textContent = "加载失败";
    });
}


/**
 * 节点内实时预览面板：每步一段多帧动画，自动循环 + 暂停 / 逐帧 / 逐采样步。
 * 显示用 <img> 换 src 而不是 canvas：不依赖浏览器解码 API（ImageDecoder 只有 Chromium 有），
 * 且每步的帧先 new Image() 预热进图片缓存，换帧不闪。
 * grow() 由调用方提供：首个载荷可能早于 500ms 轮询，先兜一次节点加高。
 */
function createLivePreview(node, box, grow) {
    const img = document.createElement("img");
    img.className = "neo-dtl-live-img";
    img.title = "点击暂停 / 继续";

    const bar = document.createElement("div");
    bar.className = "neo-dtl-live-bar";
    const mkBtn = (cls, text, title) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-dtl-live-btn " + cls;
        btn.textContent = text;
        btn.title = title;
        btn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
        return btn;
    };
    const playBtn = mkBtn("neo-dtl-live-play", "⏸", "暂停动画");
    const framePrev = mkBtn("neo-dtl-live-frame-prev", "⏪", "上一帧（自动暂停）");
    const frameLabel = document.createElement("span");
    frameLabel.className = "neo-dtl-live-label";
    const frameNext = mkBtn("neo-dtl-live-frame-next", "⏩", "下一帧（自动暂停）");
    const stepPrev = mkBtn("neo-dtl-live-step-prev", "◀", "上一个采样步");
    const stepLabel = document.createElement("span");
    stepLabel.className = "neo-dtl-live-label";
    const stepNext = mkBtn("neo-dtl-live-step-next", "▶", "下一个采样步");
    bar.append(stepPrev, stepLabel, stepNext, framePrev, frameLabel, frameNext, playBtn);
    box.append(img, bar);

    let steps = [];   // [{frames:[dataURL...], imgs:[Image...]|null, fps}]
    let sel = -1;     // 当前显示的采样步
    let frame = 0;    // 当前帧
    let playing = true;
    let last = 0;     // 上一帧的时间戳（rAF 时钟）
    let raf = 0;

    const current = () => steps[sel] || null;

    function paint() {
        const step = current();
        if (!step) return;
        if (!step.imgs) {
            step.imgs = step.frames.map((url) => { const pre = new Image(); pre.src = url; return pre; });
            for (const s of steps) { if (s !== step) s.imgs = null; }   // 只留当前步的解码图，别屯内存
        }
        img.src = step.frames[frame] || step.frames[0];
        stepLabel.textContent = `第 ${sel + 1}/${steps.length} 步`;
        frameLabel.textContent = `${frame + 1}/${step.frames.length} 帧`;
    }

    function tick(now) {
        raf = requestAnimationFrame(tick);
        const step = current();
        if (!step || !playing) return;
        if (!last) { last = now; return; }
        if (now - last < 1000 / (step.fps || PREVIEW_FPS)) return;
        last = now;
        frame = (frame + 1) % step.frames.length;
        paint();
    }

    const setPlaying = (on) => {
        playing = on;
        if (on) last = 0;   // 继续播放时不立刻跳帧，从当前帧安稳接着走
        playBtn.textContent = on ? "⏸" : "▶";
        playBtn.title = on ? "暂停动画" : "继续动画";
    };

    function apply(data) {
        if (!Array.isArray(data.frames) || !data.frames.length) return;
        const following = sel < 0 || sel === steps.length - 1;   // 回看旧步时不要被新载荷拽走
        steps.push({ frames: data.frames, imgs: null, fps: Number(data.fps) || PREVIEW_FPS });
        if (steps.length > PREVIEW_STEPS) { steps.shift(); sel -= 1; }
        if (following) { sel = steps.length - 1; frame = 0; }
        else if (sel < 0) sel = 0;
        last = 0;
        box.style.display = "";
        box.style.height = PREVIEW_H + "px";
        grow();
        paint();
        if (!raf) raf = requestAnimationFrame(tick);
    }

    function reset() {
        steps = [];
        sel = -1;
        frame = 0;
        last = 0;
        setPlaying(true);
        img.removeAttribute("src");
        frameLabel.textContent = "";
        stepLabel.textContent = "";
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        box.style.display = "none";
        box.style.height = "0px";
    }

    const shiftStep = (d) => {
        if (!steps.length) return;
        sel = Math.min(steps.length - 1, Math.max(0, sel + d));
        frame = 0;
        last = 0;
        paint();
    };

    const shiftFrame = (d) => {
        const step = current();
        if (!step) return;
        setPlaying(false);   // 逐帧看就是暂停看：停下动画再挪一帧
        frame = (frame + d + step.frames.length) % step.frames.length;
        last = 0;
        paint();
    };

    const onClick = (el, fn) => el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    onClick(playBtn, () => setPlaying(!playing));
    onClick(img, () => setPlaying(!playing));
    onClick(stepPrev, () => shiftStep(-1));
    onClick(stepNext, () => shiftStep(1));
    onClick(framePrev, () => shiftFrame(-1));
    onClick(frameNext, () => shiftFrame(1));

    reset();
    return { node, apply, tick, reset };
}

app.registerExtension({
    name: "NeoH3VideoDirector.Timeline",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoH3VideoDirector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            const root = document.createElement("div");
            root.className = "neo-dtl-node";
            const widget = node.addDOMWidget("director_timeline", "custom", root);
            root.style.width = "100%";
            root.style.maxWidth = "none";

            // 实时预览面板：放在 root 内部（时间轴+操作条下方），与时间轴同属一个 DOM widget，
            // 避免两个独立 widget 之间 LiteGraph 的额外间距。bundle 锁定时只隐藏时间轴行和操作条。
            const previewBox = document.createElement("div");
            previewBox.className = "neo-dtl-live";
            previewBox.style.display = "none";
            previewBox.style.height = "0px";

            // 时间轴显示区（canvas + ✎）；「＋ 新增导演配方」按钮另起一行，位于其下方右下角
            const tlRow = document.createElement("div");
            tlRow.className = "neo-dtl-tlrow";
            root.appendChild(tlRow);

            let tlData = { segments: [] };
            let progress = { active: false, segment_index: -1, total_segments: 0 }; // 当前 director 运行进度（轮询 /neo_video_gen/director_progress）
            let runtimeBaseH = 0; // 节点自然高度（含时间轴+操作条），运行时为采样预览加高后据此还原
            // 后端每步推来的多帧载荷走这里：自动循环播放该步动画，可暂停/逐帧/逐步（见 createLivePreview）
            const live = createLivePreview(node, previewBox, () => {
                // 首个载荷可能早于 500ms 进度轮询，先兜一次加高（幂等）；还原仍由轮询负责
                if (runtimeBaseH > 0 && node.size[1] < runtimeBaseH + PREVIEW_H) node.setSize([node.size[0], runtimeBaseH + PREVIEW_H]);
            });
            node._neoDtLive = live; // 暴露给测试驱动（tick）
            node._neoDtPreviewBox = previewBox; // 暴露给测试定位面板元素
            livePreviews.add(live);
            let tl = null;
            try {
                tl = new DirectorTimeline(tlRow, {
                    height: TL_H - 8,
                    readOnly: true,
                    onSelect: (i) => openEditor(i), // 点击分段块直接打开编辑器，并定位到该段
                    getProgress: () => progress,   // 各段顶部实时显示生成状态（done/current）
                    getSegments: () => (tlData.segments || []).map(s => ({
                        // 内容派生身份：spec 重载后颜色保持稳定（只读预览不重排）
                        id: `${s.prompt || ''}|${Number(s.duration_sec) || 0}|${s.ref_input || ''}`,
                        duration: Number(s.duration_sec) || 0,
                        prompt: s.prompt || "",
                        thumbUrl: s.ref_input ? `/view?filename=${encodeURIComponent(s.ref_input)}&subfolder=&type=input` : null,
                    })),
                });
            } catch (e) {
                console.error("[Neo Nodes] director timeline init failed", e);
            }
            node._neoDtTimeline = tl;

            // 轮询 director 运行进度，状态变化时刷新时间轴（节点存活期间每 500ms 一次；端点为 O(1) dict 读）
            const pollProgress = async () => {
                try {
                    const resp = await api.fetchApi("/neo_video_gen/director_progress");
                    if (!resp.ok) return;
                    const p = await resp.json();
                    const prev = progress;
                    progress = { active: !!p.active, segment_index: Number(p.segment_index) || -1, total_segments: Number(p.total_segments) || 0,
                                 step: Number(p.step) || 0, total_steps: Number(p.total_steps) || 0 };
                    if (progress.active !== prev.active || progress.segment_index !== prev.segment_index || progress.total_segments !== prev.total_segments || progress.step !== prev.step) {
                        tl?.refresh();
                        // 跟随运行：段切换时把正在生成的块横向滚动到可视区（段多/放大时才需要）
                        if (progress.active && progress.segment_index !== prev.segment_index) tl?.revealSeg(progress.segment_index);
                        // 运行结束或换段：预览面板清空重来（每段的采样步各自从第 1 步计数）
                        if (progress.active !== prev.active || progress.segment_index !== prev.segment_index) live.reset();
                        // 运行时为实时预览面板加高预留空间，结束后还原自然高度，避免与时间轴重叠
                        if (progress.active !== prev.active && runtimeBaseH > 0) {
                            node.setSize([node.size[0], progress.active ? runtimeBaseH + PREVIEW_H : runtimeBaseH]);
                        }
                    }
                } catch (_) {}
            };
            node._neoDtProgressTick = pollProgress; // 供测试直接触发
            node._neoDtProgressTimer = setInterval(pollProgress, 500);

            // 宽度随节点缩放同步（LiteGraph 拖拽缩放不检查 min，这里补钳制；最小高度含时间轴）
            const updateSize = () => {
                if (!widget || !node.size) return;
                if (node.minWidth && node.size[0] < node.minWidth) node.size[0] = node.minWidth;
                if (node.minHeight && node.size[1] < node.minHeight) node.size[1] = node.minHeight;
                widget.width = node.size[0];
            };
            node.onResize = node.onResize || function() {};
            const origOnResize = node.onResize;
            node.onResize = function() { updateSize(); origOnResize.apply(this, arguments); };
            updateSize();

            // 节点增高容纳时间轴，并设最小尺寸防止被压缩裁切
            const bw = (node.size && node.size[0]) || 340;
            const bh = (node.size && node.size[1]) || 220;
            node.setSize([Math.max(bw, 340), bh + TL_H + ACT_H]);
            node.minWidth = Math.max(bw, 340);
            node.minHeight = bh + TL_H + ACT_H;
            runtimeBaseH = bh + TL_H + ACT_H; // 记录自然高度，供运行时加高/还原采样预览预留区

            // bundle 连接时由 NeoNodes.BundleLock 调用：隐藏时间轴+操作条并收缩节点高度；断开恢复。
            let tlVisible = true;
            node._neoDtApplyBundleLock = (locked) => {
                const visible = !locked;
                if (visible === tlVisible) return;
                tlVisible = visible;
                tlRow.style.display = visible ? "" : "none";
                actBar.style.display = visible ? "" : "none";
                // bundle 单段模式：隐藏 recipe、显示视频 skill 选择器与时长（秒）；断开恢复
                if (recipeWidget) recipeWidget.hidden = !visible;
                if (skillIdWidget) skillIdWidget.hidden = visible;
                if (durationWidget) durationWidget.hidden = visible;
                runtimeBaseH = bh + (visible ? TL_H + ACT_H : 0);
                node.minHeight = runtimeBaseH;
                node.setSize([node.size[0], runtimeBaseH + (progress.active ? PREVIEW_H : 0)]);
            };

            const recipeWidget = node.widgets?.find(w => w.name === "recipe");
            const skillIdWidget = node.widgets?.find(w => w.name === "skill_id");
            const durationWidget = node.widgets?.find(w => w.name === "duration_sec");
            // 默认（无 bundle）：显示 recipe、隐藏视频 skill 选择器与时长（秒）；连上 BUNDLE 时由 _neoDtApplyBundleLock 互换。
            if (skillIdWidget) skillIdWidget.hidden = true;
            if (durationWidget) durationWidget.hidden = true;
            // duration（秒）跟随 bundle 模式选中的视频 skill：按该 skill config 的 length（帧）折算秒（24fps）。
            // 新建节点按默认 skill 填一次；bundle 模式里切换 skill 时重填。
            // 工作流还原（onConfigure）后已存值优先，初始填充不再覆盖。
            let configured = false;
            const applyDurationFromSkill = async (initial = false) => {
                const name = skillIdWidget ? String(skillIdWidget.value || "") : "";
                if (!name || !durationWidget) return;
                const cfg = await getSkillGenConfig(name);
                if (initial && configured) return; // fetch 期间工作流已完成还原，让位给已存值
                const frames = Number(cfg && cfg.length);
                if (!Number.isFinite(frames) || frames <= 0) return; // config 无 length：保持现值（后端默认 5 秒）
                const seconds = Math.max(1, Math.round(frames / H3_FPS));
                if (durationWidget.value === seconds) return;
                durationWidget.value = seconds;
                durationWidget.callback?.(seconds);
            };
            applyDurationFromSkill(true);
            if (skillIdWidget) {
                const ocSkill = skillIdWidget.callback;
                skillIdWidget.callback = function() { ocSkill?.apply(this, arguments); applyDurationFromSkill(); };
            }
            // continuity / context_frames：暂不开放给用户设置，只在节点上隐藏 widget。
            // 隐藏≠清空：两个 widget 仍占 widgets_values 的位置、值仍随工作流保存并随 prompt 发给后端，
            // 所以新节点走后端默认（连续性开、窗口 22 帧），旧工作流里已存的值照旧生效。
            for (const nm of ["continuity", "context_frames"]) {
                const w = node.widgets?.find((x) => x.name === nm);
                if (w) w.hidden = true;
            }
            // 点击 recipe / skill_id combo → 弹居中选择窗（替代原生下拉）。
            // recipe：仅搜索、无底部工具栏，预览卡显示焦点配方只读时间轴（节点内嵌同款组件）；skill_id：默认技能列表（含管理工具栏）
            const recipeItemsProvider = async (w) => {
                const recipes = (await listRecipes()).filter((r) => r.type === "video_director");
                const allowed = Array.isArray(w?.options?.values) ? w.options.values : null;
                const pool = allowed ? recipes.filter((r) => allowed.includes(r.name)) : recipes;
                return pool.map((r) => ({ value: r.name, label: r.name }));
            };
            if (recipeWidget) attachSkillPickerToComboWidget(recipeWidget, {
                title: "选择导演配方",
                showFooter: false,
                itemsProvider: recipeItemsProvider,
                previewRenderer: renderRecipePreview,
                onPreviewClick: (it) => openEditor(-1, it.value), // 点预览卡直接打开该配方的编辑器
                onClose: destroyPreviewTimeline, // 选择窗关闭时销毁预览卡时间轴实例
            });
            if (skillIdWidget) attachSkillPickerToComboWidget(skillIdWidget, { title: "选择视频技能（H3）" });
            // 按配方首段 skill config 填充 width/height/steps widget。
            // 每个配方有自己的硬性要求（如 VDN/turbo 配方要求 steps=8），所以重新载入配方时一律重新初始化，用户手改值也不保留。
            // 唯一例外是创建节点时的首次载入：工作流已存的实值优先，只在仍为默认 -1 时填充。
            const applyDimDefaults = (d, force) => {
                if (!d) return;
                for (const [nm, val] of [["width", d.width], ["height", d.height], ["steps", d.steps]]) {
                    const w = node.widgets?.find((x) => x.name === nm);
                    if (!w || !Number.isFinite(val)) continue;
                    if (!force && Number(w.value) !== -1) continue;
                    w.value = val;
                    w.callback?.(val);
                }
            };

            // specSeq：loadSpec 并发令牌。工作流还原会先后拉两次（创建时的默认值 + configure 后的还原值），
            // 响应可能交错，旧响应用 seq 判废，不得覆盖新值
            let specSeq = 0;
            const loadSpec = async (force = false) => {
                const seq = ++specSeq;
                const name = recipeWidget ? String(recipeWidget.value || "") : "";
                if (!name) { tlData = { segments: [] }; if (tl) tl.refresh(); return; }
                try {
                    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success && seq === specSeq) { tlData = data; applyDimDefaults(data.defaults, force); if (tl) tl.refresh(); }
                    }
                } catch (e) {
                    console.error("[Neo Nodes] director spec fetch failed", e);
                }
            };
            loadSpec();

            // 切换 recipe 下拉时重新拉取并重新初始化尺寸/步数（本版本 combo widget 用 callback 触发变化，onchange 不存在）
            if (recipeWidget) {
                const oc = recipeWidget.callback;
                recipeWidget.callback = function() { oc?.apply(this, arguments); loadSpec(true); };
            }

            // 配方编辑器保存成功（任意入口：节点「＋/✎」或侧栏新建/编辑）都会广播，据此刷新下拉候选、
            // 必要时重选并重载时间轴。集中在此一处，避免各入口各自刷导致重复拉取 / 选择冲突。
            const onDirectorRecipeSaved = async (e) => {
                const detail = e?.detail || {};
                _recipeSpecCache.clear(); // 配方内容可能已变（新建/编辑/重命名），预览卡不得再用旧 spec
                try {
                    const directors = (await listRecipes()).filter((r) => r.type === "video_director");
                    if (recipeWidget && Array.isArray(recipeWidget.options?.values)) recipeWidget.options.values = directors.map((r) => r.name);
                    if (recipeWidget) {
                        const cur = String(recipeWidget.value || "").trim();
                        const stillThere = directors.some((r) => r.name === cur);
                        // 新建：选中刚保存的配方；编辑后当前值失效（如重命名）：落到第一个有效项
                        if (detail.created || !stillThere) {
                            recipeWidget.value = (detail.name && directors.some((r) => r.name === detail.name)) ? detail.name : (directors[0]?.name ?? "");
                        }
                    }
                } catch (_) {}
                await loadSpec(true);
            };
            node._neoDtOnRecipeSaved = onDirectorRecipeSaved;
            window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, onDirectorRecipeSaved);

            // 时间轴右上角「✎」：打开当前配方的导演编辑器，保存后自动刷新时间轴；
            // 点击分段块时带上该段索引（segIndex），编辑器打开即定位到被点的段；
            // nameOverride 供选择窗预览卡点击直接打开焦点配方（而非当前选中值）
            const openEditor = async (segIndex = -1, nameOverride = "") => {
                const name = nameOverride || (recipeWidget ? String(recipeWidget.value || "").trim() : "");
                if (!name) { showToast(app, "warn", "请先选择分段配方", ""); return; }
                editBtn.disabled = true;
                try {
                    const metas = await listRecipes();
                    const meta = metas.find((r) => r.name === name);
                    if (!meta || meta.type !== "video_director") {
                        showToast(app, "warn", "未找到分段配方：" + name, "");
                        return;
                    }
                    await openDirectorEditor(meta, null, segIndex);
                } catch (e) {
                    console.error("[Neo Nodes] open director editor failed", e);
                    showToast(app, "error", "打开配方编辑器失败", String(e));
                } finally {
                    editBtn.disabled = false;
                }
            };
            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "neo-dtl-edit";
            editBtn.title = "编辑分段配方";
            editBtn.textContent = "✎";
            editBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            editBtn.addEventListener("click", (e) => { e.stopPropagation(); openEditor(); });
            tlRow.appendChild(editBtn);

            // 时间轴左侧「👁」实时预览开关：与节点输入 preview（BOOLEAN）双向同步，随工作流保存。
            // 开（默认）= 采样期间用 taeh3 真彩预览；关 = 本次生成完全不出预览（不受全局预览设置影响）。
            const previewWidget = node.widgets?.find(w => w.name === "preview");
            const previewBtn = document.createElement("button");
            previewBtn.type = "button";
            previewBtn.className = "neo-dtl-preview";
            previewBtn.textContent = "👁";
            const syncPreviewBtn = () => {
                const on = previewWidget ? !!previewWidget.value : true;
                previewBtn.classList.toggle("neo-dtl-preview-on", on);
                previewBtn.title = on ? "节点内实时预览：开（taeh3 真彩，≤1024）" : "节点内实时预览：关（采样期间不出预览）";
            };
            previewBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            previewBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!previewWidget) return;
                previewWidget.value = !previewWidget.value;
                previewWidget.callback?.(previewWidget.value);
                syncPreviewBtn();
            });
            if (previewWidget) {
                const origPreviewCallback = previewWidget.callback;
                previewWidget.callback = function() { origPreviewCallback?.apply(this, arguments); syncPreviewBtn(); };
            }
            syncPreviewBtn();
            tlRow.insertBefore(previewBtn, tlRow.firstChild);

            // 工作流还原按 widgets_values 直接写 value、不触发 callback，故在 configure 后补一次同步：
            // 预览按钮态 + 按还原后的 recipe 重拉 spec（onNodeCreated 的首次拉取用的是还原前的默认值，
            // 不补这一次时间轴就会停在默认配方的分段上）
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function() {
                const r = origOnConfigure?.apply(this, arguments);
                configured = true; // 此后已存 widgets_values 优先：初始的时长按 skill 填充不再覆盖
                syncPreviewBtn();
                loadSpec();
                return r;
            };

            // 时间轴显示区外右下角「＋ 新增导演配方」：打开新建模式编辑器；保存后由 DIRECTOR_RECIPE_SAVED_EVENT 统一刷新下拉并选中新配方
            const actBar = document.createElement("div");
            actBar.className = "neo-dtl-actbar";
            const newBtn = document.createElement("button");
            newBtn.type = "button";
            newBtn.className = "neo-dtl-new";
            newBtn.title = "新建多段视频导演配方";
            newBtn.textContent = "＋ 新增导演配方";
            newBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            newBtn.addEventListener("click", (e) => { e.stopPropagation(); openDirectorEditor(null); });
            actBar.appendChild(newBtn);
            root.appendChild(actBar);
            root.appendChild(previewBox);
            return result;
        };

        nodeType.prototype.onRemoved = function() {
            if (this._neoDtProgressTimer) { clearInterval(this._neoDtProgressTimer); this._neoDtProgressTimer = null; }
            if (this._neoDtTimeline) { try { this._neoDtTimeline.destroy(); } catch (_) {} this._neoDtTimeline = null; }
            if (this._neoDtLive) { this._neoDtLive.reset(); livePreviews.delete(this._neoDtLive); this._neoDtLive = null; }
            if (this._neoDtOnRecipeSaved) { window.removeEventListener(DIRECTOR_RECIPE_SAVED_EVENT, this._neoDtOnRecipeSaved); this._neoDtOnRecipeSaved = null; }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
