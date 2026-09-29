// Neo Studio shim（web/studio/shim）：api 事件桥 + app 单体的浏览器替身行为。
// 全壳装配（import-map + 真实模块图）走 tests/e2e/studio.e2e.mjs，这里只测 shim 单元。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, flush } from "./setup.mjs";

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

