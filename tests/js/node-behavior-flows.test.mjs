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

test("H3 审计事件：status 显示阶段、replace 整段替换正文", async () => {
    const H3_CHUNKS = [
        'data: {"text":"draft ","kind":"content"}',
        'data: {"text":"prompt","kind":"content"}',
        'data: {"text":"🔍 格式自检中…","kind":"status"}',
        'data: {"text":"✏️ 检测到格式问题，自动修复中…","kind":"status"}',
        'data: {"text":"✏️ 已自动修复格式","kind":"status"}',
        'data: {"text":"repaired final prompt","kind":"replace"}',
        "data: [DONE]",
    ];
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(H3_CHUNKS));

    const node = await makeNode(21);
    const el = parts(node);
    inputText(el.quickInput, "h3 video");
    keydown(el.quickInput, "Enter");
    await sleep(200);

    // replace 事件整段替换已透传的草稿，最终落盘的是修复后文本
    assert.equal(el.promptArea.value, "repaired final prompt");
    assert.equal(widgetValue(node, "prompt"), "repaired final prompt");
    // 流结束后状态行清除
    assert.equal(document.querySelector(".rs-thinking"), null);
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

test("输入 / 唤起 skill 快捷菜单：实时过滤 + Enter 提交写入下拉", async () => {
    const node = await makeNode(21);
    const el = parts(node);

    // 打 / 打开弹层（全量 5 个 skill）
    inputText(el.quickInput, "/");
    await sleep(100);
    let picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 5, "全量 skill 5 行");

    // 继续输入过滤：/ani → anime_style（id 命中）
    inputText(el.quickInput, "/ani");
    await sleep(100);
    picker = document.querySelector(".rs-slash-picker");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 1, "过滤后剩 1 行");
    // 副标题显示类别名称（image_enhance → 🎨 图像提示词增强），不再是 id
    assert.strictEqual(picker.querySelector(".rs-slash-picker-meta").textContent, "🎨 图像提示词增强", "meta 显示类别名称");

    // Enter 提交：写入下拉、清除 /query、关闭弹层
    keydown(picker, "Enter");
    await sleep(50);
    assert.strictEqual(document.querySelector(".rs-slash-picker"), null, "提交后弹层应移除");
    assert.strictEqual(el.selector.value, "anime_style", "skill 下拉应为 anime_style");
    assert.strictEqual(el.quickInput.value, "", "/query 应被清除");
});

test("输入 / 后 Esc 关闭菜单且不改变 skill 选择", async () => {
    const node = await makeNode(22);
    const el = parts(node);

    inputText(el.quickInput, "/");
    await sleep(100);
    const picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    keydown(picker, "Escape");
    await sleep(50);
    assert.strictEqual(document.querySelector(".rs-slash-picker"), null, "Esc 后弹层应移除");
    assert.strictEqual(el.quickInput.value, "/", "输入内容不应被改动");
});

test("输入 / 后按中文拼音（tags）匹配 skill", async () => {
    const node = await makeNode(23);
    const el = parts(node);

    inputText(el.quickInput, "/");
    await sleep(100);
    // 首字母缩写 dmfg 命中「动漫风格」的拼音标签
    inputText(el.quickInput, "/dm");
    await sleep(100);
    const picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 1, "拼音 dm 命中 1 行");
    assert.ok(picker.textContent.includes("动漫风格"), "命中的应是动漫风格");
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
