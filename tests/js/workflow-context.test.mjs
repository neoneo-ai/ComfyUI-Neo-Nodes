// L1：collectWorkflowContext 关键路径——H3 节点检测、参考图回溯、非活跃过滤。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, graph } from "./setup.mjs";

const { makeGraph, makeNode, addNode, connect, slot, outSlot, makeWidget } = graph;

test("空图返回 null", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    assert.equal(await collectWorkflowContext(g), null);
});

test("无 H3 节点返回 null", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    addNode(g, makeNode({ id: 1, type: "KSampler" }));
    assert.equal(await collectWorkflowContext(g), null);
});

test("检测活跃 H3 节点及其 widget 参数", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    addNode(g, makeNode({
        id: 10,
        type: "MiniMaxH3ReferenceToVideo",
        widgets: [
            makeWidget("width", 1280),
            makeWidget("height", 720),
            makeWidget("length", 192),
            makeWidget("ref_image_size", 1024),
        ],
    }));
    const ctx = await collectWorkflowContext(g);
    assert.ok(ctx, "应返回非 null");
    assert.equal(ctx.h3.length, 1);
    assert.equal(ctx.h3[0].type, "MiniMaxH3ReferenceToVideo");
    assert.equal(ctx.h3[0].width, 1280);
    assert.equal(ctx.h3[0].height, 720);
    assert.equal(ctx.h3[0].length, 192);
    assert.equal(ctx.h3[0].ref_image_size, 1024);
    assert.equal(ctx.h3[0].aspect, "16:9");
});

test("非活跃 H3 节点被忽略", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    addNode(g, makeNode({ id: 10, type: "MiniMaxH3ReferenceToVideo", widgets: [makeWidget("width", 640)] }));
    g._nodes[0].mode = 2;
    assert.equal(await collectWorkflowContext(g), null);
});

test("参考图回溯：LoadImage → H3 ref_image_0", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    const loader = makeNode({ id: 1, type: "LoadImage", widgets: [makeWidget("image", "test_ref.png")] });
    loader.outputs = [outSlot("IMAGE")];
    addNode(g, loader);
    const h3 = makeNode({
        id: 10,
        type: "MiniMaxH3ReferenceToVideo",
        widgets: [makeWidget("width", 1280), makeWidget("height", 720)],
        inputs: [slot("ref_image_0", "IMAGE")],
    });
    addNode(g, h3);
    connect(g, loader, h3, { fromSlot: 0, toSlot: 0, type: "IMAGE" });

    const ctx = await collectWorkflowContext(g);
    assert.ok(ctx);
    assert.equal(ctx.h3.length, 1);
    assert.equal(ctx.references.length, 1);
    assert.equal(ctx.references[0].kind, "image");
    assert.equal(ctx.references[0].source.value, "test_ref.png");
    assert.ok(ctx.h3[0].refs);
    assert.deepEqual(ctx.h3[0].refs.pictures, ["test_ref.png"]);
});
test("多个参考图按序号排列", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    const loader1 = makeNode({ id: 1, type: "LoadImage", widgets: [makeWidget("image", "pic_a.png")] });
    loader1.outputs = [outSlot("IMAGE")];
    addNode(g, loader1);
    const loader2 = makeNode({ id: 2, type: "LoadImage", widgets: [makeWidget("image", "pic_b.png")] });
    loader2.outputs = [outSlot("IMAGE")];
    addNode(g, loader2);
    const h3 = makeNode({
        id: 10,
        type: "MiniMaxH3ReferenceToVideo",
        widgets: [makeWidget("width", 640), makeWidget("height", 480)],
        inputs: [slot("ref_image_0", "IMAGE"), slot("ref_image_1", "IMAGE")],
    });
    addNode(g, h3);
    connect(g, loader1, h3, { fromSlot: 0, toSlot: 0, type: "IMAGE" });
    connect(g, loader2, h3, { fromSlot: 0, toSlot: 1, type: "IMAGE" });

    const ctx = await collectWorkflowContext(g);
    assert.ok(ctx);
    assert.deepEqual(ctx.h3[0].refs.pictures, ["pic_a.png", "pic_b.png"]);
});

test("width 输入被连线覆盖时丢弃 widget 值，保留 aspect", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const g = makeGraph();
    const resSel = makeNode({ id: 5, type: "ResolutionSelector", widgets: [makeWidget("aspect_ratio", "16:9 (Widescreen)")] });
    resSel.outputs = [outSlot("width"), outSlot("height")];
    addNode(g, resSel);
    const h3 = makeNode({
        id: 10,
        type: "MiniMaxH3ReferenceToVideo",
        widgets: [makeWidget("width", 512), makeWidget("height", 512)],
        inputs: [slot("width", "INT")],
    });
    addNode(g, h3);
    connect(g, resSel, h3, { fromSlot: 0, toSlot: 0, type: "INT" });

    const ctx = await collectWorkflowContext(g);
    assert.ok(ctx);
    assert.equal(ctx.h3[0].width, undefined);
    assert.equal(ctx.h3[0].height, undefined);
    assert.equal(ctx.h3[0].aspect, "16:9");
});

test("node.graph 回归：新图引用能正确采集", async () => {
    const { collectWorkflowContext } = await import("../../web/workflow-context.js");
    const staleGraph = makeGraph();
    const currentGraph = makeGraph();
    addNode(currentGraph, makeNode({
        id: 10,
        type: "MiniMaxH3ReferenceToVideo",
        widgets: [makeWidget("width", 1280), makeWidget("height", 720)],
    }));
    const neoNode = makeNode({ id: 99, type: "NeoPromptAgent" });
    addNode(currentGraph, neoNode);
    assert.equal(neoNode.graph, currentGraph);

    // 旧图采集 → null（复现 bug）
    assert.equal(await collectWorkflowContext(staleGraph), null);
    // node.graph 采集 → 有 H3 上下文（修复后行为）
    const ctx = await collectWorkflowContext(neoNode.graph);
    assert.ok(ctx);
    assert.equal(ctx.h3.length, 1);
});
