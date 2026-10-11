// Neo Studio shim（web/studio/shim）：api 事件桥 + app 单体的浏览器替身行为。
// 全壳装配（import-map + 真实模块图）走 tests/e2e/studio.e2e.mjs，这里只测 shim 单元。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        FakeWebSocket.instances.push(this);
    }
}
FakeWebSocket.instances = [];
globalThis.WebSocket = FakeWebSocket;

const apiMod = await import("../../web/studio/shim/api.js");
const appMod = await import("../../web/studio/shim/app.js");

test("api shim：fetchApi 透传、WS 消息按 type 派发事件", async () => {
    resetEnv();
    const resp = await apiMod.api.fetchApi("/neo_studio/version");
    assert.equal(typeof resp.json, "function", "fetchApi 应返回 Response");

    const ws = FakeWebSocket.instances.at(-1);
    assert.match(ws.url, /\/ws\?clientId=.+/);

    const seen = [];
    const onStatus = (e) => seen.push(e.detail);
    apiMod.api.addEventListener("rs.director.status", onStatus);
    ws.onmessage({ data: JSON.stringify({ type: "rs.director.status", data: { task_id: "t1" } }) });
    assert.deepEqual(seen, [{ task_id: "t1" }]);

    // 非 JSON / 无 type 的消息忽略；reconnected 在 onopen 时派发
    const reconnected = [];
    apiMod.api.addEventListener("reconnected", () => reconnected.push(1));
    ws.onmessage({ data: "not-json" });
    ws.onmessage({ data: JSON.stringify({ data: {} }) });
    ws.onopen();
    assert.deepEqual(reconnected, [1]);

    apiMod.api.removeEventListener("rs.director.status", onStatus);
    ws.onmessage({ data: JSON.stringify({ type: "rs.director.status", data: { task_id: "t2" } }) });
    assert.equal(seen.length, 1, "移除监听后不应再收到");
});

test("app shim：扩展收集与 setup、settings 持久化、toast 落 DOM", async () => {
    resetEnv();
    const setups = [];
    appMod.app.registerExtension({ name: "t.ext", setup: () => setups.push("t.ext") });
    await appMod.initExtensions();
    assert.deepEqual(setups, ["t.ext"]);

    // settings：首次 addSetting 落 defaultValue，之后可读写（localStorage 持久化）
    localStorage.removeItem("neo_studio_settings");
    appMod.app.ui.settings.addSetting({ id: "Neo.Test.flag", name: "flag", type: "boolean", defaultValue: true });
    assert.equal(appMod.app.ui.settings.getValue("Neo.Test.flag"), true);
    appMod.app.ui.settings.setValue("Neo.Test.flag", false);
    assert.equal(appMod.app.ui.settings.getValue("Neo.Test.flag"), false);

    // toast：severity 映射后落 action toast 栈（error 不自动关闭）
    appMod.app.extensionManager.toast.add({ severity: "warn", summary: "警告" });
    await flush();
    const toasts = document.querySelectorAll("#neo-action-toast-stack .neo-at");
    assert.equal(toasts.length, 1);
    assert.ok(toasts[0].classList.contains("neo-at-warning"));

    // 画布替身：空结构不抛错（「发送到节点」类功能据此降级）
    assert.deepEqual(appMod.app.canvas.selected_nodes, {});
    assert.deepEqual(appMod.app.graph._nodes, []);
    assert.equal(appMod.app.graph.getNodeById(1), null);
});

test("顶栏标题是回主画布的链接（壳窗口内跳转，不弹标签页）", async () => {
    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    const logo = html.match(/<a class="ns-logo" href="([^"]+)" title="([^"]+)">/);
    assert.ok(logo, "顶栏标题应为可点击链接");
    assert.equal(logo[1], "/", "应指向主界面");
    assert.match(logo[2], /主画布|主界面/, "应有返回提示");
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    assert.match(css, /\.ns-logo \{[^}]*text-decoration: none/, "链接不应带下划线");
    assert.match(css, /\.ns-logo:hover/, "应有 hover 反馈");
});

// 顶栏 ComfyUI 胶囊：壳窗口（有 pywebview api）里才出现，浏览器标签页里不显示。
// studio-app.js 的启动体只在导入时跑一次，两个用例用不同 query 取同一模块的两份实例。
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    return document.getElementById("ns-comfy");
}

