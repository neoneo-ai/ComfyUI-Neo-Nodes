// L1：NeoH3VideoDirector 节点内时间轴的最小尺寸钳制。
// LiteGraph 核心的 setSize 只替换 size 并触发 onResize，不检查 minWidth/minHeight，
// 拖拽缩小节点会把固定高度的时间轴裁掉——扩展必须在 onResize 里补钳制（最小高度含时间轴）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { getExtension, appState } from "./mocks/comfy-app.mjs";

const TL_H = 96; // 与 web/director-node.js 的 TL_H 保持一致
const ACT_H = 28; // 与 web/director-node.js 的 ACT_H（时间轴下方操作条）保持一致
const PREVIEW_H = 300; // 与 web/director-node.js 的 PREVIEW_H（运行时采样预览预留高度）保持一致
const BASE_W = 340;
const BASE_H = 220;

function makeDirectorNode(recipeValue = "", extraWidgets = []) {
    const node = {
        id: 1,
        type: "NeoH3VideoDirector",
        properties: {},
        widgets: [{ name: "recipe", value: recipeValue }, ...extraWidgets.map((w) => ({ ...w }))],
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

async function createDirectorNode(recipeValue = "", extraWidgets = []) {
    await import("../../web/director-node.js");
    const ext = getExtension("NeoH3VideoDirector.Timeline");
    assert.ok(ext, "director 时间轴扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoH3VideoDirector" });
    const node = makeDirectorNode(recipeValue, extraWidgets);
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

test("运行时节点加高预留采样预览空间，结束后还原自然高度", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    const payload = { active: false, segment_index: -1, total_segments: 0 };
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(payload));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer); // 手动驱动，停止自动轮询
    const baseH = BASE_H + TL_H + ACT_H;
    assert.equal(node.size[1], baseH, "初始为自然高度（含时间轴+操作条）");

    payload.active = true; payload.segment_index = 0; payload.total_segments = 3;
    await node._neoDtProgressTick();
    assert.equal(node.size[1], baseH + PREVIEW_H, "运行时加高预留采样预览空间");

    payload.active = false; payload.segment_index = -1;
    await node._neoDtProgressTick();
    assert.equal(node.size[1], baseH, "结束后还原自然高度");
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

test("运行进度跳到后段时节点时间轴自动把该段滚进可视区", async () => {
    resetEnv();
    clearRoutes();
    const payload = { active: true, segment_index: 0, total_segments: 8 };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: Array.from({ length: 8 }, (_, i) => ({ prompt: "seg" + i, duration_sec: 5 })),
    }));
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(payload));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60); // 等 loadSpec 把 8 段填进时间轴

    const tl = node._neoDtTimeline;
    Object.defineProperty(tl.canvas, "clientWidth", { value: 320, configurable: true });
    const view = tl._visibleWidth();
    assert.ok(tl._width() > view, "8 段内容宽于可视区（可滚动）");
    assert.equal(tl.scroll.scrollLeft, 0);

    payload.segment_index = 6;          // 后端推进到第 7 段
    await node._neoDtProgressTick();
    assert.ok(tl.scroll.scrollLeft > 0, "自动滚动跟随当前生成段");
    const b = tl._layout().blocks[6];
    assert.ok(b.x >= tl.scroll.scrollLeft && b.x + b.w <= tl.scroll.scrollLeft + view, "当前段整体落在可视区内");

    const settled = tl.scroll.scrollLeft;
    await node._neoDtProgressTick();    // 同一段再轮询：不重复滚动
    assert.equal(tl.scroll.scrollLeft, settled, "同一段重复轮询不再滚动");
});


test("点击节点时间轴第 3 块：编辑器打开即定位到该段", async () => {
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
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", shared: {}, segments: [
            { skill_id: "sk-a", prompt: "a", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "b", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "c", duration_sec: 5 },
        ] },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    await sleep(60); // 等 loadSpec 把 3 段填进节点时间轴

    const canvas = node._neoDtTimeline.canvas;
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 88, width: 320, height: 88 };

    // 3 段等长、可点区间 [8,312]：第 3 块 [210.7,312]，点中点 261
    canvas.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 261, clientY: 40 }));
    await sleep(140); // openEditor：listRecipes → openDirectorEditor(meta, cb, 2)

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 3, "编辑器载入全部 3 段");
    assert.equal(segs.findIndex((s) => s.classList.contains("neo-director-seg-current")), 2, "定位到点击的第 3 段");
    assert.equal(segs[2].querySelector(".neo-director-prompt").value, "c", "显示的是被点段的内容");
});

