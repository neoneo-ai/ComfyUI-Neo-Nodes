// 技能 ⇄ 画布同步：详情弹窗工作流区带「⤒ 导入到画布」/「💾 回写入技能」
// 导入把技能 workflow.json 按当前设置预渲染后 app.loadApiJson 落画布；回写把画布 API prompt 落盘该技能 workflow.json。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

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

test("内嵌详情（无画布）时工作流区不挂画布按钮", async () => {
    await openPopup({ id: "custom_a", source: "custom", canvasBtns: false });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "工作流区仍渲染");
    assert.equal(document.querySelector(".rs-wf-canvas-btns"), null, "无画布时不挂导入/回写按钮");
});
