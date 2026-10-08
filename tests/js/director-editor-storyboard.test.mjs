// 导演编辑器「故事板分镜生成」：分镜回退点名、关键帧回填首帧、配方资产路由。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, sleep, fetchLog, inputText, changeValue, dropFiles, makeFile } from "./setup.mjs";
import { app, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
    const { resetDirectorTabMemory } = await import("../../web/director.js");
    resetDirectorTabMemory();   // 页签记忆是模块级会话状态，逐用例清零避免跨用例串味
});

test("导演编辑器：分镜回退用视频提示词时点名提示（后端 warning 不再被吞掉）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "image_gen", name: "Krea2 文生图", gen_image: true }]));
    mockRoute("/neo_video_gen/storyboard_generate", () => jsonResponse({ success: true, task_id: "t-fb", total: 2 }));
    const fallbackWarn = "该段没有分镜提示词，已回退用视频提示词生图（含运动描述，不一定适合生图）";
    mockRoute("/neo_video_gen/storyboard_status/t-fb", () => jsonResponse({
        success: true, status: "done", total: 2, processed: 2,
        details: [
            { index: 0, status: "done", filename: "storyboard_FB_01.png", warnings: [fallbackWarn] },
            { index: 1, status: "done", filename: "storyboard_FB_02.png", warnings: [] },
        ],
    }));

    await openDirectorEditor({
        name: "FB",
        shared: { mode: "t2v" },
        segments: [
            { skill_id: "sk-a", prompt: "镜头跟随她走进大厅", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "她停在吧台前", duration_sec: 5 },
        ],
    });
    await sleep(60);
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    const sbStatus = setupPane.querySelector(".neo-director-sb-status");
    setupPane.querySelector(".neo-director-sb-gen").click();
    for (let i = 0; i < 40 && !/完成|已停止/.test(sbStatus.textContent); i++) await sleep(100);

    assert.match(sbStatus.textContent, /第 1 段无分镜提示词/, "状态文案点名回退的段号");
    const warn = appState.toasts.find((t) => t.summary === "图片分镜" && /回退视频提示词/.test(t.detail || ""));
    assert.ok(warn, "回退段弹提示条（不再静默用视频提示词生图）");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：生成的分镜自动回填首帧 → 首帧缩略图走配方资产路由，保存不再重复拷贝该关键帧", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "image_gen", name: "Krea2 文生图", gen_image: true },
    ]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "SB-SUB" }));
    mockRoute("/neo_video_gen/storyboard_generate", () => jsonResponse({ success: true, task_id: "t-sub", total: 1 }));
    mockRoute("/neo_video_gen/storyboard_status/t-sub", () => jsonResponse({
        success: true, status: "done", total: 1, processed: 1,
        details: [{ index: 0, status: "done", filename: "storyboard_SB-SUB_01.png" }],
    }));

    await openDirectorEditor({
        name: "SB-SUB",
        shared: { mode: "i2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5, storyboard_prompt: "画面一" }],
    });
    await sleep(60);

    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    const sbStatus = setupPane.querySelector(".neo-director-sb-status");
    setupPane.querySelector(".neo-director-sb-gen").click();
    for (let i = 0; i < 40 && !/完成|已停止/.test(sbStatus.textContent); i++) await sleep(100);
    assert.match(sbStatus.textContent, /完成/, "分镜生成完成");

    const row = document.querySelectorAll(".neo-director-seg")[0];
    const img = row.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
    assert.ok(img, "生成的分镜自动回填为第 1 段首帧");
    const src = decodeURIComponent(img.getAttribute("src"));
    // 关键帧就在配方 assets/：缩略图必须走 /rs_recipes/asset（不经 input/，与节点只读时间轴同源）
    assert.match(src, /^\/rs_recipes\/asset\?recipe=SB-SUB/, "缩略图走配方资产路由（带配方名）");
    assert.match(src, /file=storyboard_SB-SUB_01\.png/, "资产路由带上关键帧文件名");

    // 保存：已在配方 assets/ 里的关键帧不再作为待拷贝资产提交（后端按名沿用，不重复落一份）
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    const asset = (saveCall.body.assets || []).find((a) => a.filename === "storyboard_SB-SUB_01.png");
    assert.equal(asset, undefined, "关键帧不进保存资产清单（避免重复拷贝）");
    assert.equal((saveCall.body.segments || [])[0].storyboard, "storyboard_SB-SUB_01.png", "段仍记录分镜图名");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：f2v 生成的分镜也立即回填各段首帧（不区分生成模式），保存携带 first_frame", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "image_gen", name: "Krea2 文生图", gen_image: true },
    ]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "SB-T2V" }));
    mockRoute("/neo_video_gen/storyboard_generate", () => jsonResponse({ success: true, task_id: "t-sbt2v", total: 2 }));
    mockRoute("/neo_video_gen/storyboard_status/t-sbt2v", () => jsonResponse({
        success: true, status: "done", total: 2, processed: 2,
        details: [
            { index: 0, status: "done", filename: "storyboard_SB-T2V_01.png" },
            { index: 1, status: "done", filename: "storyboard_SB-T2V_02.png" },
        ],
    }));

    await openDirectorEditor({
        name: "SB-T2V",
        shared: { mode: "t2v" },
        segments: [
            { skill_id: "sk-a", prompt: "p0", duration_sec: 5, storyboard_prompt: "画面一" },
            { skill_id: "sk-a", prompt: "p1", duration_sec: 5, storyboard_prompt: "画面二" },
        ],
    });
    await sleep(60);

    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    const sbStatus = setupPane.querySelector(".neo-director-sb-status");
    setupPane.querySelector(".neo-director-sb-gen").click();
    for (let i = 0; i < 40 && !/完成|已停止/.test(sbStatus.textContent); i++) await sleep(100);
    assert.match(sbStatus.textContent, /完成/, "分镜生成完成");

    // f2v（旧 t2v 重映射）下也立即回填：两段的首帧槽位各自显示关键帧
    const rows = document.querySelectorAll(".neo-director-seg");
    const expected = ["storyboard_SB-T2V_01.png", "storyboard_SB-T2V_02.png"];
    rows.forEach((row, i) => {
        const img = row.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
        assert.ok(img && img.src.includes(expected[i]), `第 ${i + 1} 段生成后立即回填关键帧为首帧`);
    });

    // 保存：已回填的关键帧直接随段落盘
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    const segs = saveCall.body.segments || [];
    assert.equal(segs[0].first_frame, "storyboard_SB-T2V_01.png", "携带已回填的关键帧首帧");
    assert.equal(segs[1].first_frame, "storyboard_SB-T2V_02.png", "第 2 段同样生效");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

