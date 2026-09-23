// NeoImageGenEdit 节点：width/height/steps 默认跟随所选 skill 预设（/neo_image_gen/skill_dims）。
// 参考 web/director-node.js 的 applyDimDefaults：仅当仍为 -1 时填充，切换 skill_id 下拉强制重填。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, window } from "./setup.mjs";
import { getExtension } from "./mocks/comfy-app.mjs";

function makeNode(skillId = "", width = -1, height = -1, steps = -1) {
    return {
        id: 1,
        type: "NeoImageGenEdit",
        properties: {},
        widgets: [
            { name: "skill_id", value: skillId },
            { name: "width", value: width },
            { name: "height", value: height },
            { name: "steps", value: steps },
        ],
        // addDOMWidget 挂在 domWidgets 上、不混入 widgets：真实 LGraphNode 的 DOM 控件不参与 widgets_values 位置还原
        domWidgets: [],
        addDOMWidget(name, type, el) {
            const w = { name, type, el };
            this.domWidgets.push(w);
            return w;
        },
    };
}

async function createNode(skillId = "", width = -1, height = -1, steps = -1) {
    await import("../../web/image-gen-edit-node.js");
    const ext = getExtension("NeoImageGenEdit.DimDefaults");
    assert.ok(ext, "krea2 dim 扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoImageGenEdit" });
    const node = makeNode(skillId, width, height, steps);
    nodeType.prototype.onNodeCreated.call(node);
    return node;
}

const w = (node, name) => node.widgets.find((x) => x.name === name);

test("创建时仍为 -1 的 width/height/steps 被 skill 预设填充", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1280, height: 720, steps: 25 }));
    const node = await createNode("Alpha");
    await sleep(40);
    assert.equal(w(node, "width").value, 1280);
    assert.equal(w(node, "height").value, 720);
    assert.equal(w(node, "steps").value, 25);
});

test("已存实值（非 -1）在首次载入时不被覆盖", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1280, height: 720, steps: 25 }));
    const node = await createNode("Alpha", 512, 384, 8);
    await sleep(40);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
    assert.equal(w(node, "steps").value, 8);
});

test("切换 skill_id 下拉强制重填预设宽高/步数", async () => {
    resetEnv();
    clearRoutes();
    let dims = { success: true, width: 1280, height: 720, steps: 25 };
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse(dims));
    const node = await createNode("Alpha");
    await sleep(40);
    assert.equal(w(node, "width").value, 1280);
    assert.equal(w(node, "steps").value, 25);

    // 用户手改后切换 skill → force 重填为新预设
    dims = { success: true, width: 768, height: 1344, steps: 8 };
    w(node, "width").value = 999;
    w(node, "height").value = 888;
    w(node, "steps").value = 30;
    w(node, "skill_id").callback?.("Beta");
    await sleep(40);
    assert.equal(w(node, "width").value, 768);
    assert.equal(w(node, "height").value, 1344);
    assert.equal(w(node, "steps").value, 8);
});

test("无 skill_id 时不请求也不填充", async () => {
    resetEnv();
    clearRoutes();
    let called = false;
    mockRoute("/neo_image_gen/skill_dims", () => { called = true; return jsonResponse({ success: true, width: 1, height: 1, steps: 1 }); });
    const node = await createNode("");
    await sleep(40);
    assert.equal(called, false);
    assert.equal(w(node, "width").value, -1);
    assert.equal(w(node, "steps").value, -1);
});

// 全量 widget（含 seed 后自动追加的 control_after_generate；steps 在末尾，旧工作流 widgets_values 无此位）
function makeFullNode({ skillId = "", prompt = "", seed = 0, control = "fixed", count = 1, width = -1, height = -1, steps = -1 } = {}) {
    return {
        id: 1,
        type: "NeoImageGenEdit",
        properties: {},
        widgets: [
            { name: "skill_id", value: skillId },
            { name: "prompt", value: prompt },
            { name: "seed", value: seed },
            { name: "control_after_generate", value: control, options: { values: ["fixed", "randomize", "increment"] } },
            { name: "count", value: count },
            { name: "width", value: width },
            { name: "height", value: height },
            { name: "steps", value: steps },
        ],
        domWidgets: [],
        addDOMWidget(name, type, el) {
            const w = { name, type, el };
            this.domWidgets.push(w);
            return w;
        },
    };
}

async function configureFullNode(node, data) {
    await import("../../web/image-gen-edit-node.js");
    const ext = getExtension("NeoImageGenEdit.DimDefaults");
    assert.ok(ext, "krea2 dim 扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoImageGenEdit" });
    nodeType.prototype.onNodeCreated.call(node);
    node.onConfigure?.(data); // onConfigure 是实例钩子，onNodeCreated 内挂接（先于 configure 运行）
    return node;
}

