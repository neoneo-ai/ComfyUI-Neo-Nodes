// Neo Gallery 卡片拖放到 LoadImage 节点：命中检测与高亮框必须用同一套画布变换。
// 回归点：LiteGraph 的屏幕变换是 screen=(graph+offset)*scale，offset 也要乘 scale，
// 否则高亮会在缩放/平移时整体偏移（100% 缩放看不出来，放大后偏得很多）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, flush, resetFetchLog, fetchLog, jsonResponse, window } from "./setup.mjs";
import { app, appState } from "./mocks/comfy-app.mjs";

const NEO_MIME = "application/x-neo-gallery";

const SCALE = 1.8;
const OX = -200;
const OY = -100;
const CANVAS_RECT = { x: 100, y: 50, top: 50, left: 100, right: 1000, bottom: 700, width: 900, height: 650 };
const NODE_POS = [300, 200];
const NODE_SIZE = [400, 300];
const NODE_CENTER_CLIENT = {
    clientX: CANVAS_RECT.left + (NODE_POS[0] + NODE_SIZE[0] / 2 + OX) * SCALE,
    clientY: CANVAS_RECT.top + (NODE_POS[1] + NODE_SIZE[1] / 2 + OY) * SCALE,
};

let widget = null;
let node = null;

// graph 坐标 → 期望屏幕矩形（与 LiteGraph screen=(graph+offset)*scale 一致）
function expectedScreenRect() {
    return {
        left: CANVAS_RECT.left + (NODE_POS[0] + OX) * SCALE,
        top: CANVAS_RECT.top + (NODE_POS[1] + OY) * SCALE,
        width: NODE_SIZE[0] * SCALE,
        height: NODE_SIZE[1] * SCALE,
    };
}

function makeDataTransfer(payload, { types = [NEO_MIME] } = {}) {
    return {
        types,
        dropEffect: "",
        getData: (t) => (t === NEO_MIME && payload ? JSON.stringify(payload) : ""),
        setData() {},
    };
}

function dispatchDrag(type, { clientX = 0, clientY = 0, dataTransfer } = {}) {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    if (dataTransfer) Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, configurable: true });
    Object.defineProperty(ev, "clientX", { value: clientX, configurable: true });
    Object.defineProperty(ev, "clientY", { value: clientY, configurable: true });
    document.dispatchEvent(ev);
    return ev;
}

function highlightEl() {
    return document.querySelector(".neo-gallery-node-drop-highlight");
}

