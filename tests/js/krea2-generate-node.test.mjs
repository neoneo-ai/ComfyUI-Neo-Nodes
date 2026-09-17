// NeoKrea2Generate 节点：width/height 默认跟随所选 skill 预设（/neo_image_gen/skill_dims）。
// 参考 web/director-node.js 的 applyDimDefaults：仅当仍为 -1 时填充，切换 skill_id 下拉强制重填。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";
import { getExtension } from "./mocks/comfy-app.mjs";

function makeNode(skillId = "", width = -1, height = -1) {
    return {
        id: 1,
        type: "NeoKrea2Generate",
        properties: {},
        widgets: [
            { name: "skill_id", value: skillId },
            { name: "width", value: width },
            { name: "height", value: height },
        ],
    };
}

async function createNode(skillId = "", width = -1, height = -1) {
    await import("../../web/krea2-generate-node.js");
    const ext = getExtension("NeoKrea2Generate.DimDefaults");
    assert.ok(ext, "krea2 dim 扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoKrea2Generate" });
    const node = makeNode(skillId, width, height);
    nodeType.prototype.onNodeCreated.call(node);
    return node;
}

const w = (node, name) => node.widgets.find((x) => x.name === name);

test("创建时仍为 -1 的 width/height 被 skill 预设填充", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1280, height: 720 }));
    const node = await createNode("Alpha");
    await sleep(40);
    assert.equal(w(node, "width").value, 1280);
    assert.equal(w(node, "height").value, 720);
});

test("已存实值（非 -1）在首次载入时不被覆盖", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1280, height: 720 }));
    const node = await createNode("Alpha", 512, 384);
    await sleep(40);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
});

test("切换 skill_id 下拉强制重填预设尺寸", async () => {
    resetEnv();
    clearRoutes();
    let dims = { success: true, width: 1280, height: 720 };
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse(dims));
    const node = await createNode("Alpha");
    await sleep(40);
    assert.equal(w(node, "width").value, 1280);

    // 用户手改后切换 skill → force 重填为新预设
    dims = { success: true, width: 768, height: 1344 };
    w(node, "width").value = 999;
    w(node, "height").value = 888;
    w(node, "skill_id").callback?.("Beta");
    await sleep(40);
    assert.equal(w(node, "width").value, 768);
    assert.equal(w(node, "height").value, 1344);
});

test("无 skill_id 时不请求也不填充", async () => {
    resetEnv();
    clearRoutes();
    let called = false;
    mockRoute("/neo_image_gen/skill_dims", () => { called = true; return jsonResponse({ success: true, width: 1, height: 1 }); });
    const node = await createNode("");
    await sleep(40);
    assert.equal(called, false);
    assert.equal(w(node, "width").value, -1);
});

// 全量 widget（含 seed 后自动追加的 control_after_generate），用于测旧工作流/复制粘贴串位修复
function makeFullNode({ skillId = "", prompt = "", seed = 0, control = "fixed", count = 1, width = -1, height = -1 } = {}) {
    return {
        id: 1,
        type: "NeoKrea2Generate",
        properties: {},
        widgets: [
            { name: "skill_id", value: skillId },
            { name: "prompt", value: prompt },
            { name: "seed", value: seed },
            { name: "control_after_generate", value: control, options: { values: ["fixed", "randomize", "increment"] } },
            { name: "count", value: count },
            { name: "width", value: width },
            { name: "height", value: height },
        ],
    };
}

async function configureFullNode(node, data) {
    await import("../../web/krea2-generate-node.js");
    const ext = getExtension("NeoKrea2Generate.DimDefaults");
    assert.ok(ext, "krea2 dim 扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoKrea2Generate" });
    nodeType.prototype.onNodeCreated.call(node);
    node.onConfigure?.(data); // onConfigure 是实例钩子，onNodeCreated 内挂接（先于 configure 运行）
    return node;
}

test("control_after_generate 落到数字时复位并强制重填宽高", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864 }));
    const node = makeFullNode({ skillId: "图示角色图", seed: 1, control: 1536, count: 864, width: 1536, height: 864 });
    await configureFullNode(node, { widgets_values: ["图示角色图", "", 1, 1536, 864, 1536, 864] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 1);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
});

test("旧格式（widgets_values 少于当前 widget 数）载入强制重填宽高、不动有效 control/count", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864 }));
    const node = makeFullNode({ skillId: "文生图", seed: 11, control: "fixed", count: 3, width: -1, height: -1 });
    await configureFullNode(node, { widgets_values: ["文生图", "", 11, "fixed", 3] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 3);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
});

test("当前格式（值齐）载入不改动", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864 }));
    const node = makeFullNode({ skillId: "文生图", seed: 11, control: "randomize", count: 2, width: 512, height: 384 });
    await configureFullNode(node, { widgets_values: ["文生图", "", 11, "randomize", 2, 512, 384] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "randomize");
    assert.equal(w(node, "count").value, 2);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
});

test("复制粘贴整块串位（control 与 seed 均非法）复位 control/seed/count 并重填宽高", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864 }));
    const node = makeFullNode({ skillId: "图示角色图", seed: -1, control: -1, count: -1, width: -1, height: -1 });
    await configureFullNode(node, { widgets_values: ["图示角色图", "", -1, -1, -1, -1, -1] });
    await sleep(40);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "seed").value, 0);
    assert.equal(w(node, "count").value, 1);
    assert.equal(w(node, "width").value, 1536);
    assert.equal(w(node, "height").value, 864);
});

test("仅 seed 为 NaN（control 正常）时只复位 seed，不动 control/count/宽高", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_image_gen/skill_dims", () => jsonResponse({ success: true, width: 1536, height: 864 }));
    const node = makeFullNode({ skillId: "文生图", seed: NaN, control: "fixed", count: 2, width: 512, height: 384 });
    await configureFullNode(node, { widgets_values: ["文生图", "", NaN, "fixed", 2, 512, 384] });
    await sleep(40);
    assert.equal(w(node, "seed").value, 0);
    assert.equal(w(node, "control_after_generate").value, "fixed");
    assert.equal(w(node, "count").value, 2);
    assert.equal(w(node, "width").value, 512);
    assert.equal(w(node, "height").value, 384);
});
