// 技能 ⇄ 画布同步：详情弹窗工作流区带「⤒ 导入到画布」/「💾 回写入技能」
// 导入把技能 workflow.json 按当前设置预渲染后 app.loadApiJson 落画布；回写把画布 API prompt 落盘该技能 workflow.json。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { app, appState, installWorkflowStore, clearWorkflowStore } from "./mocks/comfy-app.mjs";

const WF_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", batch_size: "{{COUNT}}" } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], latent_image: ["3", 0], seed: "{{SEED}}", steps: "{{STEPS}}" } },
    "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "{{PREFIX}}" } },
    "9": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE}}" } },
};

beforeEach(() => {
    resetEnv();
    clearRoutes();
    appState.promptGraph = null;
});


async function openPopup({ id = "custom_a", source = "custom", canvasBtns = true, config = { model: "m.safetensors", default_ratio: "16:9" } } = {}) {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: id, workflow: WF_TEMPLATE }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(config) : jsonResponse({ success: true }));
    mockRoute("/object_info", () => jsonResponse({}));
    const popup = canvasBtns === false
        ? createSkillDetailPopup(document.body.appendChild(document.createElement("div")), false)
        : createSkillDetailPopup();
    await popup.openExisting(id, source);
    await sleep(80);
    return popup;
}

function importBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-import-btn");
    return all.length ? all[all.length - 1] : null;
}
function writeBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-write-btn");
    return all.length ? all[all.length - 1] : null;
}
// 交接导入 toast 的卡片与「💾 回写入技能」按钮（插件 action toast 渲染在 #neo-action-toast-stack，最新一张在最后）
function handoffCardEl() {
    const cards = document.querySelectorAll("#neo-action-toast-stack .neo-at");
    return cards.length ? cards[cards.length - 1] : null;
}
function handoffWriteBtn() {
    const card = handoffCardEl();
    return card ? card.querySelector(".neo-at-action") : null;
}

test("详情弹窗：带 workflow 技能挂「⤒ 导入到画布」「💾 回写入技能」在工作流区头部", async () => {
    await openPopup({ id: "custom_a", source: "custom" });
    const btns = document.querySelector(".rs-wf-canvas-btns");
    assert.ok(btns, "工作流区头部应挂画布按钮行");
    assert.ok(btns.parentElement.classList.contains("rs-skill-workflow-head"), "按钮应在工作流区头部");
    assert.deepEqual(Array.from(btns.querySelectorAll("button")).map((b) => b.textContent),
        ["⤒ 导入到画布", "💾 回写入技能"]);
});

test("导入到画布：按设置预渲染后 app.loadApiJson（number widget 归 number、参考图留占串）", async () => {
    await openPopup({ id: "custom_a", source: "custom" });
    const loadedAt = appState.loaded.length;
    const toastAt = appState.toasts.length;
    click(importBtn());
    await sleep(80);

    const api = appState.loaded.slice(loadedAt).filter((l) => l.kind === "api");
    assert.equal(api.length, 1, "应调 app.loadApiJson 一次");
    assert.equal(api[0].name, "custom_a", "技能名作为画布 meta 名");
    const wf = api[0].data;
    assert.equal(wf["1"].inputs.unet_name, "m.safetensors", "{{MODEL}} 按设置预渲染");
    assert.equal(wf["2"].inputs.text, "", "{{PROMPT}} 归空（画里提示后回写）");
    assert.strictEqual(wf["3"].inputs.width, 1296, "number widget 的纯数字串归 number（长边 1280 对齐 16）");
    assert.strictEqual(wf["3"].inputs.height, 736, "16:9 高 720 对齐 16");
    assert.strictEqual(wf["3"].inputs.batch_size, 1);
    assert.strictEqual(wf["4"].inputs.seed, 0, "SEED 归 0（画布随机后回写落 0）");
    assert.strictEqual(wf["4"].inputs.steps, 20);
    assert.equal(wf["5"].inputs.filename_prefix, "NeoAgent", "非 number widget 保持字符串");
    assert.equal(wf["9"].inputs.image, "{{REF_IMAGE}}", "参考图槽位留占串（画布里选图后回写）");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.summary || "").includes("已导入到画布")), "应 toast 导入成功");
});

