// L2：关键交互流基线（随机取词、Enter 生成、skill 路由、缺图提示、运行时随机菜单）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    assertGolden,
    click,
    inputText,
    keydown,
    sleep,
    resetEnv,
    mockRoute,
    clearRoutes,
    jsonResponse,
    sseResponse,
    fetchLog,
    missingRoutes,
    dialogs,
} from "./setup.mjs";
import { SKILLS, createAgentNode, uiRoot, widgetValue } from "./helpers/node-ui.mjs";

const CHUNKS = ['data: {"text":"a cat "}', 'data: {"text":"in the rain"}', "data: [DONE]"];

beforeEach(() => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
});

function flowTrace() {
    const calls = fetchLog.map((c) => `${c.method} ${c.path}${c.body ? " " + JSON.stringify(c.body) : ""}`);
    return [
        ...calls,
        ...dialogs.alerts.map((m) => `alert: ${m}`),
        ...(missingRoutes.length ? missingRoutes.map((m) => `MISSING ROUTE: ${m}`) : []),
    ].join("\n");
}

async function makeNode(id) {
    await import("../../web/prompts.js");
    const node = await createAgentNode(id);
    await sleep(250);
    return node;
}

function parts(node) {
    const root = uiRoot(node);
    return {
        root,
        quickInput: root.querySelector("textarea.rs-quick-input"),
        promptArea: root.querySelector("textarea.comfy-multiline-input"),
        generateBtn: root.querySelector(".rs-generate-btn"),
        randomBtn: root.querySelector(".rs-random-wrap .rs-random-btn"),
        selector: root.querySelector("select.rs-tpl-selector"),
    };
}

function state(node, el) {
    return JSON.stringify(
        {
            promptArea: el.promptArea.value,
            quickInput: el.quickInput.value,
            widgets: {
                prompt: widgetValue(node, "prompt"),
                quick_input: widgetValue(node, "quick_input"),
                quick_input_used: widgetValue(node, "quick_input_used"),
            },
            properties: node.properties,
        },
        null,
        2,
    );
}

test("🎲 随机按钮：取 preset 列表并写入提示词", async () => {
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([{ name: "cats" }]));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `preset-text:${body.name}` }));

    const node = await makeNode(11);
    const el = parts(node);
    click(el.randomBtn);
    await sleep(200);

    assertGolden("flow.random", flowTrace());
    assert.equal(el.promptArea.value, "preset-text:cats");
    assert.equal(widgetValue(node, "prompt"), "preset-text:cats");
});

test("快捷输入 Enter：无 skill 时走流式生成并回填", async () => {
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(CHUNKS));

    const node = await makeNode(12);
    const el = parts(node);
    inputText(el.quickInput, "a cat");
    keydown(el.quickInput, "Enter");
    await sleep(200);

    assertGolden("flow.generate-stream", flowTrace());
    // 已知缺陷：onDone 里 cancelAnimationFrame 取消了「把 accumulated 写回 textarea」的待执行帧，
    // 紧接着 saveTextToStorage 读到空 textarea，把 prompt widget 冲成 ""（textarea 由 finally 兜底恢复）。
    // golden 记录的是当前行为；修复后需 npm run update-goldens。
    assertGolden("flow.generate-stream.state", state(node, el));
});

test("选中 skill：请求体带 skillId 与拼接后的 text", async () => {
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(CHUNKS));

    const node = await makeNode(13);
    const el = parts(node);
    el.selector.value = "anime_style";
    inputText(el.quickInput, "more detail");
    click(el.generateBtn);
    await sleep(200);

    assertGolden("flow.skill-generate", flowTrace());
});

test("@图 标记但无图片：提示需要图片且不发请求", async () => {
    const node = await makeNode(14);
    const el = parts(node);
    inputText(el.quickInput, "@图 一只猫");
    keydown(el.quickInput, "Enter");
    await sleep(200);

    assertGolden("flow.marker-needs-image", flowTrace());
});

test("运行时随机菜单：+/- 调整条数并写回隐藏控件", async () => {
    const node = await makeNode(15);
    const rt = parts(node).randomBtn._rsRuntime;
    click(rt.plusBtn);
    click(rt.plusBtn);
    click(rt.minusBtn);

    assertGolden(
        "flow.runtime-random",
        JSON.stringify(
            {
                checked: rt.checkbox.checked,
                count: rt.valueSpan.textContent,
                widgets: {
                    random_enabled: widgetValue(node, "random_enabled"),
                    random_count: widgetValue(node, "random_count"),
                },
                properties: node.properties.rs_runtime_random,
            },
            null,
            2,
        ),
    );
});
