// NeoH3VideoDirector 节点：在节点内嵌入只读导演时间轴（复用 web/director-timeline.js）。
// 按当前 recipe 下拉值拉取配方 spec，按时长比例绘制分段块 + 秒尺；点击分段块直接打开编辑器（只读，不重排）。
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { DirectorTimeline } from "./director-timeline.js";
import { openDirectorEditor } from "./director.js";
import { listRecipes } from "./recipes.js";
import { showToast } from "./gallery-utils.js";

const TL_H = 96; // 节点内时间轴显示区高度（px）
const ACT_H = 28; // 时间轴下方操作条高度（「＋ 新增导演配方」按钮行）
const PREVIEW_H = 300; // 运行时采样预览预留高度：ComfyUI 内置采样组件在节点内显示实时预览，运行中为其加高预留空间，避免与时间轴重叠

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
            root.style.height = (TL_H + ACT_H) + "px";

            // 时间轴显示区（canvas + ✎）；「＋ 新增导演配方」按钮另起一行，位于其下方右下角
            const tlRow = document.createElement("div");
            tlRow.className = "neo-dtl-tlrow";
            root.appendChild(tlRow);

            let tlData = { segments: [] };
            let progress = { active: false, segment_index: -1, total_segments: 0 }; // 当前 director 运行进度（轮询 /neo_video_gen/director_progress）
            let runtimeBaseH = 0; // 节点自然高度（含时间轴+操作条），运行时为采样预览加高后据此还原
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
                    progress = { active: !!p.active, segment_index: Number(p.segment_index) || -1, total_segments: Number(p.total_segments) || 0 };
                    if (progress.active !== prev.active || progress.segment_index !== prev.segment_index || progress.total_segments !== prev.total_segments) {
                        tl?.refresh();
                        // 跟随运行：段切换时把正在生成的块横向滚动到可视区（段多/放大时才需要）
                        if (progress.active && progress.segment_index !== prev.segment_index) tl?.revealSeg(progress.segment_index);
                        // 运行时为 ComfyUI 内置采样预览加高预留空间，结束后还原自然高度，避免预览与时间轴重叠
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
                root.style.display = visible ? "" : "none";
                runtimeBaseH = bh + (visible ? TL_H + ACT_H : 0);
                node.minHeight = runtimeBaseH;
                node.setSize([node.size[0], runtimeBaseH + (progress.active ? PREVIEW_H : 0)]);
            };

            const recipeWidget = node.widgets?.find(w => w.name === "recipe");
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

            const loadSpec = async (force = false) => {
                const name = recipeWidget ? String(recipeWidget.value || "") : "";
                if (!name) { tlData = { segments: [] }; if (tl) tl.refresh(); return; }
                try {
                    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success) { tlData = data; applyDimDefaults(data.defaults, force); if (tl) tl.refresh(); }
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

            // 时间轴右上角「✎」：打开当前配方的导演编辑器，保存后自动刷新时间轴；
            // 点击分段块时带上该段索引（segIndex），编辑器打开即定位到被点的段
            const openEditor = async (segIndex = -1) => {
                const name = recipeWidget ? String(recipeWidget.value || "").trim() : "";
                if (!name) { showToast(app, "warn", "请先选择分段配方", ""); return; }
                editBtn.disabled = true;
                try {
                    const metas = await listRecipes();
                    const meta = metas.find((r) => r.name === name);
                    if (!meta || meta.type !== "video_director") {
                        showToast(app, "warn", "未找到分段配方：" + name, "");
                        return;
                    }
                    await openDirectorEditor(meta, () => loadSpec(true), segIndex);
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

            // 工作流还原按 widgets_values 直接写 value、不触发 callback，故在 configure 后补一次同步
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function() {
                const r = origOnConfigure?.apply(this, arguments);
                syncPreviewBtn();
                return r;
            };

            // 时间轴显示区外右下角「＋ 新增导演配方」：打开新建模式编辑器；保存后把新配方加入下拉并选中、重载时间轴
            const openNewRecipe = async () => {
                let priorNames = new Set();
                try { priorNames = new Set((await listRecipes()).filter((r) => r.type === "video_director").map((r) => r.name)); } catch (_) {}
                await openDirectorEditor(null, async () => {
                    try {
                        const directors = (await listRecipes()).filter((r) => r.type === "video_director");
                        if (recipeWidget && Array.isArray(recipeWidget.options?.values)) recipeWidget.options.values = directors.map((r) => r.name);
                        const fresh = directors.find((r) => !priorNames.has(r.name));
                        if (fresh && recipeWidget) recipeWidget.value = fresh.name;
                    } catch (_) {}
                    await loadSpec(true);
                });
            };
            const actBar = document.createElement("div");
            actBar.className = "neo-dtl-actbar";
            const newBtn = document.createElement("button");
            newBtn.type = "button";
            newBtn.className = "neo-dtl-new";
            newBtn.title = "新建多段视频导演配方";
            newBtn.textContent = "＋ 新增导演配方";
            newBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            newBtn.addEventListener("click", (e) => { e.stopPropagation(); openNewRecipe(); });
            actBar.appendChild(newBtn);
            root.appendChild(actBar);
            return result;
        };

        nodeType.prototype.onRemoved = function() {
            if (this._neoDtProgressTimer) { clearInterval(this._neoDtProgressTimer); this._neoDtProgressTimer = null; }
            if (this._neoDtTimeline) { try { this._neoDtTimeline.destroy(); } catch (_) {} this._neoDtTimeline = null; }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
