// Neo Studio shim（web/studio/shim）：api 事件桥 + app 单体的浏览器替身行为。
// 全桌面端装配（import-map + 真实模块图）走 tests/e2e/studio.e2e.mjs，这里只测 shim 单元。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, click } from "./setup.mjs";
import { setLang } from "../../web/js/core/i18n.js";

// 断言写的是中文文案：jsdom 的 navigator.language 是 en-US，不钉住基线整页会跑成英文界面
setLang("zh");

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

// 顶栏 ComfyUI 胶囊：桌面端窗口（有 pywebview api）里才出现，浏览器标签页里不显示。
// studio-app.js 的启动体只在导入时跑一次，两个用例用不同 query 取同一模块的两份实例。
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    return document.getElementById("ns-comfy-status");
}

test("浏览器标签页里没有桌面端：顶栏 ComfyUI 状态位不显示", async () => {
    const status = mountStudio();
    await import("../../web/studio/studio-app.js?browser=1");
    await flush();
    assert.equal(status.hidden, true, "没有 pywebview api 时状态位应保持隐藏");
});

test("桥对象先到、方法后填：不打断启动链，状态位等齐了再接管", async () => {
    const status = mountStudio();
    // pywebview 的桥脚本分两步注入：window.pywebview（含空 api）先到，方法由 finish.js 调 _createApi 后填。
    // 只判断 api 对象存在就 poll，会抛 TypeError 打断启动链 —— 视图再也不挂载，窗口停在只出顶栏的空白页。
    window.pywebview = { api: {} };
    await import("../../web/studio/studio-app.js?bridgeLate=1");
    await flush();

    assert.ok(document.querySelector("#ns-view .ns-page"), "方法未就绪也不该打断启动链，视图要照常挂载");
    assert.equal(status.hidden, true, "方法未就绪先不接管状态位");

    const state = { port: 8188, pid: 4321, mine: true, running: true, ready: true };
    window.pywebview.api.comfy_state = async () => ({ ...state });
    await sleep(400);   // 300ms 一轮重试（setTimeout 不参与轮询加速）
    assert.equal(status.hidden, false, "方法齐了就该接管");
    assert.equal(status.textContent, "● 运行中");
});

test("前端错误上报：桥没就绪先等，方法齐了再补进桌面端日志", async () => {
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
        `未捕获错误应补进桌面端日志（实际 ${logged.join(" | ")}）`);
});

test("顶栏只显状态：端口 / PID / 谁启动收在提示里，动作在启动设置", async () => {
    const status = mountStudio();
    const state = { port: 8188, pid: 4321, mine: false, running: true, ready: true };
    window.pywebview = { api: { comfy_state: async () => ({ ...state }) } };
    await import("../../web/studio/studio-app.js?desktopStatus=1");
    await flush();

    assert.equal(status.hidden, false, "桌面端里应显示状态位");
    assert.equal(status.textContent, "● 运行中", "顶栏只报状态，不写动作");
    assert.ok(status.classList.contains("ns-comfy-run"), "运行中是绿色");
    assert.match(status.title, /端口 8188/, "提示里报端口");
    assert.match(status.title, /外部启动/, "提示里报谁启动");
    assert.match(status.title, /PID 4321/, "提示里报进程号");
    assert.equal(document.getElementById("ns-comfy"), null, "顶栏不该再有启停按钮");
    assert.equal(document.getElementById("ns-comfy-pid"), null, "PID 徽标不再单独占位");
});
// 启停在「设置 → 启动设置」顶部：状态一行 + 启动 / 停止两枚按钮，此刻做不了的那枚禁用。
test("启动设置顶部：运行中可停、停止可启动、启动中两枚都禁用", async () => {
    mountStudio();
    const starts = [];
    const stops = [];
    const state = { port: 8188, pid: 4321, mine: true, running: true, ready: true };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188, state: "ok", error: "",
            }),
            comfy_start: async () => {
                starts.push(1);
                state.running = true;
                state.ready = false;   // 进程已拉起，端口还没就绪
                state.pid = 5678;      // 桌面端回报的是新进程的号
                return { ...state };
            },
            comfy_stop: async () => {
                stops.push(1);
                state.running = false;
                state.pid = 0;
                return { ...state };
            },
        },
    };
    window.location.hash = "#/settings";
    try {
        await import("../../web/studio/studio-app.js?kernelPanel=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();

        const start = document.querySelector(".ns-kernel-start");
        const stop = document.querySelector(".ns-kernel-stop");
        const line = document.querySelector(".ns-kernel-state");
        assert.ok(start && stop, "启动设置顶部应有启停两枚按钮");
        assert.equal(line.textContent, "ComfyUI 运行中 · 端口 8188 · 桌面端启动 · PID 4321");
        assert.equal(start.disabled, true, "运行中不该再点启动");
        assert.equal(stop.disabled, false, "运行中可停");

        click(stop);
        await flush();
        assert.deepEqual(stops, [1], "点停止内核直接停，不要二次确认");
        assert.equal(line.textContent, "ComfyUI 已停止 · 端口 8188 · 桌面端启动", "没进程就不报 PID");
        assert.equal(stop.disabled, true, "没进程不该再点停止");
        assert.equal(start.disabled, false, "停止后可启动");

        click(start);
        await flush();
        assert.deepEqual(starts, [1], "点启动内核直接拉起");
        assert.match(line.textContent, /ComfyUI 启动中…/);
        assert.equal(start.disabled, true, "启动中不响应点击");
        assert.equal(stop.disabled, true, "启动中不该点停止");
        assert.match(line.textContent, /PID 5678/, "启动中报刚拉起的进程号");
    } finally {
        window.location.hash = "#/gallery";
    }
});


