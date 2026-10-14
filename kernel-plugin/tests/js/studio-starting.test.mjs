// 冷启动：壳已拉起 ComfyUI 但端口未就绪。这段时间界面只出「启动中」，
// 「ComfyUI 未运行」横幅文案、「🚀 启动 ComfyUI」按钮、「需要 ComfyUI」按钮文案与提示条都不得出现。
// 启动中状态来自壳侧 /neo_studio/version 快照：pywebview 的 js_api 注入晚于页面加载，
// 冷启动那几秒页面里没有 api，只靠 api 轮询就会先闪一遍「未运行」与「需要 ComfyUI」提示。
// 单独成文件：每个 studio-app.js 实例都往 document 挂捕获监听，同进程里多用例互相触发启动。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, click, flush, resetEnv } from "./setup.mjs";

globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const studioBody = `<div class="ns-header"></div><div id="ns-view"></div><button id="ns-comfy" hidden></button>`;

const OFFLINE_CAPS = {
    image_gen: false, storyboard: false, voice: false, segment: false,
    director: false, grid_split: true, memory: false, repair: false,
};

function mockStartingShell() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行",
        offline: true, starting: true, caps: OFFLINE_CAPS, recipes: [],
    }));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    mockRoute("/neo_studio/director/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
}

test("壳拉起 ComfyUI 期间：只出「启动中」，收起未运行横幅与启动入口", async () => {
    mockStartingShell();
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?starting=1");
    await flush();

    const bar = document.getElementById("ns-offline");
    assert.ok(bar, "离线页应有横幅");
    assert.equal(bar.style.display, "", "横幅出来的时候文案就是准的，不先闪「未运行」");
    assert.match(bar.textContent, /ComfyUI 启动中/);
    assert.ok(!/ComfyUI 未运行/.test(bar.textContent), "启动中不出「未运行」");
    assert.equal(bar.querySelector(".ns-offline-start").style.display, "none", "启动中不给启动按钮");
    assert.equal(document.getElementById("ns-version"), null, "版本位不在顶栏");
    assert.ok(document.getElementById("ns-comfy").hidden, "js_api 未注入前顶栏启停控件不出");
    const run = document.querySelector(".ns-gen-run");
    assert.ok(run, "导演页应已挂载");
    assert.match(run.textContent, /ComfyUI 启动中/);

    click(run);
    await flush();
    assert.equal(document.getElementById("ns-toast"), null, "启动中点生成入口不出提示条");

    // 启动中撞到的 409 同样收起：就绪后壳整页跳回完整 Studio
    await fetch("/neo_studio/director/generate", { method: "POST", body: "{}" });
    await flush();
    assert.equal(document.getElementById("ns-toast"), null, "启动中不出「需要 ComfyUI」提示条");

    // 版本号只在设置「关于」里，且跟着启动中状态走
    window.location.hash = "#/settings";
    window.dispatchEvent(new Event("hashchange"));
    await flush();
    click(document.querySelector('.ns-settings-tab[data-key="about"]'));
    await flush();
    assert.match(document.getElementById("ns-about-version").textContent, /Neo Studio 9\.9\.9 · ComfyUI 启动中/);
});
