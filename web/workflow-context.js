/**
 * workflow-context.js
 * 生成前自动采集工作流上下文（MiniMax H3 视频参数 + 上游叶子媒体），
 * 随 LLM/skill 请求一并传给后端注入系统提示词；参考图本身不上传，
 * 由 skill 代理通过 get_reference_image 工具按需取回。
 */

// MiniMax H3 节点类型（comfy_extras/nodes_minimax_h3.py）
const H3_NODE_TYPES = [
    "EmptyMiniMaxH3LatentAV",
    "MiniMaxH3ImageToVideo",
    "MiniMaxH3ReferenceToVideo",
];

// H3 节点需要上报的 widget（按名称匹配 widgets_values 快照，缺失即跳过）
const H3_WIDGETS = ["width", "height", "length", "ref_image_size"];

const MAX_REFERENCES = 9;
const PROBE_TIMEOUT_MS = 2500;

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

function aspectRatio(w, h) {
    if (!w || !h) return "";
    const g = gcd(w, h);
    return `${Math.round((w / g) * 100) / 100}:${Math.round((h / g) * 100) / 100}`;
}

function widgetValue(node, name) {
    for (const w of node.widgets || []) {
        if (w?.name === name && w.value != null) return w.value;
    }
    return undefined;
}

// 叶子媒体节点 -> {kind:"image"|"video", value:filename}；无文件名返回 null
function leafMediaSource(node) {
    const candidates = [
        ...(node.widgets || []).map(w => w?.value),
        ...(node.widgets_values || []),
    ];
    for (const c of candidates) {
        let v = "";
        if (typeof c === "string") v = c.trim();
        else if (Array.isArray(c)) v = String(c[0] ?? "").trim();
        else if (c && typeof c === "object") v = String(c.name ?? c.filename ?? "").trim();
        if (!v) continue;
        if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(v)) return { kind: "image", value: v };
        if (/\.(mp4|mov|webm|mkv|avi)$/i.test(v)) return { kind: "video", value: v };
    }
    return null;
}

// 沿输入链回溯到叶子媒体节点（如 LoadImage / LoadVideo），带深度上限防环
function backtraceLeaf(graph, node) {
    let cur = node;
    for (let depth = 0; depth < 8 && cur; depth++) {
        const src = leafMediaSource(cur);
        if (src) return { ...src, nodeType: cur.type };
        let next = null;
        for (const inp of cur.inputs || []) {
            if (inp.link == null) continue;
            const links = graph.links;
            const link = typeof links?.get === "function" ? links.get(inp.link) : links?.[inp.link];
            if (!link) continue;
            next = graph.getNodeById(link.origin_id);
            break;
        }
        cur = next;
    }
    return null;
}

// 取节点指定输入的上游节点（无连线返回 undefined）；兼容 links 为 Map 或数组
function inputSource(graph, node, inputName) {
    const inp = (node?.inputs || []).find(i => i.name === inputName);
    if (!inp?.link) return undefined;
    const links = graph.links;
    const link = typeof links?.get === "function" ? links.get(inp.link) : links?.[inp.link];
    return link ? graph.getNodeById(link.origin_id) : undefined;
}

// 取节点第一个有连线输入的上游（用于穿透 GetNode 等代理节点）
function firstLinkedSource(graph, node) {
    for (const inp of node?.inputs || []) {
        if (inp.link == null) continue;
        const links = graph.links;
        const link = typeof links?.get === "function" ? links.get(inp.link) : links?.[inp.link];
        if (link) return graph.getNodeById(link.origin_id);
    }
    return undefined;
}

// 读数值型 widget（PrimitiveFloat/Int 等）
function numericWidget(node) {
    for (const w of node?.widgets || []) {
        const n = Number(w.value);
        if (isFinite(n)) return n;
    }
    for (const v of node?.widgets_values || []) {
        if (typeof v === "number" && isFinite(v)) return v;
    }
    return undefined;
}

// 回溯 H3 节点 length(帧数) 输入，解析出真实时长（秒）。
// 常见链路：length ← ComfyMathExpression(公式 a*24→帧) ← PrimitiveFloat(a=秒)。
// 只识别能确定"秒"的结构；无法确定时返回 undefined，后端回退 length/24。
function resolveDurationSeconds(graph, node) {
    let cur = inputSource(graph, node, "length");
    const seen = new Set();
    for (let d = 0; d < 6 && cur; d++) {
        if (seen.has(cur.id)) return undefined;
        seen.add(cur.id);
        if ((cur.type || "") === "ComfyMathExpression") {
            // 秒数喂给变量 a（公式里 a*24 → 帧）
            const a = inputSource(graph, cur, "values.a");
            if (a) {
                const v = numericWidget(a);
                if (isFinite(v)) return v;
            }
            return undefined;
        }
        // 穿透单输入代理（GetNode 等）；其余结构不猜，直接放弃
        cur = firstLinkedSource(graph, cur);
    }
    return undefined;
}

