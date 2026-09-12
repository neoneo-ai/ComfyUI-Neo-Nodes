// NeoH3VideoDirector 节点：在节点内嵌入只读导演时间轴（复用 web/director-timeline.js）。
// 按当前 recipe 下拉值拉取配方 spec，按时长比例绘制分段块 + 秒尺；点击仅高亮（只读，不重排）。
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { DirectorTimeline } from "./director-timeline.js";
import { openDirectorEditor, listRecipes } from "./recipes.js";
import { showToast } from "./gallery-utils.js";

const TL_H = 96; // 节点内时间轴容器高度（px）

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
            root.style.height = TL_H + "px";

            let tlData = { segments: [] };
            let tl = null;
            try {
                tl = new DirectorTimeline(root, {
                    height: TL_H - 8,
                    readOnly: true,
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
            node.setSize([Math.max(bw, 340), bh + TL_H]);
            node.minWidth = Math.max(bw, 340);
            node.minHeight = bh + TL_H;

            const recipeWidget = node.widgets?.find(w => w.name === "recipe");
            const loadSpec = async () => {
                const name = recipeWidget ? String(recipeWidget.value || "") : "";
                if (!name) { tlData = { segments: [] }; if (tl) tl.refresh(); return; }
                try {
                    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success) { tlData = data; if (tl) tl.refresh(); }
                    }
                } catch (e) {
                    console.error("[Neo Nodes] director spec fetch failed", e);
                }
            };
            loadSpec();

            // 切换 recipe 下拉时重新拉取
            if (recipeWidget && typeof recipeWidget.onchange === "function") {
                const oc = recipeWidget.onchange;
                recipeWidget.onchange = function() { oc.apply(this, arguments); loadSpec(); };
            }

            // 时间轴右上角「✎」：打开当前配方的导演编辑器，保存后自动刷新时间轴
            const openEditor = async () => {
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
                    await openDirectorEditor(meta, () => loadSpec());
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
            root.appendChild(editBtn);
            return result;
        };

        nodeType.prototype.onRemoved = function() {
            if (this._neoDtTimeline) { try { this._neoDtTimeline.destroy(); } catch (_) {} this._neoDtTimeline = null; }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