// 局域网监听做成下拉：手输 IP 容易错，可选项由桌面端给的网卡列表拼出来
test("启动设置：局域网监听是下拉框，选项带本机网卡，保存交的是选中项", async () => {
    mountStudio();
    const applied = [];
    window.pywebview = {
        api: {
            comfy_state: async () => ({ port: 8188, pid: 0, mine: true, running: false, ready: false }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188,
                listen: "127.0.0.1,192.168.0.165", lan_ips: ["172.17.48.1", "192.168.0.165"],
                state: "ok", error: "",
            }),
            apply_launcher: async (root, python, port, listen) => {
                applied.push(listen);
                return { ok: true, state: "ok" };
            },
        },
    };
    window.location.hash = "#/settings";
    try {
        await import("../../web/studio/studio-app.js?listenSel=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();

        const sel = document.querySelector(".ns-launch-listen");
        const hint = document.querySelector(".ns-launch-info");
        assert.ok(sel, "局域网监听应是下拉框，不是手输框");
        assert.deepEqual([...sel.options].map((o) => o.value),
            ["", "0.0.0.0", "172.17.48.1", "192.168.0.165"],
            "选项 = 仅本机 / 全部网卡 / 桌面端给的每块网卡");
        assert.equal(sel.value, "192.168.0.165", "已存的规范化值要落回对应网卡项");
        assert.match(hint.textContent, /http:\/\/192\.168\.0\.165:8188\/neo-studio/, "提示报选中网卡的地址");

        sel.value = "0.0.0.0";
        sel.dispatchEvent(new window.Event("change"));
        await flush();
        assert.match(hint.textContent, /http:\/\/172\.17\.48\.1:8188\/neo-studio/, "选全部网卡时提示列出各网卡");

        click(document.querySelector(".ns-launch-apply"));
        await flush();
        assert.deepEqual(applied, ["0.0.0.0"], "保存交的是选中项，用户不用碰 IP 字符串");
    } finally {
        window.location.hash = "#/gallery";
    }
});