test("control_after_generate 落到数字时复位并强制重填宽高/步数", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864, steps: 25 }));
    const node = makeFullNode({ skillId: "图示角色图", seed: 1, control: 1536, count: 864, width: 1536, height: 864 });
    await configureFullNode(node, { widgets_values: ["图示角色图", "", 1, 1536, 864, 1536, 864] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 1);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
    assert.equal(w(node, "steps").value, 25);
});

test("旧格式（widgets_values 少于当前 widget 数）载入强制重填宽高/步数、不动有效 control/count", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864, steps: 25 }));
    const node = makeFullNode({ skillId: "文生图", seed: 11, control: "fixed", count: 3, width: -1, height: -1 });
    await configureFullNode(node, { widgets_values: ["文生图", "", 11, "fixed", 3] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 3);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
    assert.equal(w(node, "steps").value, 25);
});

test("当前格式（值齐）载入不改动", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864, steps: 25 }));
    const node = makeFullNode({ skillId: "文生图", seed: 11, control: "randomize", count: 2, width: 512, height: 384, steps: 8 });
    await configureFullNode(node, { widgets_values: ["文生图", "", 11, "randomize", 2, 512, 384, 8] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "randomize");
    assert.equal(w(node, "count").value, 2);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
    assert.equal(w(node, "steps").value, 8);
});

test("复制粘贴整块串位（control 与 seed 均非法）复位 control/seed/count 并重填宽高/步数", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864, steps: 25 }));
    const node = makeFullNode({ skillId: "图示角色图", seed: -1, control: -1, count: -1, width: -1, height: -1 });
    await configureFullNode(node, { widgets_values: ["图示角色图", "", -1, -1, -1, -1, -1] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "seed").value, 0);
    assert.equal(w(node, "count").value, 1);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
    assert.equal(w(node, "steps").value, 25);
});

test("仅 seed 为 NaN（control 正常）时只复位 seed，不动 control/count/宽高/步数", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864, steps: 25 }));
    const node = makeFullNode({ skillId: "文生图", seed: NaN, control: "fixed", count: 2, width: 512, height: 384, steps: 8 });
    await configureFullNode(node, { widgets_values: ["文生图", "", NaN, "fixed", 2, 512, 384, 8] });
    await sleep(40);
    assert.equal(w(node, "seed").value, 0);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 2);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
    assert.equal(w(node, "steps").value, 8);
});

// ---- 节点底部 skill 有效性状态条（createSkillStatusRow 接入）----

const OBJ_INFO = { UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } } };
const WF_MISSING = { "1": { class_type: "UNETLoader", inputs: { unet_name: "no_such.safetensors" } } };
const WF_READY = { "1": { class_type: "UNETLoader", inputs: { unet_name: "real.safetensors" } } };

function mockStatusRoutes(getWorkflow) {
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1024, height: 1024 }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ workflow: getWorkflow() }));
    mockRoute("/object_info", () => jsonResponse(OBJ_INFO));
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(call.method === "GET" ? {} : { success: true }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["real.safetensors"], text_encoders: [], vae: [], loras: [] }));
}

test("节点底部挂 skill 状态条：缺模型时告警，切换 skill 后按新技能重检收起", async () => {
    resetEnv();
    clearRoutes();
    let workflow = WF_MISSING;
    mockStatusRoutes(() => workflow);

    const node = await createNode("krea_missing");
    const statusWidget = node.domWidgets.find((x) => x.name === "skill_status");
    assert.ok(statusWidget, "节点应挂载 skill 状态条 DOM widget");
    assert.ok(statusWidget.el.classList.contains("neo-skill-status"), "应使用状态条样式类");
    await sleep(60);
    assert.notEqual(statusWidget.el.style.display, "none", "缺模型应显示告警条");
    assert.ok(statusWidget.el.querySelector(".neo-skill-status-label").textContent.includes("1 个模型缺失"));

    // 换到工作流齐备的新技能 → 重检后收起告警
    workflow = WF_READY;
    w(node, "skill_id").value = "krea_ready";
    w(node, "skill_id").callback?.("krea_ready");
    await sleep(80);
    assert.equal(statusWidget.el.style.display, "none", "切换 skill 后应按新技能重检");
});

test("节点移除时状态条注销 SKILL_CHANGED_EVENT 监听", async () => {
    resetEnv();
    clearRoutes();
    let workflow = WF_MISSING;
    mockStatusRoutes(() => workflow);

    const node = await createNode("krea_removed");
    const statusWidget = node.domWidgets.find((x) => x.name === "skill_status");
    await sleep(60);
    assert.notEqual(statusWidget.el.style.display, "none", "缺模型应显示告警条");

    // 移除节点后事件不应再驱动该状态条：若监听仍在，事件会把告警条按 WF_READY 重检后收起
    workflow = WF_READY;
    node.onRemoved?.();
    window.dispatchEvent(new window.CustomEvent("neo.skillChanged", { detail: { skillId: "krea_removed" } }));
    await sleep(80);
    assert.notEqual(statusWidget.el.style.display, "none", "移除后事件不应再驱动检测");
});

