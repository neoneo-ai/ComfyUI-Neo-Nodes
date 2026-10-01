// Neo Studio 导演页：只读时间轴（所选配方分段）+ 生成中实时预览（载荷按 task_id 路由、终态定格）。
// studio-app.js 顶层会取 #ns-view / #ns-version 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, fetchLog } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

document.body.innerHTML = `<div id="ns-view"></div><div id="ns-version"></div>`;
mockRoute("/neo_studio/version", jsonResponse({
    success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: ["R1"],
}));
mockRoute("/rs_recipes/director_spec", jsonResponse({
    success: true,
    segments: [
        { prompt: "段一", duration_sec: 3, ref_input: "" },
        { prompt: "段二", duration_sec: 4, ref_input: "" },
    ],
    defaults: { width: 640, height: 384, steps: 20 },
}));
mockRoute("/neo_video_gen/director_progress", jsonResponse({
    active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
}));
mockRoute("/neo_studio/director/generate", jsonResponse({
    success: true, task_id: "task-1", prompt_id: "p1", status: "queued", recipe: "R1", seed: -1,
    filename: null, subfolder: null, progress: null, error: "", created: 0, updated: 0,
}));
// 任务快照路由：响应由 statusState 动态驱动（模拟 WS 事件丢失、终态只能靠轮询兜底拿到）
const statusState = { status: "queued", progress: null, filename: null };
mockRoute("/neo_studio/director/task-1", () => jsonResponse({
    success: true, task_id: "task-1", prompt_id: "p1", recipe: "R1", seed: -1,
    subfolder: "", error: "", created: 0, updated: 0, ...statusState,
}));
mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
mockRoute("/rs_recipes/list", jsonResponse([
    { name: "R1", type: "video_director", shared: { mode: "f2v" }, segments: [
        { skill_id: "sk-a", prompt: "段一", duration_sec: 3 },
        { skill_id: "sk-a", prompt: "段二", duration_sec: 4 },
    ]},
])); // listRecipes 直接返回数组
mockRoute("/rs_prompts/skills", jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

const frame = (name) => `data:image/jpeg;base64,${name}`;
function wsSend(type, data) {
    wsInstances[0].onmessage({ data: JSON.stringify({ type, data }) });
}
async function until(fn, what) {
    for (let i = 0; i < 50; i++) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`等待超时：${what}`);
}
// 轮询周期 2s，比 until（~1s）更长的等待用这个
async function untilMs(fn, what, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return;
        await sleep(50);
    }
    assert.fail(`等待超时：${what}`);
}

