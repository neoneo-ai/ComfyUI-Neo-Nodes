// L1：节点创建后的 UI 结构与状态基线。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { domSnapshot, assertGolden, sleep, resetEnv, mockRoute, jsonResponse, clearRoutes } from "./setup.mjs";
import { SKILLS, createAgentNode, createEncoderNode, uiRoot, widgetValue } from "./helpers/node-ui.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
});

test("NeoPromptAgent 节点创建后的 UI 结构", async () => {
    await import("../../web/prompts.js");
    const node = await createAgentNode(7);
    await sleep(250);

    domSnapshot("agent.ui-root", uiRoot(node));
    domSnapshot("agent.body-overlays", document.body);
    assertGolden(
        "agent.widget-state",
        JSON.stringify({
            properties: node.properties,
            widgets: Object.fromEntries(node.widgets.map((w) => [w.name, w.value])),
        }, null, 2),
    );
});

test("NeoPrompts(Encoder) 节点创建后的 UI 结构", async () => {
    await import("../../web/prompts.js");
    const node = await createEncoderNode(8);
    await sleep(250);

    domSnapshot("encoder.ui-root", uiRoot(node));
    domSnapshot("encoder.body-overlays", document.body);
    assertGolden(
        "encoder.widget-state",
        JSON.stringify({
            properties: node.properties,
            widgets: Object.fromEntries(node.widgets.map((w) => [w.name, w.value])),
        }, null, 2),
    );
});

test("骰子折叠态按隐藏控件初值恢复", async () => {
    await import("../../web/prompts.js");
    const node = await createAgentNode(9);
    await sleep(250);

    const rt = uiRoot(node).querySelector(".rs-random-wrap .rs-random-btn")._rsRuntime;
    assert.equal(rt.checkbox.checked, false);
    assert.equal(rt.valueSpan.textContent, "1");
    assert.equal(widgetValue(node, "random_enabled"), false);
});
