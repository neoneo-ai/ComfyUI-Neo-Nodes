// 出图（Krea2）skill 交互流：节点 image 连接 → 参考图请求；无连接 → 文生图；
// 上游无文件名 → 明确报错、不发请求。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    resetEnv,
    mockRoute,
    clearRoutes,
    jsonResponse,
    fetchLog,
    sleep,
} from "./setup.mjs";
import { getExtension, appState } from "./mocks/comfy-app.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";
import { makeGraph, makeNode, addNode, connect, agentWidgets, slot, outSlot } from "./helpers/fake-graph.mjs";

const SKILL_WITH_IMAGE_GEN = [
    { id: "image_gen", name: "出图 Krea2 四视图", category: "image_gen", source: "preset", gen_image: true, requires_ref: true },
    { id: "image_gen_text", name: "出图 Krea2 文生图", category: "image_gen", source: "preset", gen_image: true },
];

beforeEach(() => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILL_WITH_IMAGE_GEN));
    // 出图表单 load/save 与任务状态兜底首拉依赖的路由
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ model: "", loras: [], count: 1, base_resolution: 1280, default_ratio: "1:1" }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [], loras: [] }));
});

// 经真实注册流程把 onNodeCreated 挂到一个指定 graph 内的 NeoPromptAgent 节点
async function attachAgent(gen) {
    await import("../../web/prompts.js");
    const ext = getExtension("NeoPromptAgent");
    const def = { prototype: {} };
    await ext.beforeRegisterNodeDef(def, { name: "NeoPromptAgent" }, null);
    def.prototype.onNodeCreated.call(gen);
    return gen;
}

function parts(node) {
    const root = node.domWidgets[0].el;
    return {
        root,
        generateBtn: root.querySelector(".rs-generate-btn"),
        selector: root.querySelector("select.rs-tpl-selector"),
        preview: root.querySelector(".rs-md-preview"),
        status: root.querySelector(".rs-gen-status"),
    };
}

function setSkill(selector, id) {
    selector.value = id;
    selector.dispatchEvent(new Event("change"));
}

function genCalls() {
    return fetchLog.filter((c) => c.path === "/neo_image_gen/generate");
}

// 在 graph 内新建 agent 节点（与 src 同一 graph，便于连接）
function makeAgentIn(def, graph, id) {
    return makeNode({
        id, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    });
}