test("导入到画布：按流程图同一套布局重排画布节点（分层左到右、列内堆叠、短列居中、适配视图）", async () => {
    const heights = { 1: 120, 2: 100, 3: 80, 4: 100, 5: 100, 9: 60 };
    const nodes = Object.keys(WF_TEMPLATE).map((id) => ({
        id: Number(id),
        size: [240, heights[id]],
        pos: [0, 0],
        setPos(x, y) { this.pos = [x, y]; },
    }));
    let dirty = 0, fitted = 0;
    appState.graph = { _nodes: nodes, setDirtyCanvas() { dirty++; } };
    app.canvas = { fitViewToSelectionAnimated() { fitted++; } };
    try {
        await openPopup({ id: "custom_a", source: "custom" });
        click(importBtn());
        await sleep(80);

        const at = (id) => nodes.find((n) => String(n.id) === id).pos;
        assert.deepEqual(at("1"), [60, 60], "首列首节点落在边距起点");
        assert.ok(at("2")[0] > at("1")[0] && at("4")[0] > at("2")[0] && at("5")[0] > at("4")[0],
            "依赖链 UNETLoader → CLIPTextEncode → KSampler → SaveImage 逐列右移");
        // 无下游的 9 与 UNETLoader 同列，按各自高度依次下移：60 → 60+120+48
        assert.deepEqual(at("9"), [60, 228], "同列节点按各自高度依次下移");
        // 同列（2/3）按连线落在 KSampler 的参数行顺序排布：positive 行（第 2 行）在 latent_image 行（第 3 行）之上
        assert.ok(at("2")[1] < at("3")[1], "列内按目标参数行位置上下排布，连线不交叉");
        assert.deepEqual(at("2"), [396, 105], "列间距按节点宽度、列内按重心排布");
        assert.deepEqual(at("3"), [396, 253], "latent_image 行靠下，EmptyLatent 排其后");
        assert.deepEqual(at("4"), [732, 176], "KSampler 列按上游重心垂直位置");
        assert.ok(at("5")[1] > 100, "末列相对最高列垂直居中");
        assert.ok(dirty >= 1, "重排后应 setDirtyCanvas");
        assert.equal(fitted, 1, "重排后适配视图");
    } finally {
        appState.graph = null;
        app.canvas = null;
    }
});

test("回写入技能：画布 API prompt 落盘该技能（POST update_workflow_skill）+ 后端 warnings toast", async () => {
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"], gen_video: false });
    });
    appState.promptGraph = {
        output: { "10": { class_type: "KSampler", inputs: { model: ["1", 0] } }, "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } } },
        workflow: "{\"nodes\":[]}",
    };
    await openPopup({ id: "custom_a", source: "custom" });
    const toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(80);

    assert.ok(posted, "应发出 /neo_image_gen/update_workflow_skill");
    assert.equal(posted.skill_id, "custom_a");
    assert.deepEqual(Object.keys(posted.workflow), ["10", "11"], "画布 output 原样落盘");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.detail || "").includes("CLIPTextEncode")), "后端 warnings 应 toast 落");
});

test("回写入技能：预设技能 / 空画布时不发请求并 toast 提示", async () => {
    let called = false;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => { called = true; return jsonResponse({ success: true, id: "x" }); });

    await openPopup({ id: "image_gen", source: "presets" });
    let toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(60);
    assert.equal(called, false, "预设技能不应回写");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.summary || "").includes("预设不可回写")), "应 toast 预设只读");

    appState.promptGraph = null; // mock 回落 { output: {}, workflow: null }
    await openPopup({ id: "custom_a", source: "custom" });
    toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(60);
    assert.equal(called, false, "空画布不应回写");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.summary || "").includes("无法回写")), "应 toast 无有效工作流");
});

test("Studio 内嵌详情（无画布）：工作流区只挂「⤒ 主画布编辑」，点击带技能 id 开主界面", async () => {
    const opened = [];
    window.open = (url, target) => { opened.push({ url, target }); return null; };
    try {
        await openPopup({ id: "custom_a", source: "custom", canvasBtns: false });
        assert.ok(document.querySelector(".rs-skill-workflow"), "工作流区仍渲染");
        const btns = document.querySelectorAll(".rs-wf-canvas-btns button");
        assert.deepEqual(Array.from(btns).map((b) => b.textContent), ["⤒ 主画布编辑"], "内嵌只挂交接按钮");
        click(btns[0]);
        await sleep(20);
        assert.deepEqual(opened, [{ url: "/?neo_wf_edit=custom_a", target: "_blank" }], "应带技能 id 打开主界面");
    } finally {
        delete window.open;
    }
});

// Studio 交接：主界面侧灌画布 + toast 动作回写（技能详情弹窗不在场）
function mockSkillRoutes({ id = "custom_a", source = "custom", workflow = WF_TEMPLATE, genVideo = false, config = { model: "m.safetensors", default_ratio: "16:9" } } = {}) {
    // 本文件的 beforeEach 只 resetEnv()：appState 跨用例累积、neo 设置模块级缓存 → 交接用例自己清态、钉死基准尺寸
    appState.toasts.length = 0;
    appState.loaded.length = 0;
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", source, content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: !genVideo, gen_video: genVideo, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: id, workflow }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(config) : jsonResponse({ success: true }));
    mockRoute("/object_info", () => jsonResponse({}));
}

