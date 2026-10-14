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

test("顶栏标题是回首页（素材页）的链接", async () => {
    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    const logo = html.match(/<a class="ns-logo" href="([^"]+)" title="([^"]+)">/);
    assert.ok(logo, "顶栏标题应为可点击链接");
    assert.equal(logo[1], "#/gallery", "应指向默认素材页");
    assert.match(logo[2], /首页/, "应有返回首页提示");
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    assert.match(css, /\.ns-logo \{[^}]*text-decoration: none/, "链接不应带下划线");
    assert.match(css, /\.ns-logo:hover/, "应有 hover 反馈");
});

test("无边框窗口控件：默认隐藏，最小化 / 最大化 / 全屏 / 关闭齐备", async () => {
    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const wctl = html.match(/<span class="ns-wctl" id="ns-wctl" hidden>([\s\S]*?)<\/span>/);
    assert.ok(wctl, "顶栏应有窗口控件组，且默认隐藏（系统标题栏在时不需要）");
    for (const id of ["ns-win-min", "ns-win-max", "ns-win-fs", "ns-win-close"])
        assert.ok(wctl[1].includes(`id="${id}"`), `应有 ${id} 按钮`);
    assert.match(wctl[1], /全屏/, "除最小化 / 最大化 / 关闭外还要有全屏按钮");
    assert.match(css, /\.ns-frameless \.ns-header \{[^}]*cursor: move/, "无边框时顶栏空白处可拖窗");
    assert.ok(!/\.ns-version\b/.test(css), "版本位不在顶栏样式里");
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

test("浏览器标签页里没有壳：ComfyUI 启停控件不显示", async () => {
    const btn = mountStudio();
    await import("../../web/studio/studio-app.js?browser=1");
    await flush();
    assert.equal(btn.hidden, true, "没有 pywebview api 时启停控件应保持隐藏");
});

test("桥对象先到、方法后填：不打断启动链，启停控件等齐了再接管", async () => {
    const btn = mountStudio();
    // pywebview 的桥脚本分两步注入：window.pywebview（含空 api）先到，方法由 finish.js 调 _createApi 后填。
    // 只判断 api 对象存在就 poll，会抛 TypeError 打断启动链 —— 视图再也不挂载，窗口停在只出顶栏的空白页。
    window.pywebview = { api: {} };
    await import("../../web/studio/studio-app.js?bridgeLate=1");
    await flush();

    assert.ok(document.querySelector("#ns-view .ns-page"), "方法未就绪也不该打断启动链，视图要照常挂载");
    assert.equal(btn.hidden, true, "方法未就绪先不接管启停控件");

    const state = { port: 8188, pid: 4321, mine: true, running: true, ready: true };
    window.pywebview.api.comfy_state = async () => ({ ...state });
    await sleep(400);   // 300ms 一轮重试（setTimeout 不参与轮询加速）
    assert.equal(btn.hidden, false, "方法齐了就该接管");
    assert.match(btn.textContent, /■停止内核/);
});

test("前端错误上报：桥没就绪先等，方法齐了再补进壳日志", async () => {
    mountStudio();
    window.pywebview = { api: {} };   // 报错正撞在桥脚本注入的空档上：api 对象在、log 方法还没填
    await import("../../web/studio/studio-app.js?webLog=1");
    await flush();

    const logged = [];
    const ev = new window.Event("error");
    Object.assign(ev, { message: "api.comfy_state is not a function", filename: "studio-app.js", lineno: 748 });
    window.dispatchEvent(ev);
    window.pywebview.api.log = (t) => logged.push(t);
    await sleep(400);   // 300ms 一轮重试

    // 同一进程里前面几个用例也导入了 studio-app.js（各有一份错误监听），消息会重复，只断言内容
    assert.ok(logged.includes("ERROR api.comfy_state is not a function @ studio-app.js:748"),
        `未捕获错误应补进壳日志（实际 ${logged.join(" | ")}）`);
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

    assert.equal(btn.hidden, false, "壳里应显示启停控件");
    assert.match(btn.textContent, /■停止内核/);
    assert.ok(btn.classList.contains("stop"), "运行中带红色停止图标");
    assert.match(btn.title, /外部启动/);
    assert.match(btn.title, /点一下停止内核/);
    assert.match(document.getElementById("ns-comfy-pid").textContent, /4321/, "PID 徽标报进程号");

    // 点一下真停：换成「启动内核」，且仍可点（壳是启动器，点一下能重新拉起）
    click(btn);
    await flush();
    assert.deepEqual(stops, [1], "点一下就该停，不要二次确认");
    assert.match(btn.textContent, /▶启动内核/);
    assert.ok(!btn.classList.contains("stop"), "停止后换成启动按钮");
    assert.equal(btn.disabled, false, "停止态应可点启动");
    assert.match(btn.title, /点一下启动内核/);
    assert.equal(document.getElementById("ns-comfy-pid").hidden, true, "没有进程就不出 PID 徽标");
});
// 状态与动作分两块：按钮只写动作，进程号交给旁边的 PID 徽标 —— 一行「● ComfyUI :8188」
// 读不出「点它是退出还是启动」，这里按三种状态逐个钉住文案。
test("启停控件的文案就是动作本身：停止内核 / 启动内核 / 启动中", async () => {
    const btn = mountStudio();
    const pid = () => document.getElementById("ns-comfy-pid");
    const state = { port: 8188, pid: 4321, mine: true, running: true, ready: true };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => {
                state.running = true;
                state.ready = false;   // 进程已拉起，端口还没就绪
                state.pid = 5678;      // 壳回报的是新进程的号
                return { ...state };
            },
            comfy_stop: async () => {
                state.running = false;
                state.pid = 0;
                return { ...state };
            },
        },
    };
    await import("../../web/studio/studio-app.js?actionLabel=1");
    await flush();

    assert.equal(btn.textContent, "■停止内核", "运行中要点的是停止");
    assert.equal(pid().hidden, false, "运行中徽标在场");
    assert.equal(pid().textContent, "# PID: 4321", "运行中徽标报进程号");

    click(btn);
    await flush();
    assert.equal(btn.textContent, "▶启动内核", "停止后要点的是启动");
    assert.equal(pid().hidden, true, "没进程就没有徽标");

    click(btn);
    await flush();
    assert.equal(btn.textContent, "🚀启动中…", "启动中不写动作，只报在启动");
    assert.equal(btn.disabled, true, "启动中不响应点击");
    assert.equal(pid().hidden, false, "启动中徽标在场");
    assert.equal(pid().textContent, "# PID: 5678", "启动中徽标报刚拉起的进程号");
    await sleep(120);
});


