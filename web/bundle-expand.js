// NeoBundleExpand 节点：在节点内只读展示 BUNDLE 展开结果（提示词 + 参考图缩略图网格，编号对应输出 image_1..image_N）。
// 数据来自后端 expand() 返回的 ui payload（{"prompt":[...], "images":[dataURI|null,...]}），经 node.onExecuted 送达。
import { app } from "../../../../scripts/app.js";
import { Lightbox } from "./lightbox.js";

if (!document.getElementById("neo-be-css")) {
    const link = document.createElement("link");
    link.id = "neo-be-css";
    link.rel = "stylesheet";
    link.href = "/extensions/ComfyUI-Neo-Nodes/bundle-expand.css";
    document.head.appendChild(link);
}

// ui 值经核心 get_output_from_returns 展平为列表（裸字符串会被逐字符拆开），这里把 prompt 还原成显示文本。
function asText(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.join("");
    return String(v);
}

const MIN_HEIGHT = 70;

function makeLabel(icon, text, count) {
    const label = document.createElement("div");
    label.className = "neo-be-label";
    const ic = document.createElement("span");
    ic.textContent = icon;
    label.appendChild(ic);
    const t = document.createElement("span");
    t.textContent = text;
    label.appendChild(t);
    if (count != null) {
        const c = document.createElement("span");
        c.className = "neo-be-count";
        c.textContent = `(${count})`;
        label.appendChild(c);
    }
    return label;
}

function renderView(node, root, output) {
    root.innerHTML = "";
    const prompt = asText(output && output.prompt);
    const images = (output && Array.isArray(output.images)) ? output.images : [];

    // 提示词区
    root.appendChild(makeLabel("💬", "提示词"));
    const promptBox = document.createElement("div");
    promptBox.className = "neo-be-prompt";
    if (prompt) {
        promptBox.textContent = prompt;
    } else {
        promptBox.classList.add("neo-be-prompt-empty");
        promptBox.textContent = "（无提示词）";
    }
    root.appendChild(promptBox);

    // 参考图区：编号对应 image_N 输出槽位；坏参考槽位为 null，跳过显示但保留槽位编号。
    const validCount = images.filter(u => u).length;
    root.appendChild(makeLabel("🖼️", "参考图", validCount || null));

    if (validCount) {
        const grid = document.createElement("div");
        grid.className = "neo-be-grid";
        const lightboxItems = [];
        images.forEach((url, i) => {
            if (!url) return;  // 坏参考槽位：不显示，但后续编号仍按槽位 i+1
            lightboxItems.push({ kind: "image", url, title: `image_${i + 1}` });
            const cell = document.createElement("div");
            cell.className = "neo-be-cell";
            const badge = document.createElement("span");
            badge.className = "neo-be-badge";
            badge.textContent = String(i + 1);  // 对应 image_{i+1} 输出槽位
            const img = document.createElement("img");
            img.className = "neo-be-thumb";
            img.src = url;
            img.alt = `image_${i + 1}`;
            img.title = `image_${i + 1}`;
            const idx = lightboxItems.length - 1;
            img.addEventListener("click", () => Lightbox.open({ items: lightboxItems, index: idx }));
            cell.appendChild(badge);
            cell.appendChild(img);
            grid.appendChild(cell);
        });
        root.appendChild(grid);
    } else {
        const none = document.createElement("div");
        none.className = "neo-be-none";
        none.textContent = "无参考图";
        root.appendChild(none);
    }

    // 下一帧测量，确保缩略图（aspect-ratio 占位）与提示词布局完成后高度准确。
    requestAnimationFrame(() => fitNode(node, root));
}

// 执行后按内容实际高度设置节点尺寸；widget.y 给出 DOM widget 在节点内的真实 Y 偏移（含标题栏 + 前置 widget 行）。
// 仅在 onExecuted → renderView 后调用一次，不干扰用户后续手动缩放。
function fitNode(node, root) {
    const w = node.size ? node.size[0] : 320;
    const contentH = root.scrollHeight;
    const widgetY = node._neoBeWidget?.y ?? 40;
    const h = widgetY + contentH + 8;  // +8 底部内边距
    node.setSize([w, Math.max(h, MIN_HEIGHT)]);
}

app.registerExtension({
    name: "NeoBundleExpand.Display",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoBundleExpand") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const root = document.createElement("div");
            root.className = "neo-be-view";
            const hint = document.createElement("div");
            hint.className = "neo-be-hint";
            hint.textContent = "等待执行…（运行后显示提示词与参考图）";
            root.appendChild(hint);

            // getMinHeight 给 ComfyUI DOMWidgetImpl 一个最小高度下限；不传 getHeight 以免锁定节点高度、阻止用户缩短。
            const widget = this.addDOMWidget("bundle_view", "custom", root, {
                margin: 4,
                getMinHeight: () => 30,
            });
            this._neoBeWidget = widget;
            this._neoBeRoot = root;
            root.style.width = "100%";
            root.style.maxWidth = "none";
            this.setSize([320, MIN_HEIGHT]);
            return result;
        };

        nodeType.prototype.onExecuted = function(output) {
            if (this._neoBeRoot) renderView(this, this._neoBeRoot, output);
        };

        nodeType.prototype.onRemoved = function() {
            this._neoBeRoot = null;
            this._neoBeWidget = null;
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