// 远程 ComfyUI：窗口指向远端，本机启动项归远端那台机器管
test("启动设置：远程地址进保存载荷，本机启动项灰掉，提示改报远端地址", async () => {
    mountStudio();
    const applied = [];
    window.pywebview = {
        api: {
            comfy_state: async () => ({ port: 8188, pid: 0, mine: true, running: false, ready: false }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188, listen: "", lan_ips: [],
                remote: "http://192.168.0.20:8188", state: "ok", error: "",
            }),
            apply_launcher: async (root, python, port, listen, remote) => {
                applied.push(remote);
                return { ok: true, state: "ok" };
            },
        },
    };
    window.location.hash = "#/settings";
    try {
        await import("../../web/studio/studio-app.js?remoteIn=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();

        const remoteIn = document.querySelector(".ns-launch-remote");
        const hint = document.querySelector(".ns-launch-info");
        assert.ok(remoteIn, "启动设置里要有远程地址输入框");
        assert.equal(remoteIn.value, "http://192.168.0.20:8188", "已存的远程地址要回填");
        assert.equal(remoteIn.disabled, false, "远程地址本身要能改");
        assert.ok(document.querySelector(".ns-launch-row .ns-launch-input").disabled,
            "远程模式下根目录输入框要灰掉");
        assert.equal(document.querySelectorAll(".ns-launch-remote-off").length, 4,
            "根目录 / 解释器 / 端口 / 局域网监听四行灰掉");
        assert.match(hint.textContent, /远程 ComfyUI：http:\/\/192\.168\.0\.20:8188\/neo-studio/,
            "提示行报远端 Studio 地址");

        remoteIn.value = "http://10.0.0.5:8188";
        remoteIn.dispatchEvent(new window.Event("input"));
        await flush();
        assert.match(hint.textContent, /http:\/\/10\.0\.0\.5:8188\/neo-studio/, "提示跟着输入实时变");

        click(document.querySelector(".ns-launch-apply"));
        await flush();
        assert.deepEqual(applied, ["http://10.0.0.5:8188"], "保存交的是输入框里的远程地址");
    } finally {
        window.location.hash = "#/gallery";
    }
});

test("远程模式：内核行报远端地址，停止内核禁用，启动内核是重连", async () => {
    const status = mountStudio();
    const stops = [];
    const state = {
        port: 8188, pid: 0, mine: false, running: true, ready: true,
        remote: "http://192.168.0.20:8188",
    };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188,
                remote: state.remote, state: "ok", error: "",
            }),
            comfy_stop: async () => { stops.push(1); return { ...state }; },
        },
    };
    window.location.hash = "#/settings";
    try {
        await import("../../web/studio/studio-app.js?remoteKernel=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();

        const line = document.querySelector(".ns-kernel-state");
        const start = document.querySelector(".ns-kernel-start");
        const stop = document.querySelector(".ns-kernel-stop");
        assert.equal(line.textContent, "ComfyUI 运行中 · 远程 http://192.168.0.20:8188",
            "远程模式没有本机端口 / 谁启动 / PID 可报");
        assert.equal(stop.disabled, true, "远端进程不归本机管，停止内核要禁用");
        assert.equal(start.textContent, "🚀 重连远端");
        assert.equal(status.textContent, "● 运行中");
        assert.match(status.title, /远程 ComfyUI 运行中 · http:\/\/192\.168\.0\.20:8188/);
        assert.equal(stops.length, 0);
    } finally {
        window.location.hash = "#/gallery";
    }
});