test("交接导入：按技能 config.json 预渲染灌画布，toast 带「💾 回写入技能」动作落盘该技能", async () => {
    mockSkillRoutes();
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"], gen_video: false });
    });
    appState.promptGraph = {
        output: { "10": { class_type: "KSampler", inputs: { model: ["1", 0] } }, "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } } },
        workflow: "{\"nodes\":[]}",
    };
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    assert.equal(api.name, "custom_a", "loadApiJson 带技能名");
    assert.equal(api.data["1"].inputs.unet_name, "m.safetensors", "MODEL 按 config 预渲染");
    const { width, height, batch_size } = api.data["3"].inputs;
    assert.ok(Number.isInteger(width) && Number.isInteger(height), `WIDTH/HEIGHT 归 number（${width}x${height}）`);
    assert.ok(Math.abs(width / height - 16 / 9) < 0.02, `按技能 default_ratio 16:9 预渲染（${width}x${height}）`);
    assert.equal(batch_size, 1, "COUNT 归 number");
    assert.equal(api.data["4"].inputs.seed, 0, "SEED 归 0");
    assert.equal(api.data["9"].inputs.image, "{{REF_IMAGE}}", "参考图槽位留占串");

    const card = handoffCardEl();
    assert.ok(card && card.querySelector(".neo-at-summary").textContent.includes("已导入到画布"), "导入提示应可见");
    const btn = handoffWriteBtn();
    assert.ok(btn && btn.textContent === "💾 回写入技能", "导入 toast 应渲染「💾 回写入技能」按钮");
    appState.toasts.length = 0;
    click(btn);
    await sleep(80);
    assert.equal(posted && posted.skill_id, "custom_a", "动作应把画布落盘该技能");
    assert.deepEqual(Object.keys(posted.workflow), ["10", "11"]);
    assert.ok(appState.toasts.some((t) => (t.detail || "").includes("CLIPTextEncode")), "后端 warnings 应 toast 落");
});

test("交接回写：预设技能点「💾 回写入技能」不发请求并提示只读", async () => {
    mockSkillRoutes({ id: "image_gen", source: "presets" });
    let called = false;
    mockRoute("/neo_image_gen/update_workflow_skill", () => { called = true; return jsonResponse({ success: true, id: "image_gen" }); });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("image_gen");
    await sleep(80);

    const btn = handoffWriteBtn();
    assert.ok(btn, "预设技能导入 toast 同样给回写按钮");
    appState.toasts.length = 0;
    click(btn);
    await sleep(80);
    assert.equal(called, false, "预设技能不应回写");
    assert.ok(appState.toasts.some((t) => (t.summary || "").includes("预设不可回写")), "应 toast 预设只读");
});

test("交接回写卡片绑定灌入的工作流 tab：切走 tab 收起、切回来恢复", async () => {
    mockSkillRoutes();
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false }));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const skillWf = { path: "workflows/skill.json" };
    const otherWf = { path: "workflows/other.json" };
    const { setActive, listenerCount } = installWorkflowStore(skillWf);
    try {
        const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
        await openSkillWorkflowOnCanvas("custom_a");
        await sleep(80);

        const card = handoffCardEl();
        assert.ok(card && !card.classList.contains("neo-at-hidden"), "技能 tab 在场时回写卡片可见");
        setActive(otherWf);
        assert.ok(card.classList.contains("neo-at-hidden"), "切到其他画布 tab 应收起");
        setActive(skillWf);
        assert.ok(!card.classList.contains("neo-at-hidden"), "切回技能 tab 应恢复");

        click(handoffWriteBtn());
        await sleep(300);
        assert.equal(listenerCount(), 0, "卡片关闭后应解绑 tab 监听");
    } finally {
        clearWorkflowStore();
    }
});

test("交接回写卡片只认最后打开的技能：同画布再导入顶掉前一张", async () => {
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    mockSkillRoutes({ id: "custom_a" });
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);
    const first = handoffCardEl();
    mockSkillRoutes({ id: "custom_b" });
    await openSkillWorkflowOnCanvas("custom_b");
    await sleep(80);

    assert.ok(first.classList.contains("neo-at-out"), "前一张卡片应关闭");
    const card = handoffCardEl();
    assert.ok(card !== first, "新导入渲染新卡片");
    assert.ok(card.querySelector(".neo-at-detail").textContent.includes("custom_b"), "最新卡片属于后导入的技能");
    click(handoffWriteBtn());
    await sleep(80);
    assert.equal(posted && posted.skill_id, "custom_b", "回写落最后打开的技能");
});

