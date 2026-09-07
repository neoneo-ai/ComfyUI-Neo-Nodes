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
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

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
    // onDone 取消待执行的合并帧前先把 accumulated 写回 textarea，saveTextToStorage 才能读到最新文本。
    // golden 记录当前行为；若行为有意变化，需 npm run update-goldens。
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

test("@ 图片选择器：无可用图片时给占位提示，不叠加弹层且可关闭后重开", async () => {
    const node = await makeNode(20);
    const el = parts(node);

    inputText(el.quickInput, "@");
    await sleep(100);
    const picker = document.querySelector(".rs-at-picker");
    assert.ok(picker);
    assert.ok(picker.textContent.includes("没有可用的 Load Image"));

    // 已有弹层时再输入 @ 不再叠加第二个
    inputText(el.quickInput, "@@");
    await sleep(100);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 1);

    keydown(picker, "Escape");
    await sleep(50);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 0);

    // 关闭后同一节点仍可再次打开
    inputText(el.quickInput, "x@");
    await sleep(100);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 1);
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

test("流式更新事件：写回提示词并同帧切到 Markdown 预览，复选框可回写", async () => {
    const node = await makeNode(16);
    const el = parts(node);

    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties?.rs_instance_uid,
        prompt: "## 大纲\n- [ ] 开场",
    });

    assert.equal(el.promptArea.value, "## 大纲\n- [ ] 开场");
    assert.equal(widgetValue(node, "prompt"), "## 大纲\n- [ ] 开场");

    const preview = uiRoot(node).querySelector(".rs-md-preview.rs-prompt-md-preview");
    assert.equal(preview.style.display, "block");
    assert.ok(
        uiRoot(node).querySelector(".rs-md-preview-btn").classList.contains("rs-md-preview-active"),
    );
    assert.equal(preview.querySelectorAll('input[type="checkbox"]').length, 1);

    // 预览里的任务复选框放开给点击：勾选状态写回 textarea 源码并经 input 事件同步 widget
    // DOM 规范对复选框是 pre-click activation，派发时 checked 已是新值，直接 click 即模拟真实勾选
    const box = preview.querySelectorAll('input[type="checkbox"]')[0];
    assert.equal(box.disabled, false);
    click(box);
    assert.equal(box.checked, true);
    assert.match(el.promptArea.value, /- \[[xX]\] 开场/);
    assert.equal(widgetValue(node, "prompt"), el.promptArea.value);
});

test("流式更新事件按 instance_uid 隔离，不跨节点写入", async () => {
    const a = await makeNode(17);
    const b = await makeNode(18);
    const beforeB = parts(b).promptArea.value;

    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: a.properties.rs_instance_uid,
        prompt: "只给 A 的内容",
    });

    assert.equal(parts(a).promptArea.value, "只给 A 的内容");
    assert.equal(parts(b).promptArea.value, beforeB);
});

test("节点移除后注销全局监听并清掉挂 body 的浮层", async () => {
    const node = await makeNode(19);
    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties.rs_instance_uid,
        prompt: "移除前",
    });
    assert.equal(parts(node).promptArea.value, "移除前");
    // 骰子菜单与自动增强菜单都挂在 body，各节点一份
    assert.equal(document.querySelectorAll(".rs-runtime-menu").length, 2);

    node.onRemoved();

    assert.equal(document.querySelectorAll(".rs-runtime-menu").length, 0);
    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties.rs_instance_uid,
        prompt: "移除后不应写入",
    });
    assert.equal(parts(node).promptArea.value, "移除前");
});