test("Studio 导演页：只读时间轴 + 生成中实时预览", async () => {
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");

    // 只读时间轴已挂进生成面板（与画布节点内嵌同款组件）
    assert.ok(document.querySelector(".ns-gen-timeline .neo-dtl-canvas"), "只读时间轴 canvas 应存在");

    // 首个配方自动选中（下方配方面板）：默认值填充 + 拉取 director_spec 刷新时间轴分段
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");
    const inputs = () => [...document.querySelectorAll(".ns-gen-panel input[type=number]")];
    await until(() => Number(inputs()[1].value) === 640 && Number(inputs()[2].value) === 384, "默认值填充");
    assert.ok(fetchLog.some((c) => c.path === "/rs_recipes/director_spec"), "应拉取配方 spec");

    // 提交生成：排队中状态 + 实时预览面板初始隐藏
    click(document.querySelector(".ns-gen-run"));
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("排队中"), "排队中状态");
    const liveBox = document.querySelector(".ns-gen-live");
    assert.equal(liveBox.style.display, "none", "首个载荷到达前预览面板不占位");

    // 预览载荷按 task_id 过滤：别的任务不显示
    wsSend("rs.h3.preview", { node_id: "other-task", frames: [frame("x")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.style.display, "none", "非本任务的载荷被过滤");

    // 本任务载荷：面板显示并播第一帧（固定高度由 onFrame 回调写入）
    wsSend("rs.h3.preview", { node_id: "task-1", frames: [frame("a"), frame("b")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.style.display, "");
    assert.equal(liveBox.style.height, "360px");
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("a"));

    // 成功：成片就地替换实时预览（播放器 + 打开链接）
    wsSend("rs.director.status", {
        task_id: "task-1", prompt_id: "p1", status: "succeeded", recipe: "R1", seed: -1,
        filename: "NeoDirector/R1.mp4", subfolder: "", progress: null, error: "", created: 0, updated: 0,
    });
    await until(() => document.querySelector("video.ns-gen-final"), "成片播放器出现");
    assert.equal(document.querySelector(".ns-gen-live"), null, "成片替换实时预览面板");
    assert.equal(document.querySelectorAll(".ns-gen-final").length, 2, "播放器 + 打开链接");
});

test("Studio 导演页：点时间轴分段块打开配方编辑器并定位到该段", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器内无媒体候选
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");

    // 首个配方自动选中（下方配方面板）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");

    // canvas 桩：W=320，段 3s+4s → 块1 ≈ [138,312]，点 x=200 命中第 2 块
    const canvas = document.querySelector(".ns-gen-timeline .neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };
    const mouse = (type, x) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    canvas.dispatchEvent(mouse("mousedown", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    // 编辑器浮层打开并定位到第 2 段（listRecipes 取 R1 meta，focusSeg=1）
    await until(() => document.querySelector(".neo-director-overlay"), "编辑器浮层出现");
    const currentIdx = () => [...document.querySelectorAll(".neo-director-seg")]
        .findIndex((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentIdx(), 1, "定位到被点击的段");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("Studio 导演页：轮询拿到终态 → 停轮询 + 成片只替换一次", async () => {
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    // 首个配方自动选中（下方配方面板）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");

    // 快照路由先返回 running，再返回 succeeded（模拟 WS 终态事件丢失，只能靠轮询拿到）
    statusState.status = "running";
    statusState.progress = { value: 5, max: 20 };
    statusState.filename = null;
    click(document.querySelector(".ns-gen-run"));
    await untilMs(() => (document.querySelector(".ns-gen-status").textContent || "").includes("生成中"), "轮询驱动生成中状态", 5000);

    statusState.status = "succeeded";
    statusState.progress = null;
    statusState.filename = "NeoDirector/R1.mp4";
    await untilMs(() => document.querySelector("video.ns-gen-final"), "轮询兜底出现成片播放器", 5000);
    const video = document.querySelector("video.ns-gen-final");
    const callsAtDone = fetchLog.filter((c) => c.path === "/neo_studio/director/task-1").length;

    // 再等两个多轮询周期：轮询必须已停、成片元素不得被重建（旧行为是每 2 秒重放一次视频）
    await sleep(4500);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/director/task-1").length, callsAtDone, "终态后轮询停止");
    assert.equal(document.querySelector("video.ns-gen-final"), video, "成片只替换一次");
});

test("Studio 导演页：WS 断档期间轮询 latest_preview 补帧（旧步号忽略）", async () => {
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    // 首个配方自动选中（下方配方面板）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");

    statusState.status = "running";
    statusState.progress = null;
    statusState.filename = null;
    delete statusState.latest_preview;
    click(document.querySelector(".ns-gen-run"));
    await untilMs(() => (document.querySelector(".ns-gen-status").textContent || "").includes("生成中"), "轮询驱动生成中状态", 5000);

    const liveBox = document.querySelector(".ns-gen-live");
    // WS 断档：没有 rs.h3.preview；轮询快照带最新帧（step 3）→ 面板显示
    statusState.latest_preview = { step: 3, frames: [frame("p3a"), frame("p3b")], fps: 8, w: 512, h: 288 };
    await untilMs(() => liveBox.style.display === "", "轮询兜底显示预览", 5000);
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p3a"));

    // WS 迟到的旧步号（step 2）不得覆盖新帧
    wsSend("rs.h3.preview", { node_id: "task-1", step: 2, frames: [frame("old")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p3a"), "旧步号被忽略");

    // WS 恢复后的新步号（step 4）继续推进
    wsSend("rs.h3.preview", { node_id: "task-1", step: 4, frames: [frame("p4")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p4"));

    // 收尾：轮询拿到终态停掉定时器，避免干扰后续用例
    delete statusState.latest_preview;
    statusState.status = "cancelled";
    await untilMs(() => (document.querySelector(".ns-gen-status").textContent || "").includes("已取消"), "轮询驱动已取消状态", 5000);
});