// 每行标签旁的 ⓘ：前提条件与生效方式（保存并重启 / 重启窗口 / 归远端管）写在 data-tip 里
test("启动设置：每行带 ⓘ 说明，远程前提与开发模式要重启窗口写清楚", async () => {
    mountStudio();
    window.pywebview = {
        api: {
            comfy_state: async () => ({ port: 8188, pid: 4321, mine: true, running: true, ready: true }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188,
                listen: "", remote: "", state: "ok", error: "",
            }),
        },
    };
    window.location.hash = "#/settings";
    try {
        await import("../../web/studio/studio-app.js?launchTips=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();

        const rows = [...document.querySelectorAll(".ns-launch-row")];
        assert.equal(rows.length, 7, "根目录 / Python / 端口 / 监听 / 远程 / 无边框 / 开发模式");
        const tipOf = (label) => rows.find((r) => r.textContent.includes(label))
            ?.querySelector(".ns-info")?.getAttribute("data-tip") || "";
        for (const label of ["ComfyUI 根目录", "Python", "端口", "局域网监听", "远程 ComfyUI",
            "无边框窗口", "开发模式"]) {
            assert.ok(tipOf(label).includes("\n"), `「${label}」这一行要有带前提的 ⓘ 说明`);
        }
        assert.match(tipOf("远程 ComfyUI"), /comfyui-neo-studio[\s\S]*局域网监听/);
        assert.match(tipOf("远程 ComfyUI"), /停止内核[\s\S]*归远端管/);
        assert.match(tipOf("远程 ComfyUI"), /留空 = 连本机/);
        assert.match(tipOf("局域网监听"), /127\.0\.0\.1[\s\S]*鉴权/);
        assert.match(tipOf("端口"), /保存并重启/);
        assert.match(tipOf("无边框窗口"), /立刻生效/);
        assert.match(tipOf("开发模式"), /重启桌面端窗口/);

        const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
        assert.ok(/\.ns-info::after\s*\{[^}]*attr\(data-tip\)/.test(css), "ⓘ 的说明文字要画在 ::after 上");
        assert.ok(/\.ns-info:hover::after[^{]*\{[^}]*visibility:\s*visible/.test(css), "悬停要画出说明");
    } finally {
        window.location.hash = "#/gallery";
    }
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

test("离线页：横幅说明可编辑面，版本位显示离线", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true,
        caps: { image_gen: false, grid_split: true }, recipes: [],
    }));
    await import("../../web/studio/studio-app.js?offline=1");
    await flush();
    const bar = document.getElementById("ns-offline");
    assert.ok(bar, "桌面端的离线页应显示横幅");
    assert.match(bar.textContent, /ComfyUI 未运行/);
    assert.match(bar.textContent, /可离线编辑/);
    assert.ok(bar.querySelector(".ns-offline-start"), "横幅应带「启动 ComfyUI」按钮");
    assert.ok(document.body.classList.contains("ns-offline"), "body 应带离线标记");
    assert.equal(document.getElementById("ns-version"), null, "版本位不在顶栏");
});

test("离线页里点启动内核：不刷新页面，交给桌面端整页跳回完整 Studio", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true, recipes: [],
    }));
    const status = document.getElementById("ns-comfy-status");
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
        assert.equal(status.textContent, "● 已停止");
        assert.match(status.title, /启动设置/);

        click(document.querySelector(".ns-offline-start"));
        await flush();
        assert.equal(status.textContent, "● 启动中");

        state.ready = true;
        await sleep(120);
        assert.equal(reloads.length, 0, "离线页刷新只会回到离线页，跳转由桌面端负责");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
    }
});

test("已停止后在启动设置点「启动内核」，就绪后刷新页面", async () => {
    const status = mountStudio();
    const starts = [];
    const reloads = [];

    const state = { port: 8190, pid: 0, mine: true, running: false, ready: false };
    // jsdom 的 location.reload 不可重定义（且真导航会炸），整块换成桩：刷新动作可观测
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/settings", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8190, state: "ok", error: "",
            }),
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
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();
        const start = document.querySelector(".ns-kernel-start");
        assert.ok(start, "启动设置顶部应有「启动内核」按钮");
        assert.equal(start.disabled, false, "已停止时可启动");

        click(start);
        await flush();
        assert.deepEqual(starts, [1], "已停止时点一下直接拉起，不需要二次确认");
        assert.equal(status.textContent, "● 启动中");
        assert.equal(start.disabled, true, "启动中不响应点击");

        // 进程活着但端口未就绪：继续显示启动中，不重复拉起
        await sleep(120);
        assert.deepEqual(starts, [1], "启动中不该重复拉起");
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
// 早先只判断一次，撞上空档就永久不出控件、顶栏拖动也不挂 —— 桌面端窗口里拖动时好时坏就是它。
test("顶栏窗口控件：桥晚到也要挂上，顶栏空白处按下交回桌面端拖动", async () => {
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
    assert.ok(calls.includes("drag"), "顶栏空白处按下要交回桌面端走原生拖动");

    const wired = calls.length;
    header.dispatchEvent(new window.MouseEvent("mousedown", { button: 2, bubbles: true }));
    document.querySelector(".ns-logo").dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true }));
    await flush();
    assert.equal(calls.length, wired, "右键与链接不该拖窗");

    document.getElementById("ns-win-close").click();
    await flush();
    assert.ok(calls.includes("close"), "关闭按钮走桌面端");
});

