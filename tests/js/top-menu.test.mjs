// 顶栏 🅝 菜单（top-menu.js）：单按钮注册、下拉条目、节点子菜单过滤、关于弹窗
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearBody, mockRoute, jsonResponse, flush } from "./setup.mjs";
import { getExtension } from "./mocks/comfy-app.mjs";

const topMenu = await import("../../web/top-menu.js");   // setup.mjs 副作用先行，再导入被测模块

beforeEach(() => {
    clearBody();
    topMenu.resetTopMenu();   // 收起残留菜单（模块级 menuEl 会挡住再次展开）
});

test("top-menu.js 注册单个 🅝 菜单按钮", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    assert.ok(ext, "扩展 comfy.neo.topMenu 未注册");
    assert.equal(ext.actionBarButtons.length, 1);
    const btn = ext.actionBarButtons[0];
    assert.match(btn.icon, /neo-n-menu-icon/);
    assert.match(btn.class ?? "", /neo-n-menu-btn/);
    // setup 注入样式 + 右键绑定，jsdom 下不抛异常
    ext.setup();
    assert.ok(document.getElementById("neo-n-menu-style"), "样式未注入");
});

test("点击按钮展开菜单且包含全部条目", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "菜单未展开");
    const labels = [...menu.querySelectorAll(".neo-n-menu-item")].map((el) => el.textContent);
    for (const want of ["🎬 新影工坊", "🖼️ 生成素材", "🎥 新建导演配方", "🧩 创建节点", "🔧 修复工作流", "📜 修复记录", "ℹ️ 关于插件"]) {
        assert.ok(labels.some((l) => l.includes(want)), `缺少条目: ${want}`);
    }
    // 再点一次收起
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    assert.equal(document.querySelector(".neo-n-menu"), null, "菜单未收起");
});

test("🖼️ 生成素材：点击打开生成素材弹窗", async () => {
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const item = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("生成素材"));
    assert.ok(item, "菜单缺少 🖼️ 生成素材条目");
    item.click();
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");
    assert.ok(document.querySelector(".neo-gallery-gm-modal-overlay"), "生成素材弹窗未打开");
});

test("创建节点子菜单按 LiteGraph.registeredNodes 过滤", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        assert.ok(row, "创建节点行缺失");
        row.click();
        const items = [...document.querySelectorAll(".neo-n-submenu .neo-n-menu-item")];
        assert.equal(items.length, 1, "只应列出已注册节点");
        assert.match(items[0].textContent, /Neo Prompt Agent/);
    } finally {
        delete globalThis.LiteGraph;
    }
});

test("点菜单外（document pointerdown）收起菜单", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    assert.ok(document.querySelector(".neo-n-menu"), "菜单未展开");
    // jsdom 无 PointerEvent 构造器，用 MouseEvent 冒泡到 document 捕获层即可触发
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector(".neo-n-menu"), null, "点外部后菜单未收起");
});

test("点菜单内部不收起", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "菜单未展开");
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    assert.ok(document.querySelector(".neo-n-menu"), "点菜单内部不应收起");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });   // 清理
});

test("关于插件弹窗显示源码与 License", async () => {
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "1.33" }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const aboutItem = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("关于插件"));
    aboutItem.click();
    const dialog = document.querySelector(".neo-n-about-dialog");
    assert.ok(dialog, "关于弹窗未打开");
    assert.match(dialog.textContent, /github\.com\/neoneo-ai\/ComfyUI-Neo-Nodes/);
    assert.match(dialog.textContent, /Apache-2\.0/);
    await flush();   // 等版本 fetch 承诺链落定
    assert.match(dialog.textContent, /v9\.9\.9/);
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");
});

test("⚙️ 设置打开统一设置弹窗（三 tab，切 tab 显隐同步）", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const settingsItem = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("设置"));
    assert.ok(settingsItem, "菜单缺少 ⚙️ 设置条目");
    settingsItem.click();
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");

    const overlay = document.querySelector(".neo-director-llm-overlay");
    assert.ok(overlay, "设置弹窗未打开");
    const tabs = [...overlay.querySelectorAll(".rs-auto-tab")].map((el) => el.textContent);
    assert.deepEqual(tabs, ["🤖 LLM Settings", "🖼️ 生图默认设置", "🎬 生视频模型"], "tab 顺序/文案不符");
    const panels = [...overlay.querySelectorAll(".neo-settings-panel")];
    assert.equal(panels.length, 3, "三个设置面板缺失");
    assert.equal(panels.filter((p) => p.style.display !== "none").length, 1, "默认只显示一个面板");
    assert.ok(panels[0].style.display !== "none", "默认应显示 LLM tab");

    // 切到生视频 tab：只有第三个面板可见
    overlay.querySelectorAll(".rs-auto-tab")[2].click();
    assert.equal(panels.filter((p) => p.style.display !== "none").length, 1, "切 tab 后应只有一个面板可见");
    assert.ok(panels[2].style.display !== "none", "生视频面板未显示");
    assert.ok(overlay.querySelectorAll(".rs-auto-tab")[2].classList.contains("rs-auto-tab-active"), "tab 高亮未跟随");

    // 无改动：✕ 直接关
    await flush();   // 等三个表单 load 落定（ready）
    overlay.querySelector(".neo-director-llm-close").click();
    assert.equal(document.querySelector(".neo-director-llm-overlay"), null, "无改动 ✕ 未直接关闭");
});

test("⚙️ 设置有未保存修改时先出确认条，放弃修改后关闭", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["diffusion/krea2.safetensors"], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("设置")).click();
    const overlay = document.querySelector(".neo-director-llm-overlay");
    assert.ok(overlay, "设置弹窗未打开");
    await flush();   // 等 load 落定，脏检查基线就绪

    // 选中生图表单的生图模型 → 脏
    const modelSelect = overlay.querySelector(".rs-gen-settings select");
    modelSelect.value = "diffusion/krea2.safetensors";
    overlay.querySelector(".neo-director-llm-close").click();
    assert.ok(overlay, "有改动 ✕ 不应直接关");
    const confirm = overlay.querySelector(".neo-director-llm-dirty");
    assert.equal(confirm.hidden, false, "确认条未出现");

    // 继续编辑：确认条收起、弹窗保留
    overlay.querySelector(".neo-director-llm-btn-keep").click();
    assert.equal(confirm.hidden, true, "继续编辑后确认条未收起");
    assert.ok(overlay, "继续编辑不应关闭弹窗");

    // 再点 ✕ → 确认条重现 → 放弃修改关闭
    overlay.querySelector(".neo-director-llm-close").click();
    assert.equal(confirm.hidden, false, "二次 ✕ 确认条未出现");
    overlay.querySelector(".neo-director-llm-btn-discard").click();
    assert.equal(document.querySelector(".neo-director-llm-overlay"), null, "放弃修改后未关闭");
});

