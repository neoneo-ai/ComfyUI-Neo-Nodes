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