// 仿射逆变换含除法，会带来 ~1e-12 级浮点噪声，比较用容差
function assertClose(actual, expected, msg) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: 期望 ${expected}，实际 ${actual}`);
}

// 只 boot 一次：attachGalleryNodeDrop 的 _attached 与高亮元素都是模块级单例，
// 重复 resetEnv（清空 body）会让高亮元素脱离文档，后续无法查询。
resetEnv();
clearRoutes();
const { attachGalleryNodeDrop } = await import("../../web/gallery-node-drop.js");

const canvasEl = document.createElement("canvas");
canvasEl.__rect = CANVAS_RECT;
widget = { name: "image", type: "combo", value: "", options: { values: [] } };
node = {
    id: 51,
    type: "LoadImage",
    comfyClass: "LoadImage",
    title: "加载图像",
    pos: [...NODE_POS],
    size: [...NODE_SIZE],
    mode: 0,
    widgets: [widget],
    isPointInside(x, y) {
        return x >= node.pos[0] && x <= node.pos[0] + node.size[0]
            && y >= node.pos[1] && y <= node.pos[1] + node.size[1];
    },
};
app.canvas = {
    canvas: canvasEl,
    ds: { scale: SCALE, offset: [OX, OY] },
    canvasPosToGraph: ([x, y]) => [x / SCALE - OX, y / SCALE - OY],
};
appState.graph = { _nodes: [node], setDirtyCanvas() {} };
attachGalleryNodeDrop();

test("dragover 命中 LoadImage：高亮框落在缩放/平移后的真实节点位置", () => {
    const ev = dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: makeDataTransfer(null) });
    assert.equal(ev.defaultPrevented, true, "命中节点时应 preventDefault 以允许落放");

    const el = highlightEl();
    assert.ok(el, "应创建高亮元素");
    assert.equal(el.style.display, "block");
    const exp = expectedScreenRect();
    assertClose(parseFloat(el.style.left), exp.left, "高亮 left 应对齐节点");
    assertClose(parseFloat(el.style.top), exp.top, "高亮 top 应对齐节点");
    assertClose(parseFloat(el.style.width), exp.width, "高亮 width 应含缩放");
    assertClose(parseFloat(el.style.height), exp.height, "高亮 height 应含缩放");

    // 旧实现的错误公式 left=rect.left+pos*scale+offset（offset 漏乘 scale）会偏出很远
    const buggyLeft = CANVAS_RECT.left + NODE_POS[0] * SCALE + OX;
    assert.ok(Math.abs(parseFloat(el.style.left) - buggyLeft) > 1, "不应回退到漏乘 scale 的错误公式");
});

test("无 canvasPosToGraph 时回退 ds 变换，高亮定位仍正确", () => {
    const saved = app.canvas.canvasPosToGraph;
    delete app.canvas.canvasPosToGraph;
    try {
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: makeDataTransfer(null) });
        const el = highlightEl();
        const exp = expectedScreenRect();
        assertClose(parseFloat(el.style.left), exp.left, "高亮 left 应对齐节点");
        assertClose(parseFloat(el.style.top), exp.top, "高亮 top 应对齐节点");
        assertClose(parseFloat(el.style.width), exp.width, "高亮 width 应含缩放");
        assertClose(parseFloat(el.style.height), exp.height, "高亮 height 应含缩放");
    } finally {
        app.canvas.canvasPosToGraph = saved;
    }
});

test("落点命中 LoadImage：经 copy_to_input 写入 image widget 并提示成功", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    widget.value = "";
    node.mode = 0;
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "gallery_pic.png" }));

    const dt = makeDataTransfer({ filename: "pic.png", subfolder: "CharacterSheet" });
    dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    await flush(30);

    assert.equal(ev.defaultPrevented, true, "命中时应接管落放事件");
    assert.equal(widget.value, "gallery_pic.png");
    assert.ok(fetchLog.some((f) => f.path === "/neo_gallery/copy_to_input"), "应调用复制到输入目录接口");
    assert.equal(appState.toasts.at(-1)?.severity, "success");
    assert.equal(highlightEl().style.display, "none", "落放后应隐藏高亮");
});

test("空白处落放：不拦截、不写入", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    widget.value = "";
    const dt = makeDataTransfer({ filename: "pic.png" });
    const ev = dispatchDrag("dragover", { clientX: 20, clientY: 20, dataTransfer: dt });
    assert.equal(ev.defaultPrevented, false, "未命中节点不应 preventDefault");
    assert.equal(highlightEl().style.display, "none");

    dispatchDrag("drop", { clientX: 20, clientY: 20, dataTransfer: dt });
    await flush(30);
    assert.equal(widget.value, "", "空白处落放不应写入");
    assert.equal(fetchLog.length, 0);
});

test("非图片载荷落在 LoadImage 上：不写入", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    widget.value = "";
    const dt = makeDataTransfer({ filename: "clip.mp4" });
    dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    await flush(30);
    assert.equal(widget.value, "");
    assert.equal(fetchLog.length, 0);
});

test("禁用节点（mode=4）不作为落点", () => {
    resetFetchLog();
    node.mode = 4;
    try {
        const ev = dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: makeDataTransfer(null) });
        assert.equal(ev.defaultPrevented, false, "禁用节点不应被命中");
    } finally {
        node.mode = 0;
    }
});

// ====== 视频 / 音频 Load 节点落放 ======

function makeMediaNode(id, type, widgetName) {
    const n = {
        id, type, comfyClass: type, title: type,
        pos: [...NODE_POS], size: [...NODE_SIZE], mode: 0,
        widgets: [{ name: widgetName, type: "combo", value: "", options: { values: [] } }],
    };
    n.isPointInside = (x, y) => x >= n.pos[0] && x <= n.pos[0] + n.size[0]
        && y >= n.pos[1] && y <= n.pos[1] + n.size[1];
    return n;
}

// handler 通过 app.graph._nodes 实时读取节点集；临时替换并返回还原函数
function swapNodes(next) {
    const prev = appState.graph._nodes;
    appState.graph._nodes = next;
    return () => { appState.graph._nodes = prev; };
}

const videoNode = makeMediaNode(61, "LoadVideo", "file");
const audioNode = makeMediaNode(71, "LoadAudio", "audio");

test("落点命中 LoadVideo：视频载荷经 copy_to_input 写入 file widget 并提示成功", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    videoNode.widgets[0].value = "";
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "clip.mp4" }));
    const restore = swapNodes([videoNode]);
    try {
        const dt = makeDataTransfer({ filename: "clip.mp4", subfolder: "" });
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        await flush(30);
        assert.equal(ev.defaultPrevented, true, "命中且类型匹配时应接管落放");
        assert.equal(videoNode.widgets[0].value, "clip.mp4");
        assert.ok(fetchLog.some((f) => f.path === "/neo_gallery/copy_to_input"), "应调用复制到输入目录接口");
        assert.equal(appState.toasts.at(-1)?.severity, "success");
    } finally { restore(); }
});

test("落点命中 LoadAudio：音频载荷经 copy_to_input 写入 audio widget 并提示成功", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    audioNode.widgets[0].value = "";
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "voice.wav" }));
    const restore = swapNodes([audioNode]);
    try {
        const dt = makeDataTransfer({ filename: "voice.wav" });
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        await flush(30);
        assert.equal(ev.defaultPrevented, true, "命中且类型匹配时应接管落放");
        assert.equal(audioNode.widgets[0].value, "voice.wav");
        assert.ok(fetchLog.some((f) => f.path === "/neo_gallery/copy_to_input"), "应调用复制到输入目录接口");
        assert.equal(appState.toasts.at(-1)?.severity, "success");
    } finally { restore(); }
});

test("类型不匹配：图片载荷落在 LoadVideo 上不写入、不接管落放", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    videoNode.widgets[0].value = "";
    const restore = swapNodes([videoNode]);
    try {
        const dt = makeDataTransfer({ filename: "pic.png" });
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        await flush(30);
        assert.equal(ev.defaultPrevented, false, "类型不匹配不应接管落放");
        assert.equal(videoNode.widgets[0].value, "", "类型不匹配不应写入");
        assert.equal(fetchLog.length, 0);
    } finally { restore(); }
});

test("类型不匹配：视频载荷落在 LoadImage 上不写入、不接管落放", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    widget.value = "";
    const dt = makeDataTransfer({ filename: "clip.mp4" });
    dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
    await flush(30);
    assert.equal(ev.defaultPrevented, false, "类型不匹配不应接管落放");
    assert.equal(widget.value, "", "视频载荷不应写入 LoadImage");
    assert.equal(fetchLog.length, 0);
});

// ====== Neo Grid Split 落放（filename combo）======

function makeGridSplitNode(id) {
    const n = {
        id, type: "NeoGridSplit", comfyClass: "NeoGridSplit", title: "宫格图拆分",
        pos: [...NODE_POS], size: [...NODE_SIZE], mode: 0,
        widgets: [
            { name: "filename", type: "combo", value: "", options: { values: [] } },
            { name: "rows", type: "combo", value: "auto", options: { values: ["auto"] } },
            { name: "cols", type: "combo", value: "auto", options: { values: ["auto"] } },
        ],
    };
    n.isPointInside = (x, y) => x >= n.pos[0] && x <= n.pos[0] + n.size[0]
        && y >= n.pos[1] && y <= n.pos[1] + n.size[1];
    return n;
}

const gridSplitNode = makeGridSplitNode(81);

test("落点命中 Neo Grid Split：图片载荷经 copy_to_input 写入 filename widget 并提示成功", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    gridSplitNode.widgets[0].value = "";
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "grid_6.png" }));
    const restore = swapNodes([gridSplitNode]);
    try {
        const dt = makeDataTransfer({ filename: "grid_6.png", subfolder: "" });
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        await flush(30);
        assert.equal(ev.defaultPrevented, true, "命中且类型匹配时应接管落放");
        assert.equal(gridSplitNode.widgets[0].value, "grid_6.png", "应写入 filename widget");
        assert.equal(gridSplitNode.widgets[1].value, "auto", "不应误写 rows/cols");
        assert.ok(fetchLog.some((f) => f.path === "/neo_gallery/copy_to_input"), "应调用复制到输入目录接口");
        assert.equal(appState.toasts.at(-1)?.severity, "success");
    } finally { restore(); }
});

test("类型不匹配：视频载荷落在 Neo Grid Split 上不写入、不接管落放", async () => {
    resetFetchLog();
    appState.toasts.length = 0;
    gridSplitNode.widgets[0].value = "";
    const restore = swapNodes([gridSplitNode]);
    try {
        const dt = makeDataTransfer({ filename: "clip.mp4" });
        dispatchDrag("dragover", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        const ev = dispatchDrag("drop", { ...NODE_CENTER_CLIENT, dataTransfer: dt });
        await flush(30);
        assert.equal(ev.defaultPrevented, false, "类型不匹配不应接管落放");
        assert.equal(gridSplitNode.widgets[0].value, "", "视频载荷不应写入 Neo Grid Split");
        assert.equal(fetchLog.length, 0);
    } finally { restore(); }
});
