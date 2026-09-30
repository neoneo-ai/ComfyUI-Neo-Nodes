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
    for (const want of ["🎬 Neo Studio", "🎥 新建导演配方", "🧩 创建节点", "🔧 修复工作流", "📜 修复记录", "ℹ️ 关于插件"]) {
        assert.ok(labels.some((l) => l.includes(want)), `缺少条目: ${want}`);
    }
    // 再点一次收起
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    assert.equal(document.querySelector(".neo-n-menu"), null, "菜单未收起");
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