// 解析 H3 节点有效画布比例 "W:H"：优先回溯 width 输入上游——ResolutionSelector 的
// aspect_ratio combo 直接是比例预设（如 "16:9 (Widescreen)"），数值型上游取前两个数字当 w/h；
// 否则退回 H3 自身 width/height widget。无法判定返回 ""。参考图不决定画布，故不参与。
function resolveCanvasAspect(graph, node) {
    const wsrc = inputSource(graph, node, "width");
    if (wsrc) {
        const ar = widgetValue(wsrc, "aspect_ratio");
        if (typeof ar === "string") {
            const m = ar.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
            if (m) return `${m[1]}:${m[2]}`;
        }
        const nums = [];
        for (const v of [...(wsrc.widgets || []).map(w => w?.value), ...(wsrc.widgets_values || [])]) {
            if (typeof v === "number" && isFinite(v) && v > 0) nums.push(v);
        }
        if (nums.length >= 2) return aspectRatio(nums[0], nums[1]);
    }
    const w = Number(widgetValue(node, "width"));
    const h = Number(widgetValue(node, "height"));
    if (isFinite(w) && isFinite(h)) return aspectRatio(w, h);
    return "";
}

// 用 <img> 探测图片尺寸（仅取 naturalWidth/Height，失败返回 null）；目录判定与后端 _read_image_raw 一致
function probeImageSize(value) {
    let stem = value;
    let type = "input";
    if (value.endsWith("]") && value.includes("[")) {
        const i = value.lastIndexOf("[");
        stem = value.slice(0, i);
        type = value.slice(i + 1, -1) === "output" ? "output" : "input";
    }
    const url = `/view?filename=${encodeURIComponent(stem)}&type=${type}&subfolder=&format=png`;
    return new Promise(resolve => {
        let done = false;
        const finish = r => { if (!done) { done = true; resolve(r); } };
        const img = new Image();
        const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
        img.onload = () => { clearTimeout(timer); finish({ width: img.naturalWidth, height: img.naturalHeight }); };
        img.onerror = () => { clearTimeout(timer); finish(null); };
        img.src = url;
    });
}

/**
 * 采集当前图的工作流上下文。
 * @returns {Promise<{nodes:string[], h3:Object[], references:Array}|null>}
 *   references: [{kind:"image"|"video", source:{kind:"input",value}, width?, height?}]
 */
export async function collectWorkflowContext(graph) {
    if (!graph?.getNodeById) return null;

    const nodeTypes = new Set();
    for (const n of graph._nodes || []) {
        if (n?.type) nodeTypes.add(n.type);
    }

    const h3Nodes = [];
    const refSeen = new Set();
    const references = [];
    const probeJobs = [];

    for (const n of graph._nodes || []) {
        if (!H3_NODE_TYPES.includes(n?.type)) continue;
        const params = {};
        for (const name of H3_WIDGETS) {
            const v = widgetValue(n, name);
            if (v != null && v !== "") params[name] = v;
        }
        const durSec = resolveDurationSeconds(graph, n);
        if (isFinite(durSec)) params.duration_seconds = durSec;
        // 画布比例：回溯上游解析真实值；width/height widget 被连线覆盖时是 stale，丢弃只留比例
        const aspect = resolveCanvasAspect(graph, n);
        if (aspect) params.aspect = aspect;
        if (inputSource(graph, n, "width")) { delete params.width; delete params.height; }
        h3Nodes.push({ type: n.type, ...params });

        // 回溯 image / video 输入到叶子媒体节点（LoadImage/LoadVideo）
        for (const inp of n.inputs || []) {
            const isMediaSlot = /^ref_(image|video)_\d+$/.test(inp.name) ||
                ["first_frame", "last_frame", "image", "video"].includes(inp.name);
            if (!isMediaSlot || inp.link == null) continue;
            const links = graph.links;
            const link = typeof links?.get === "function" ? links.get(inp.link) : links?.[inp.link];
            if (!link) continue;
            const srcNode = graph.getNodeById(link.origin_id);
            if (!srcNode) continue;
            const leaf = backtraceLeaf(graph, srcNode);
            if (!leaf || refSeen.has(leaf.value)) continue;
            refSeen.add(leaf.value);
            const ref = { kind: leaf.kind, source: { kind: "input", value: leaf.value } };
            references.push(ref);
            if (leaf.kind === "image" && references.length <= MAX_REFERENCES) {
                probeJobs.push(probeImageSize(leaf.value).then(size => {
                    if (size) { ref.width = size.width; ref.height = size.height; }
                }).catch(() => {}));
            }
        }
    }

    await Promise.all(probeJobs);

    const ctx = {
        nodes: [...nodeTypes],
        h3: h3Nodes,
        references: references.slice(0, MAX_REFERENCES),
    };
    return (ctx.h3.length || ctx.references.length) ? ctx : null;
}

/** 供测试/调试：导出纯函数 */
export const _internals = { gcd, aspectRatio, H3_NODE_TYPES, leafMediaSource, resolveDurationSeconds, resolveCanvasAspect };