test("浏览器标签页里没有壳：ComfyUI 胶囊不显示", async () => {
    const btn = mountStudio();
    await import("../../web/studio/studio-app.js?browser=1");
    await flush();
    assert.equal(btn.hidden, true, "没有 pywebview api 时胶囊应保持隐藏");
});

test("壳里显示 ComfyUI 状态，点一下即停", async () => {
    const btn = mountStudio();
    const stops = [];
    const state = { port: 8188, pid: 4321, mine: false, running: true, ready: true };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_stop: async () => {
                stops.push(1);
                state.running = false;
                state.pid = 0;
                return { ...state };
            },
        },
    };
    await import("../../web/studio/studio-app.js?shell=1");
    await flush();

    assert.equal(btn.hidden, false, "壳里应显示胶囊");
    assert.match(btn.textContent, /● ComfyUI :8188/);
    assert.match(btn.title, /PID 4321/);
    assert.match(btn.title, /外部启动/);
    assert.ok(!btn.classList.contains("off"), "运行中不是灰态");

    // 点一下真停：状态变灰，且仍可点（壳是启动器，点一下能重新拉起）
    click(btn);
    await flush();
    assert.deepEqual(stops, [1], "点一下就该停，不要二次确认");
    assert.match(btn.textContent, /○ ComfyUI 已停止/);
    assert.ok(btn.classList.contains("off"));
    assert.equal(btn.disabled, false, "停止态应可点重启");
    assert.match(btn.title, /点一下重新拉起/);
});

test("离线页：横幅说明浏览可用，版本位显示离线，显存块收起", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true, recipes: [],
    }));
    await import("../../web/studio/studio-app.js?offline=1");
    await flush();
    const bar = document.getElementById("ns-offline");
    assert.ok(bar, "壳的离线页应显示横幅");
    assert.match(bar.textContent, /ComfyUI 未运行/);
    assert.match(bar.textContent, /素材浏览可用/);
    assert.ok(document.body.classList.contains("ns-offline"), "body 应带离线标记");
    assert.match(document.getElementById("ns-version").textContent, /离线浏览/);
});

test("离线页里点重新拉起：不刷新页面，交给壳整页跳回完整 Studio", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true, recipes: [],
    }));
    const btn = document.getElementById("ns-comfy");
    const reloads = [];
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/gallery", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    const state = { port: 8188, pid: 0, mine: true, running: false, ready: false };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => {
                state.running = true;
                return { ...state };
            },
        },
    };
    try {
        await import("../../web/studio/studio-app.js?offlineStart=1");
        await flush();
        assert.match(btn.textContent, /○ ComfyUI 已停止/);
        assert.match(btn.title, /素材仍可浏览/);

        click(btn);
        await flush();
        assert.match(btn.textContent, /启动中/);

        state.ready = true;
        await sleep(120);
        assert.equal(reloads.length, 0, "离线页刷新只会回到离线页，跳转由壳负责");
        assert.match(btn.textContent, /启动中/);
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
    }
});

test("已停止后点一下重新拉起，就绪后刷新页面", async () => {
    const btn = mountStudio();
    const starts = [];
    const reloads = [];

    const state = { port: 8190, pid: 0, mine: true, running: false, ready: false };
    // jsdom 的 location.reload 不可重定义（且真导航会炸），整块换成桩：刷新动作可观测
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/gallery", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => {
                starts.push(1);
                state.running = true;   // 进程已拉起，端口还没就绪
                return { ...state };
            },
        },
    };
    try {
        await import("../../web/studio/studio-app.js?start=1");
        await flush();

        click(btn);
        await flush();
        assert.deepEqual(starts, [1], "已停止时点一下直接拉起，不需要二次确认");
        assert.match(btn.textContent, /启动中/);
        assert.equal(btn.disabled, true, "启动中不响应点击");

        // 进程活着但端口未就绪：继续显示启动中，不重复拉起
        await sleep(120);
        assert.deepEqual(starts, [1], "启动中不该重复拉起");
        assert.match(btn.textContent, /启动中/);
        assert.equal(reloads.length, 0, "未就绪不该刷新");

        // 端口就绪（5s 轮询被压到 40ms）→ 刷新页面
        state.ready = true;
        await sleep(120);
        assert.deepEqual(reloads, [1], "就绪后应刷新页面");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
    }
});

