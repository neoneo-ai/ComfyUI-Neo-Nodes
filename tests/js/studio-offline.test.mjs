// Neo Studio 离线模式（壳侧服务）：能力门控 —— 文件类功能照常，生成类不发假请求。
// 壳对 COMFY_ONLY 接口回 409 {offline:true}，Studio 必须提示并引导启动 ComfyUI。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, flush, fetchLog, resetEnv } from "./setup.mjs";

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const studioBody = `<div class="ns-header"></div><div id="ns-view"></div><div id="ns-version"></div><button id="ns-comfy" hidden></button>`;

const OFFLINE_CAPS = {
    image_gen: false, storyboard: false, voice: false, segment: false,
    director: false, grid_split: true, memory: false, repair: false,
};

function mockOfflineShell() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行",
        offline: true, caps: OFFLINE_CAPS, recipes: [],
    }));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    mockRoute("/neo_studio/director/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
    mockRoute("/neo_image_gen/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
}

function mockShellApi(starts) {
    const state = { port: 8188, pid: 0, mine: true, running: false, ready: false };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => { starts.push(1); state.running = true; return { ...state }; },
        },
    };
    return state;
}

test("离线横幅说明可编辑面并给出启动入口", async () => {
    mockOfflineShell();
    await import("../../web/studio/studio-app.js?offBanner=1");
    await flush();
    const bar = document.getElementById("ns-offline");
    assert.ok(bar, "壳的离线页应显示横幅");
    assert.match(bar.textContent, /ComfyUI 未运行/);
    assert.match(bar.textContent, /技能 \/ 配方 \/ 设置 \/ 模型库可离线编辑/);
    assert.ok(bar.querySelector(".ns-offline-start"), "横幅应带「启动 ComfyUI」按钮");
    assert.match(document.getElementById("ns-version").textContent, /离线模式/);
});

test("离线导演页：生成按钮不发请求，点一下交给壳拉起 ComfyUI", async () => {
    mockOfflineShell();
    const starts = [];
    mockShellApi(starts);
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?offDirector=1");
    await flush();
    const run = document.querySelector(".ns-gen-run");
    assert.ok(run, "导演页应已挂载");
    assert.match(run.textContent, /需要 ComfyUI/);
    assert.match(run.title, /需要 ComfyUI 执行队列/);

    click(run);
    await flush();
    assert.ok(starts.length >= 1, "点一下应直接拉起 ComfyUI");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/director/generate").length, 0,
                 "离线页不该发整片生成请求");
});

test("壳回 409 offline：api shim 广播事件，Studio 提示需要 ComfyUI", async () => {
    mockOfflineShell();
    mockShellApi([]);
    await import("../../web/studio/studio-app.js?offToast=1");
    const apiMod = await import("../../web/studio/shim/api.js");
    await flush();

    const resp = await apiMod.api.fetchApi("/neo_image_gen/generate", { method: "POST", body: "{}" });
    assert.equal(resp.status, 409);
    await flush();
    const toast = document.getElementById("ns-toast");
    assert.ok(toast, "应出现提示条");
    assert.match(toast.textContent, /需要 ComfyUI/);
    assert.ok(toast.classList.contains("show"));
    await sleep(100);
});

test("共享模块用原生 fetch 撞 409：同样提示需要 ComfyUI", async () => {
    mockOfflineShell();
    mockRoute("/neo_video_gen/storyboard_generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
    await import("../../web/studio/studio-app.js?offFetch=1");
    await flush();

    const res = await fetch("/neo_video_gen/storyboard_generate", { method: "POST", body: "{}" });
    assert.equal(res.status, 409);
    await flush();
    assert.match(document.getElementById("ns-toast").textContent, /需要 ComfyUI/);
    await sleep(100);
});

test("离线素材页：「🖼️ 生成素材」不发请求，点一下交给壳拉起 ComfyUI", async () => {
    mockOfflineShell();
    const starts = [];
    mockShellApi(starts);
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-gallery-gm-btn" type="button">🖼️ 生成素材</button>');
    await import("../../web/studio/studio-app.js?offGallery=1");
    await flush();

    click(document.querySelector(".neo-gallery-gm-btn"));
    await flush();
    assert.ok(starts.length >= 1, "点生成入口应直接拉起 ComfyUI");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0,
                 "离线页不该发生图请求");
});

test("离线页不轮询显存：顶栏显存块收起，不发 mem_stats 请求", async () => {
    mockOfflineShell();
    document.body.insertAdjacentHTML("beforeend",
        '<div id="ns-mem"><span id="ns-vram">VRAM --</span><span id="ns-ram">RAM --</span>' +
        '<button id="ns-clear-mem">🧹 清理</button></div>');
    await import("../../web/studio/studio-app.js?offMem=1");
    await flush();
    await sleep(50);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/mem_stats").length, 0,
                 "离线时显存轮询应停掉，不每 3s 撞 409");
});

test("离线配方编辑器：运行按钮交给壳启动 ComfyUI，不发运行请求", async () => {
    mockOfflineShell();
    const starts = [];
    mockShellApi(starts);
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-director-regen-run" type="button">生成这一段</button>' +
        '<button class="neo-director-merge-run" type="button">拼回成片</button>' +
        '<button class="neo-director-sb-gen" type="button">🎨 生成图片分镜</button>');
    await import("../../web/studio/studio-app.js?offRun=1");
    await flush();

    for (const sel of [".neo-director-regen-run", ".neo-director-merge-run", ".neo-director-sb-gen"]) {
        click(document.querySelector(sel));
        await flush();
    }
    assert.ok(starts.length >= 3, "三个运行按钮都应拉起 ComfyUI");
    for (const p of ["/neo_video_gen/run_segment", "/neo_video_gen/assemble_segments",
                     "/neo_video_gen/storyboard_generate"]) {
        assert.equal(fetchLog.filter((c) => c.path === p).length, 0, `离线不该发 ${p}`);
    }
});

test("离线配方编辑器：编辑类按钮不被门控，分段生成照常打到壳", async () => {
    mockOfflineShell();
    mockShellApi([]);
    mockRoute("/rs_recipes/director_generate_segments", jsonResponse({ success: true, segments: [] }));
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-director-gen-segs" type="button">✨ 生成分镜分段</button>');
    document.querySelector(".neo-director-gen-segs").addEventListener("click", () => {
        fetch("/rs_recipes/director_generate_segments", { method: "POST", body: "{}" });
    });
    await import("../../web/studio/studio-app.js?offEdit=1");
    await flush();

    click(document.querySelector(".neo-director-gen-segs"));
    await flush();
    assert.equal(fetchLog.filter((c) => c.path === "/rs_recipes/director_generate_segments").length, 1,
                 "分段只依赖 8080 LLM：门控不该拦掉");
});
