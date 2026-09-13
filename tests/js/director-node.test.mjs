// L1：NeoH3VideoDirector 节点内时间轴的最小尺寸钳制。
// LiteGraph 核心的 setSize 只替换 size 并触发 onResize，不检查 minWidth/minHeight，
// 拖拽缩小节点会把固定高度的时间轴裁掉——扩展必须在 onResize 里补钳制（最小高度含时间轴）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";
import { getExtension, appState } from "./mocks/comfy-app.mjs";

const TL_H = 96; // 与 web/director-node.js 的 TL_H 保持一致
const ACT_H = 28; // 与 web/director-node.js 的 ACT_H（时间轴下方操作条）保持一致
const BASE_W = 340;
const BASE_H = 220;

function makeDirectorNode(recipeValue = "") {
    const node = {
        id: 1,
        type: "NeoH3VideoDirector",
        properties: {},
        widgets: [{ name: "recipe", value: recipeValue }],
        inputs: [],
        outputs: [],
        size: [BASE_W, BASE_H],
        minWidth: 0,
        minHeight: 0,
        domWidgets: [],
        addDOMWidget(name, type, el) {
            const w = { name, type, el };
            node.widgets.push(w);
            node.domWidgets.push(w);
            return w;
        },
        // 与前端核心 setSize 同语义：替换 size 后触发 onResize，不做 min 钳制
        setSize(size) {
            node.size = [...size];
            node.onResize?.(node.size);
        },
    };
    return node;
}

async function createDirectorNode(recipeValue = "") {
    await import("../../web/director-node.js");
    const ext = getExtension("NeoH3VideoDirector.Timeline");
    assert.ok(ext, "director 时间轴扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoH3VideoDirector" });
    const node = makeDirectorNode(recipeValue);
    nodeType.prototype.onNodeCreated.call(node);
    return node;
}

test("创建后节点高度与最小高度都包含时间轴", async () => {
    resetEnv();
    const node = await createDirectorNode();
    assert.equal(node.size[0], BASE_W);
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H);
    assert.equal(node.minWidth, BASE_W);
    assert.equal(node.minHeight, BASE_H + TL_H + ACT_H);
});

test("拖拽缩小被钳制在最小尺寸，时间轴不被裁切", async () => {
    resetEnv();
    const node = await createDirectorNode();
    node.setSize([200, 150]);
    assert.equal(node.size[0], BASE_W, "宽度应钳制到 minWidth");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H, "高度应钳制到含时间轴+操作条的 minHeight");
});

test("拖拽放大不受影响，且时间轴宽度随节点同步", async () => {
    resetEnv();
    const node = await createDirectorNode();
    node.setSize([500, 420]);
    assert.deepEqual(node.size, [500, 420]);
    const tl = node.domWidgets.find((w) => w.name === "director_timeline");
    assert.ok(tl, "时间轴 DOM widget 缺失");
    assert.equal(tl.width, 500);
});

test("点击节点时间轴分段块直接打开配方编辑器", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [{ prompt: "第一段", duration_sec: 5 }],
    }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director" },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    await sleep(60); // 等 loadSpec 把段数据填进时间轴

    const canvas = node._neoDtTimeline.canvas;
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 88, width: 320, height: 88 };

    // 单段块占满 [8,312]，点中间命中块0 → readOnly select → onSelect → openEditor
    canvas.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 160, clientY: 40 }));

    await sleep(120); // openEditor：listRecipes → openDirectorEditor 建浮层
    assert.ok(document.querySelector(".neo-director-overlay"), "点击时间轴块打开编辑器");
});

test("轮询 /neo_video_gen/director_progress 后时间轴读到各段生成状态", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [
            { prompt: "a", duration_sec: 5 },
            { prompt: "b", duration_sec: 5 },
            { prompt: "c", duration_sec: 5 },
        ],
    }));
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse({ active: true, segment_index: 1, total_segments: 3 }));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer); // 手动驱动一次，停止自动轮询
    await node._neoDtProgressTick();

    assert.deepEqual(
        node._neoDtTimeline.opts.getProgress(),
        { active: true, segment_index: 1, total_segments: 3 },
        "进度应写入时间轴 getProgress()",
    );
});

test("时间轴按进度状态给各段标 done/current，非活动时不显示", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer);

    const tl = node._neoDtTimeline;
    tl._progress = { active: true, segment_index: 1, total_segments: 3 };
    assert.equal(tl._segProgressState(0), "done", "已完成段标 done");
    assert.equal(tl._segProgressState(1), "current", "当前段标 current");
    assert.equal(tl._segProgressState(2), "", "待处理段不显示");

    tl._progress = { active: false, segment_index: -1, total_segments: 3 };
    assert.equal(tl._segProgressState(0), "", "非活动时全部不显示");
});

test("时间轴显示区外右下角「＋ 新增导演配方」按钮打开新建编辑器", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director" },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    const root = node.domWidgets.find((w) => w.name === "director_timeline").el;
    const newBtn = root.querySelector(".neo-dtl-new");
    assert.ok(newBtn, "新增导演配方按钮存在");
    // 按钮在时间轴显示区之外（下方操作条内），而非时间轴行内
    assert.ok(root.querySelector(".neo-dtl-actbar .neo-dtl-new"), "按钮位于时间轴下方操作条");
    assert.ok(!root.querySelector(".neo-dtl-tlrow .neo-dtl-new"), "按钮不在时间轴显示区内");

    newBtn.click();
    await sleep(120); // openNewRecipe：listRecipes → openDirectorEditor(null) 建浮层
    assert.ok(document.querySelector(".neo-director-overlay"), "点击后打开新建编辑器");
});