test("主界面启动消费 ?neo_wf_edit：清掉参数后灌画布（等 litegraph:set-graph，避开初始工作流覆盖）", async () => {
    mockSkillRoutes();
    const { runSkillWorkflowHandoff } = await import("../../web/skill.js");
    const canvasEl = document.createElement("canvas");
    app.canvas = { canvas: canvasEl, fitViewToSelectionAnimated() {} };
    window.history.replaceState(null, "", "/?neo_wf_edit=custom_a");
    try {
        runSkillWorkflowHandoff();
        assert.ok(!window.location.search.includes("neo_wf_edit"), "参数应被清掉，刷新不重复导入");
        const loadedAt = appState.loaded.length;
        canvasEl.dispatchEvent(new window.CustomEvent("litegraph:set-graph"));
        await sleep(80);
        assert.ok(appState.loaded.slice(loadedAt).some((l) => l.kind === "api" && l.name === "custom_a"),
            "前端换图落地后灌入技能工作流");
    } finally {
        app.canvas = null;
        window.history.replaceState(null, "", "/");
    }
});

// 画布导出成技能时只有主链值被占位符化，steps / SeedNode.seed / 尺寸等写死留在 workflow.json 里
const BAKED_IMAGE_WF = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "old.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "baked prompt" } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0], seed: 1234567, steps: 8, cfg: 3.5, sampler_name: "euler", scheduler: "normal" } },
    "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "old_prefix" } },
    "6": { class_type: "SeedNode", inputs: { seed: 1062097207049416 } },
};

test("交接导入：workflow.json 里写死的 widget 按技能 config.json 覆盖，非技能 widget 原样保留", async () => {
    mockSkillRoutes({
        workflow: BAKED_IMAGE_WF,
        config: { model: "m.safetensors", default_ratio: "16:9", steps: 12, count: 2, output_prefix: "SkillPrefix" },
    });
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    const wf = api.data;
    assert.strictEqual(wf["4"].inputs.steps, 12, "写死的 steps 按技能 config 覆盖");
    assert.strictEqual(wf["4"].inputs.seed, 0, "写死的 seed 归 0");
    assert.strictEqual(wf["6"].inputs.seed, 0, "SeedNode.seed 同样覆盖");
    assert.strictEqual(wf["3"].inputs.width, 1296, "写死 512 按 default_ratio 16:9 重算");
    assert.strictEqual(wf["3"].inputs.height, 736);
    assert.strictEqual(wf["3"].inputs.batch_size, 2, "COUNT 按 config.count");
    assert.equal(wf["5"].inputs.filename_prefix, "SkillPrefix", "PREFIX 按 config.output_prefix");
    assert.equal(wf["1"].inputs.ckpt_name, "old.safetensors", "checkpoint 名非技能 widget，不动");
    assert.equal(wf["2"].inputs.text, "baked prompt", "提示词节点原样保留");
    assert.strictEqual(wf["4"].inputs.cfg, 3.5, "cfg / sampler_name / scheduler 保留");
    assert.equal(wf["4"].inputs.sampler_name, "euler");
});

const BAKED_VIDEO_WF = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "old_dit.safetensors" } },
    "2": { class_type: "MiniMaxH3Video", inputs: { model: ["1", 0], prompt: "old prompt", width: 640, height: 640, length: 30 } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "old_video_vae.safetensors" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "old_audio_vae.safetensors" } },
    "5": { class_type: "VAEDecodeAudio", inputs: { samples: ["2", 1], vae: ["4", 0] } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 999, steps: 4 } },
};

test("交接导入（生视频）：MiniMaxH3 写死尺寸/时长与 steps 按 config 覆盖，喂 VAEDecodeAudio 的 VAELoader 灌 AUDIO_VAE", async () => {
    mockSkillRoutes({
        workflow: BAKED_VIDEO_WF, genVideo: true,
        config: { model: "d.safetensors", text_encoder: "t.safetensors", vae: "v.safetensors", audio_vae: "a.safetensors", steps: 30, width: 1024, height: 576, length: 8 },
    });
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["d.safetensors"], text_encoders: ["t.safetensors"], vae: ["v.safetensors", "a.safetensors"] }));
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    const wf = api.data;
    assert.equal(wf["1"].inputs.unet_name, "d.safetensors", "MODEL 覆盖写死值");
    assert.strictEqual(wf["2"].inputs.width, 1024, "MiniMaxH3 写死 width 覆盖");
    assert.strictEqual(wf["2"].inputs.height, 576);
    assert.strictEqual(wf["2"].inputs.length, 8, "LENGTH 覆盖写死时长");
    assert.strictEqual(wf["6"].inputs.steps, 30, "steps 覆盖");
    assert.strictEqual(wf["6"].inputs.seed, 0);
    assert.equal(wf["3"].inputs.vae_name, "v.safetensors", "视频 VAE");
    assert.equal(wf["4"].inputs.vae_name, "a.safetensors", "音频 VAE 不灌视频 VAE");
    assert.equal(wf["2"].inputs.prompt, "old prompt", "提示词交接期不注入，原样保留");
});