test("节点 image 连接 LoadImage：出图请求携带参考图，走重绘", async () => {
    const graph = makeGraph();
    const src = addNode(graph, makeNode({
        id: 1, type: "LoadImage",
        widgets: [{ name: "image", value: "ref.png", type: "combo" }],
        inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
    }));

    const gen = addNode(graph, makeNode({
        id: 2, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    connect(graph, src, gen, { toSlot: 1, type: "IMAGE" });
    await attachAgent(gen);

    const el = parts(gen);
    await sleep(400); // 等待 populateTemplateSelector 异步拉取 skills 并填充 option
    setSkill(el.selector, "image_gen");

    let body = null;
    mockRoute("/neo_image_gen/generate", (b) => { body = b; return jsonResponse({ task_id: "t1", status: "queued", images: [], width: 0, height: 0 }); });
    mockRoute("/neo_image_gen/status/t1", () => jsonResponse({ task_id: "t1", status: "succeeded", images: [{ filename: "a.png", subfolder: "", url: "/a.png" }], width: 2, height: 3 }));

    el.root.querySelector(".rs-quick-input").value = "";
    el.generateBtn.click();
    await sleep(300);

    assert.ok(body, "应发出 /neo_image_gen/generate 请求");
    assert.equal(body.references.length, 1);
    assert.equal(body.references[0].kind, "input");
    assert.equal(body.references[0].value, "ref.png");
});

test("纯文生图 skill：无参考图，请求不携带参考图，比例由出图设置决定", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 2, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    let body = null;
    mockRoute("/neo_image_gen/generate", (b) => { body = b; return jsonResponse({ task_id: "t2", status: "queued", images: [], width: 0, height: 0 }); });
    mockRoute("/neo_image_gen/status/t2", () => jsonResponse({ task_id: "t2", status: "succeeded", images: [], width: 1, height: 1 }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(300);

    assert.ok(body, "应发出 /neo_image_gen/generate 请求");
    assert.equal(body.references.length, 0);
    assert.equal(body.skill_ratio, undefined, "文生图比例由出图设置决定，不随 skill 声明");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/enhance").length, 0,
        "未启用 enhance_prompt 时不应调用 LLM 增强接口");
    assert.equal(body.prompt, "一只猫", "跳过增强时应直接提交原文");
});

test("四视图 skill 缺参考图：预览区底部报错，不发 /neo_image_gen/generate", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 2, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen");

    el.root.querySelector(".rs-quick-input").value = "重绘";
    el.generateBtn.click();
    await sleep(300);

    assert.equal(genCalls().length, 0, "缺参考图时不应发出出图请求");
    assert.ok(el.preview.querySelector(".rs-gen-error"), "预览区应显示错误提示块");
    assert.ok(el.preview.textContent.includes("需要参考图"), "结果块应显示缺少参考图提示");
});

test("image 已连接但上游无文件名：出图明确报错，不发 /neo_image_gen/generate", async () => {
    const graph = makeGraph();
    const src = addNode(graph, makeNode({
        id: 3, type: "SomethingOutputImage",
        widgets: [{ name: "x", value: "", type: "INT" }],
        inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
    }));
    const gen = addNode(graph, makeNode({
        id: 4, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    connect(graph, src, gen, { toSlot: 1, type: "IMAGE" });
    await attachAgent(gen);

    const el = parts(gen);
    await sleep(400);
    setSkill(el.selector, "image_gen");

    el.root.querySelector(".rs-quick-input").value = "重绘";
    el.generateBtn.click();
    await sleep(300);

    assert.equal(genCalls().length, 0, "上游无文件名时不应发出出图请求");
    assert.ok(el.preview.querySelector(".rs-gen-error"), "预览区应显示错误提示块");
    assert.ok(el.preview.textContent.includes("无法从上游节点解析"), "结果块应显示参考图读取失败");
});

test("出图成功：预览区渲染缩略图，点击用灯箱打开原图", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 5, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t3", status: "queued", images: [], width: 0, height: 0 }));
    mockRoute("/neo_image_gen/status/t3", () => jsonResponse({
        task_id: "t3", status: "succeeded",
        images: [{ filename: "a.png", subfolder: "NeoAgent/2026-09-07/cat", url: "/view?filename=a.png&type=output" }],
        width: 1280, height: 720,
    }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(1800); // 轮询间隔 1.5s，等首次 status 返回 succeeded

    const thumb = el.preview.querySelector(".rs-gen-thumb img");
    assert.ok(thumb, "出图结果块应渲染缩略图");
    assert.match(thumb.src, /neo_gallery\/thumbnail\?filename=a\.png/, "缩略图应走 thumbnail 缓存接口而非原图");
    assert.doesNotMatch(thumb.src, /\/view\?/);

    thumb.click();
    await sleep(50);
    const lb = document.querySelector(".neo-lightbox");
    assert.ok(lb, "点击缩略图应打开灯箱");
    const media = lb.querySelector("img");
    assert.equal(media.getAttribute("src"), "/view?filename=a.png&type=output", "灯箱内应显示原图地址");
});

test("出图成功：单个 LoadImage 目标 → 点击发送直接写入，不弹菜单", async () => {
    const graph = makeGraph();
    appState.graph = graph; // collectLoadImageTargets 从 app.graph._nodes 收集目标
    const loadImg = addNode(graph, makeNode({
        id: 6, type: "LoadImage", title: "Load Image",
        widgets: [{ name: "image", value: "old.png", type: "combo", callback(v) { this.value = v; } }],
        inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
    }));
    const agent = await attachAgent(makeNode({
        id: 7, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t4", status: "queued", images: [], width: 0, height: 0 }));
    mockRoute("/neo_image_gen/status/t4", () => jsonResponse({
        task_id: "t4", status: "succeeded",
        images: [{ filename: "b.png", subfolder: "", url: "/view?filename=b.png&type=output" }],
        width: 1280, height: 720,
    }));
    let copyQuery = null;
    mockRoute("/neo_gallery/copy_to_input", () => { copyQuery = "hit"; return jsonResponse({ success: true, filename: "b.png", skipped: false }); });

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(1800);

    const sendBtn = el.preview.querySelector(".rs-gen-send");
    assert.ok(sendBtn, "应渲染发送到节点按钮");
    sendBtn.click();
    await sleep(100);
    assert.equal(document.querySelector(".rs-gen-send-menu"), null, "单目标不应弹出菜单，直接写入");
    assert.ok(copyQuery, "应请求 /neo_gallery/copy_to_input");
    assert.equal(loadImg.widgets[0].value, "b.png", "LoadImage widget 值应更新为新图");
});

test("出图成功：多个 LoadImage 目标 → 弹菜单，选中写入对应节点", async () => {
    const graph = makeGraph();
    appState.graph = graph;
    const a = addNode(graph, makeNode({
        id: 6, type: "LoadImage", title: "A",
        widgets: [{ name: "image", value: "a.png", type: "combo", callback(v) { this.value = v; } }],
        inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
    }));
    const b = addNode(graph, makeNode({
        id: 8, type: "LoadImage", title: "B",
        widgets: [{ name: "image", value: "b.png", type: "combo", callback(v) { this.value = v; } }],
        inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
    }));
    const agent = await attachAgent(makeNode({
        id: 9, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t5", status: "queued", images: [], width: 0, height: 0 }));
    mockRoute("/neo_image_gen/status/t5", () => jsonResponse({
        task_id: "t5", status: "succeeded",
        images: [{ filename: "c.png", subfolder: "", url: "/view?filename=c.png&type=output" }],
        width: 1280, height: 720,
    }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "c.png", skipped: false }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(1800);

    document.body.appendChild(el.root); // 菜单现内联插入按钮下方，anchor 需在 document 中
    el.preview.querySelector(".rs-gen-send").click();
    await sleep(50);
    const menu = document.querySelector(".rs-gen-send-menu");
    assert.ok(menu, "多目标应弹出菜单");
    const items = menu.querySelectorAll(".rs-gen-send-menu-item");
    assert.equal(items.length, 2, "菜单应列出两个 LoadImage 节点");
    items[0].click(); // 排序后第一个（画布 y→x）
    await sleep(100);
    assert.ok(a.widgets[0].value === "c.png" || b.widgets[0].value === "c.png", "选中的节点应写入新图");
});

test("出图成功：无 LoadImage 目标 → 自动新建并写入", async () => {
    const graph = makeGraph();
    appState.graph = graph;
    let created = null;
    globalThis.LiteGraph = {
        createNode(type) {
            created = makeNode({
                id: 99, type, title: "Load Image",
                widgets: [{ name: "image", value: "", type: "combo", callback(v) { this.value = v; } }],
                inputs: [], outputs: [outSlot("IMAGE", "IMAGE")],
            });
            return created;
        },
    };
    const agent = await attachAgent(makeNode({
        id: 10, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t6", status: "queued", images: [], width: 0, height: 0 }));
    mockRoute("/neo_image_gen/status/t6", () => jsonResponse({
        task_id: "t6", status: "succeeded",
        images: [{ filename: "d.png", subfolder: "", url: "/view?filename=d.png&type=output" }],
        width: 1280, height: 720,
    }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "d.png", skipped: false }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(1800);

    el.preview.querySelector(".rs-gen-send").click();
    await sleep(150);
    assert.ok(created, "无目标时应新建 LoadImage 节点");
    assert.ok(graph._nodes.includes(created), "新建节点应加入画布");
    assert.equal(created.widgets[0].value, "d.png", "新节点的 image widget 应写入新图");
    delete globalThis.LiteGraph;
});

test("出图运行中：进度条按采样步数推进", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 20, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t7", status: "queued", images: [], width: 0, height: 0 }));
    // 兜底首拉返回 running 基线；进度与终态走 rs.image_gen.status 推送
    mockRoute("/neo_image_gen/status/t7", () => jsonResponse({ task_id: "t7", status: "running" }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(100); // 等兜底首拉建立 running 基线

    // 状态/进度/取消一行固定在节点底部（不吸顶）：display:flex 内联覆盖 .rs-gen-status 的 display:none 基类
    assert.equal(el.status.style.display, "flex", "运行中底部状态行应显示");
    const idleBar = el.status.querySelector(".rs-gen-progress");
    assert.ok(idleBar, "运行中应显示进度条");
    assert.ok(idleBar.classList.contains("rs-gen-progress--indeterminate"), "无步数时用不定动画占位");
    assert.equal(idleBar.querySelector(".rs-gen-progress-track")?.style.height, "8px", "轨道高度应为内联样式");
    assert.equal(idleBar.querySelector(".rs-gen-progress-fill")?.style.width, "40%");

    dispatchApiEvent("rs.image_gen.status", { task_id: "t7", status: "running", progress: { value: 3, max: 8 } });
    await sleep(50);

    const bar = el.status.querySelector(".rs-gen-progress");
    assert.ok(bar, "运行中应显示进度条");
    assert.equal(el.status.querySelector(".rs-gen-progress-label")?.textContent, "第 3 / 8 步");
    assert.equal(bar.querySelector(".rs-gen-progress-fill").style.width, "37.5%");

    // 终态推送让 watchTask 收尾，清理监听与定时器
    dispatchApiEvent("rs.image_gen.status", {
        task_id: "t7", status: "succeeded",
        images: [{ filename: "e.png", subfolder: "", url: "/view?filename=e.png&type=output" }],
        width: 1280, height: 720,
    });
    await sleep(50);
    assert.equal(el.status.style.display, "none", "结束后状态行隐藏（生成完成自动取消底部显示）");
});

test("出图增强提示词阶段：底部状态行显示已生成字数进度", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 23, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    // 开启该 skill 的 LLM 增强（全局出图设置 enhance_prompt=true），进入增强阶段
    mockRoute("/neo_image_gen/settings", () => jsonResponse({
        model: "", loras: [], count: 1, base_resolution: 1280, default_ratio: "1:1", enhance_prompt: true,
    }));
    // 增强流 mock 永不返回：让流程稳定停留在 LLM 流式增强阶段，便于断言增强进度 UI
    mockRoute("/neo_image_gen/enhance", () => new Promise(() => {}));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t9", status: "queued", images: [], width: 0, height: 0 }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(150);

    assert.equal(el.status.style.display, "flex", "增强阶段底部状态行显示");
    assert.ok(el.status.textContent.includes("增强提示词中"), "状态行显示增强阶段状态文本");
    const label = el.status.querySelector(".rs-gen-progress-label");
    assert.ok(label, "增强阶段显示已生成字数标签");
    assert.match(label.textContent, /^已生成 \d+ 字$/);
    const bar = el.status.querySelector(".rs-gen-progress");
    assert.ok(bar, "增强阶段显示进度条");
    assert.ok(!bar.classList.contains("rs-gen-progress--indeterminate"), "文本流式阶段用确定宽度而非不定动画");
    assert.ok(el.status.querySelector(".rs-gen-progress-fill"), "进度条填充随已生成字符推进");
});

test("清空输出：运行中的出图块被清除，后续推送不再回写", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 21, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t8", status: "queued", images: [], width: 0, height: 0 }));
    // 兜底首拉返回 running 基线；后续状态变化走 rs.image_gen.status 推送
    mockRoute("/neo_image_gen/status/t8", () => jsonResponse({ task_id: "t8", status: "running", progress: { value: 1, max: 10 } }));

    el.root.querySelector(".rs-quick-input").value = "一只猫";
    el.generateBtn.click();
    await sleep(100); // 兜底首拉后处于 running：进度在底部状态行，出图块只承载结果内容
    assert.equal(el.status.style.display, "flex", "运行中底部状态行显示");
    assert.ok(el.status.querySelector(".rs-gen-progress"), "状态行内显示进度条");
    assert.equal(el.preview.querySelector(".rs-gen-block"), null, "仅运行中（无结果内容）不渲染出图块");

    el.root.querySelector(".rs-clear-btn").click();
    assert.equal(el.status.style.display, "none", "清空后状态行立即隐藏");
    assert.equal(el.preview.querySelector(".rs-gen-block"), null, "清空后出图块应立即消失");

    // 旧任务的事件推送：set 应被代际校验拦截
    dispatchApiEvent("rs.image_gen.status", { task_id: "t8", status: "running", progress: { value: 2, max: 10 } });
    await sleep(50);
    assert.equal(el.status.style.display, "none", "后续推送不应把状态行刷回来");
    assert.equal(el.preview.querySelector(".rs-gen-block"), null, "后续推送不应把出图块刷回来");

    // 终态推送让旧 watchTask 收尾，也不再刷回出图块
    dispatchApiEvent("rs.image_gen.status", { task_id: "t8", status: "cancelled" });
    await sleep(50);
    assert.equal(el.status.style.display, "none", "终态推送不应把状态行刷回来");
    assert.equal(el.preview.querySelector(".rs-gen-block"), null, "终态推送不应把出图块刷回来");
});

test("文生图 skill 无文字：提示只针对画面描述，不提附加图片", async () => {
    const graph = makeGraph();
    const agent = await attachAgent(makeNode({
        id: 40, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
    }));
    const el = parts(agent);
    await sleep(400);
    setSkill(el.selector, "image_gen_text");

    el.root.querySelector(".rs-quick-input").value = "";
    el.generateBtn.click();
    await sleep(100);

    assert.equal(genCalls().length, 0, "无文字不应发出出图请求");
    assert.equal(el.preview.querySelector(".rs-gen-error")?.textContent,
        "✕ 请先输入画面描述。", "文生图的缺少输入提示不应提及图片");
});

test("已保存的 skill id：延迟填充后仍保留到节点属性并显示在选择器", async () => {
    const graph = makeGraph();
    const gen = addNode(graph, makeNode({
        id: 30, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
        properties: { rs_selected_skill: "image_gen" },
    }));
    await attachAgent(gen);
    const el = parts(gen);
    await sleep(400); // 等待 populateSkillSelector 异步填充 option 并恢复选择
    assert.equal(el.selector.value, "image_gen", "选择器应显示已保存的 skill");
    assert.equal(gen.properties.rs_selected_skill, "image_gen", "属性不应被 doPopulate 的 change 冲掉");
});

test("旧 rs_selected_template：迁移到 rs_selected_skill 并清除旧键", async () => {
    const graph = makeGraph();
    const gen = addNode(graph, makeNode({
        id: 31, type: "NeoPromptAgent", widgets: agentWidgets(),
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")], graph,
        properties: { rs_selected_template: "image_gen" },
    }));
    await attachAgent(gen);
    const el = parts(gen);
    await sleep(400);
    assert.equal(el.selector.value, "image_gen", "选择器应显示迁移后的 skill");
    assert.equal(gen.properties.rs_selected_skill, "image_gen", "应迁移到 rs_selected_skill");
    assert.equal(gen.properties.rs_selected_template, undefined, "旧键应被清除");
});