test("ComfyUI 在跑时生成入口不受门控：点它不该去启动 ComfyUI", async () => {
    mountStudio();
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-gallery-gm-btn" type="button">🖼️ 生成素材</button>' +
        '<button class="neo-director-regen-run" type="button">生成这一段</button>' +
        '<button class="neo-director-merge-run" type="button">拼回成片</button>' +
        '<button class="neo-director-sb-gen" type="button">🎨 生成图片分镜</button>');
    const starts = [];
    const state = { port: 8188, pid: 4321, mine: true, running: true, ready: true };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => { starts.push(1); return { ...state }; },
        },
    };
    await import("../../web/studio/studio-app.js?onlineGate=1");
    await flush();

    for (const sel of [".neo-gallery-gm-btn", ".neo-director-regen-run",
                       ".neo-director-merge-run", ".neo-director-sb-gen"]) {
        click(document.querySelector(sel));
    }
    await flush();
    assert.equal(starts.length, 0, "在线时生成入口应照常交给原功能，不触发启动");
});

test("离线页：横幅说明可编辑面，版本位显示离线，显存块收起", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true,
        caps: { image_gen: false, grid_split: true }, recipes: [],
    }));
    await import("../../web/studio/studio-app.js?offline=1");
    await flush();
    const bar = document.getElementById("ns-offline");
    assert.ok(bar, "壳的离线页应显示横幅");
    assert.match(bar.textContent, /ComfyUI 未运行/);
    assert.match(bar.textContent, /可离线编辑/);
    assert.ok(bar.querySelector(".ns-offline-start"), "横幅应带「启动 ComfyUI」按钮");
    assert.ok(document.body.classList.contains("ns-offline"), "body 应带离线标记");
    assert.equal(document.getElementById("ns-version"), null, "版本位不在顶栏");
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
        assert.match(btn.textContent, /▶启动内核/);
        assert.match(btn.title, /点一下启动内核/);

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


// 顶栏窗口控件走同一条等桥的路：桥的方法由 finish.js 后填，模块脚本先跑完时只看到空 api。
// 早先只判断一次，撞上空档就永久不出控件、顶栏拖动也不挂 —— 壳窗口里拖动时好时坏就是它。
test("顶栏窗口控件：桥晚到也要挂上，顶栏空白处按下交回壳拖动", async () => {
    mountStudio();
    const wctl = document.getElementById("ns-wctl");
    const calls = [];
    window.pywebview = { api: {} };   // 桥的空档：api 对象在，方法还没填
    await import("../../web/studio/studio-app.js?chromeLate=1");
    await flush();
    assert.equal(wctl.hidden, true, "方法没齐先别出控件");

    window.pywebview.api.window_state = async () => ({ frameless: true, maximized: false, fullscreen: false });
    window.pywebview.api.win_start_drag = () => calls.push("drag");
    window.pywebview.api.win_close = () => calls.push("close");
    await sleep(400);   // 300ms 一轮重试
    assert.equal(wctl.hidden, false, "方法齐了顶栏控件要挂上");

    // 同一进程里前面几个用例各导入过一份 studio-app.js，它们的等桥循环这会儿也齐了桥，
    // 会在同一个顶栏上各挂一份监听 —— 只断言次数变化，不比绝对条数
    const header = document.querySelector(".ns-header");
    header.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true }));
    await flush();
    assert.ok(calls.includes("drag"), "顶栏空白处按下要交回壳走原生拖动");

    const wired = calls.length;
    header.dispatchEvent(new window.MouseEvent("mousedown", { button: 2, bubbles: true }));
    document.querySelector(".ns-logo").dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true }));
    await flush();
    assert.equal(calls.length, wired, "右键与链接不该拖窗");

    document.getElementById("ns-win-close").click();
    await flush();
    assert.ok(calls.includes("close"), "关闭按钮走壳");
});

