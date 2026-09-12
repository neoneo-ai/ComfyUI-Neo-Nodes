// L1：NeoH3VideoDirector 节点内时间轴的最小尺寸钳制。
// LiteGraph 核心的 setSize 只替换 size 并触发 onResize，不检查 minWidth/minHeight，
// 拖拽缩小节点会把固定高度的时间轴裁掉——扩展必须在 onResize 里补钳制（最小高度含时间轴）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";
import { getExtension } from "./mocks/comfy-app.mjs";

const TL_H = 96; // 与 web/director-node.js 的 TL_H 保持一致
const BASE_W = 340;
const BASE_H = 220;

function makeDirectorNode() {
    const node = {
        id: 1,
        type: "NeoH3VideoDirector",
        properties: {},
        widgets: [{ name: "recipe", value: "" }],
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

async function createDirectorNode() {
    await import("../../web/director-node.js");
    const ext = getExtension("NeoH3VideoDirector.Timeline");
    assert.ok(ext, "director 时间轴扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoH3VideoDirector" });
    const node = makeDirectorNode();
    nodeType.prototype.onNodeCreated.call(node);
    return node;
}

test("创建后节点高度与最小高度都包含时间轴", async () => {
    resetEnv();
    const node = await createDirectorNode();
    assert.equal(node.size[0], BASE_W);
    assert.equal(node.size[1], BASE_H + TL_H);
    assert.equal(node.minWidth, BASE_W);
    assert.equal(node.minHeight, BASE_H + TL_H);
});

test("拖拽缩小被钳制在最小尺寸，时间轴不被裁切", async () => {
    resetEnv();
    const node = await createDirectorNode();
    node.setSize([200, 150]);
    assert.equal(node.size[0], BASE_W, "宽度应钳制到 minWidth");
    assert.equal(node.size[1], BASE_H + TL_H, "高度应钳制到含时间轴的 minHeight");
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