test("切换 recipe 下拉后节点时间轴重新拉取并更新", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };

    // mock 按「当前」recipe widget 值返回不同 spec，验证 loadSpec 读到的是切换后的新值
    let recipeWidgetRef = null;
    mockRoute("/rs_recipes/director_spec", async () => {
        const name = recipeWidgetRef ? String(recipeWidgetRef.value || "") : "";
        if (name === "recipe-b") {
            return jsonResponse({ success: true, segments: [
                { prompt: "B1", duration_sec: 5 },
                { prompt: "B2", duration_sec: 5 },
            ] });
        }
        return jsonResponse({ success: true, segments: [{ prompt: "A1", duration_sec: 5 }] });
    });

    const node = await createDirectorNode("recipe-a");
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    await sleep(60); // 初始 loadSpec：recipe-a → 1 段
    const tl = node._neoDtTimeline;
    assert.equal(tl._segs.length, 1, "初始载入 recipe-a 的 1 段");

    // 模拟 LiteGraph combo 变化：先更新 value，再触发 callback（本版本 combo 用 callback 而非 onchange）
    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60); // loadSpec 重新拉取 recipe-b → 2 段

    assert.equal(tl._segs.length, 2, "切换后时间轴更新为 recipe-b 的 2 段");
});

const DIM_WIDGETS = [
    { name: "width", value: -1 },
    { name: "height", value: -1 },
    { name: "steps", value: -1 },
];

// 按配方名返回不同的首段默认尺寸/步数（recipe-b 用 turbo 的低步数）
function mockDimDefaults(getRecipeWidget) {
    mockRoute("/rs_recipes/director_spec", () => {
        const name = getRecipeWidget() ? String(getRecipeWidget().value || "") : "";
        const defaults = name === "recipe-b"
            ? { width: 960, height: 544, steps: 8 }
            : { width: 1344, height: 768, steps: 20 };
        return jsonResponse({ success: true, segments: [{ prompt: "s", duration_sec: 5 }], defaults });
    });
}

test("重新载入配方时 width/height/steps 按新配方要求初始化（手改值也不保留）", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let recipeWidgetRef = null;
    mockDimDefaults(() => recipeWidgetRef);

    const node = await createDirectorNode("recipe-a", DIM_WIDGETS);
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60); // 初始 loadSpec

    const dims = () => DIM_WIDGETS.map((d) => node.widgets.find((w) => w.name === d.name).value);
    assert.deepEqual(dims(), [1344, 768, 20], "初始按配方 A 首段填充");

    node.widgets.find((w) => w.name === "steps").value = 15; // 用户手改

    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60);

    assert.deepEqual(dims(), [960, 544, 8], "切换配方后按新配方要求重新初始化，手改的 steps 也不保留");
});

test("创建时保留工作流已存值，切换配方后按新配方要求初始化", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let recipeWidgetRef = null;
    mockDimDefaults(() => recipeWidgetRef);

    // 工作流还原出的实值（非 -1）：首次载入不得被配方默认覆盖
    const node = await createDirectorNode("recipe-a", [
        { name: "width", value: 1280 },
        { name: "height", value: 544 },
        { name: "steps", value: 15 },
    ]);
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60);

    const dims = () => DIM_WIDGETS.map((d) => node.widgets.find((w) => w.name === d.name).value);
    assert.deepEqual(dims(), [1280, 544, 15], "创建工作流时保留已存值");

    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60);

    assert.deepEqual(dims(), [960, 544, 8], "切换配方后按新配方要求初始化");
});

// 节点内实时预览开关：与 preview 输入同一份状态（widget.value 随工作流保存），
// 点「👁」= 改输入值 + 触发回调；输入被别处改动 / 工作流还原后按钮态同步。
test("「👁」实时预览开关与 preview 输入双向同步", async () => {
    resetEnv();
    const seen = [];
    const node = await createDirectorNode("", [
        { name: "preview", value: true, callback: (v) => seen.push(v) },
    ]);
    clearInterval(node._neoDtProgressTimer);

    const previewWidget = node.widgets.find((w) => w.name === "preview");
    const root = node.domWidgets.find((w) => w.name === "director_timeline").el;
    const btn = root.querySelector(".neo-dtl-preview");
    assert.ok(btn, "时间轴左侧缺少「👁」预览开关");
    assert.equal(root.querySelector(".neo-dtl-tlrow").firstElementChild, btn, "开关应在时间轴左侧");
    assert.ok(btn.classList.contains("neo-dtl-preview-on"), "默认开：与后端 preview 默认值一致");

    click(btn);
    assert.equal(previewWidget.value, false, "点开关应写入 preview 输入");
    assert.deepEqual(seen, [false], "点开关应触发输入回调（后端起效 + 随工作流保存）");
    assert.equal(btn.classList.contains("neo-dtl-preview-on"), false, "关闭后按钮变灰");
    assert.match(btn.title, /关/);

    click(btn);
    assert.equal(previewWidget.value, true);
    assert.deepEqual(seen, [false, true]);
    assert.match(btn.title, /开/);

    // 节点自带的 preview 开关 / 别的代码改 value 后触发回调 → 按钮跟随
    previewWidget.value = false;
    previewWidget.callback(false);
    assert.equal(btn.classList.contains("neo-dtl-preview-on"), false);
    assert.deepEqual(seen, [false, true, false]);

    // 工作流还原按 widgets_values 直写 value、不触发回调 → configure 后补同步
    previewWidget.value = true;
    node.onConfigure({});
    assert.ok(btn.classList.contains("neo-dtl-preview-on"), "还原工作流后按钮态与 preview 输入一致");
});

