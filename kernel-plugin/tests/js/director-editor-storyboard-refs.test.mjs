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

test("导演编辑器：全参考模式下生成的分镜关键帧进入各段参考图池（不回填首帧），保存写入 refs.images", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "image_gen", name: "Krea2 文生图", gen_image: true },
    ]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "SB-R2V" }));
    mockRoute("/neo_video_gen/storyboard_generate", () => jsonResponse({ success: true, task_id: "t-sbr2v", total: 2 }));
    mockRoute("/neo_video_gen/storyboard_status/t-sbr2v", () => jsonResponse({
        success: true, status: "done", total: 2, processed: 2,
        details: [
            { index: 0, status: "done", filename: "storyboard_SB-R2V_01.png" },
            { index: 1, status: "done", filename: "storyboard_SB-R2V_02.png" },
        ],
    }));

    await openDirectorEditor({
        name: "SB-R2V",
        shared: { mode: "r2v" },
        segments: [
            { skill_id: "sk-a", prompt: "p0", duration_sec: 5, storyboard_prompt: "画面一" },
            { skill_id: "sk-a", prompt: "p1", duration_sec: 5, storyboard_prompt: "画面二" },
        ],
    });
    await sleep(60);

    // 📖 故事板分镜页：图片分镜卡片不再被生成模式隐藏（r2v 也可见，直接在本页生成）
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    assert.equal(setupPane.querySelector(".neo-director-setup-sb").style.display, "", "全参考模式下图片分镜卡片可见");

    const sbStatus = setupPane.querySelector(".neo-director-sb-status");
    setupPane.querySelector(".neo-director-sb-gen").click();
    for (let i = 0; i < 40 && !/完成|已停止/.test(sbStatus.textContent); i++) await sleep(100);
    assert.match(sbStatus.textContent, /完成/, "分镜生成完成");

    // 关键帧进各段参考图池（refs-block 瓷砖），且不进首帧候选网格
    const rows = document.querySelectorAll(".neo-director-seg");
    const expected = ["storyboard_SB-R2V_01.png", "storyboard_SB-R2V_02.png"];
    rows.forEach((row, i) => {
        const tiles = Array.from(row.querySelectorAll(".neo-director-refs-block .neo-director-refpick-item"));
        assert.equal(tiles.length, 1, `第 ${i + 1} 段参考图池只有回填的关键帧一项`);
        assert.equal(tiles[0].dataset.file, expected[i], `第 ${i + 1} 段关键帧进入参考图池`);
        assert.ok(!Array.from(row.querySelectorAll(".neo-director-ff-item")).some((it) => it.dataset.file === expected[i]), `第 ${i + 1} 段关键帧不进首帧候选`);
    });

    // 保存：refs.images 记录关键帧并随参考素材进 assets；全参考段不带 first_frame
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    const segs = saveCall.body.segments || [];
    assert.deepEqual(segs[0].refs.images, ["storyboard_SB-R2V_01.png"], "保存写入 refs.images");
    assert.deepEqual(segs[1].refs.images, ["storyboard_SB-R2V_02.png"], "第 2 段同样写入");
    assert.ok(!segs[0].first_frame, "全参考段不携带 first_frame");
    assert.equal(segs[0].storyboard, "storyboard_SB-R2V_01.png", "段仍记录分镜图名");
    assert.ok((saveCall.body.assets || []).some((a) => a.filename === "storyboard_SB-R2V_01.png"), "参考图池里的关键帧随 assets 落盘（后端按名解析）");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：混合模式下分镜生成按各段模式路由（i2v 段作首帧、r2v 段进参考图池）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "image_gen", name: "Krea2 文生图", gen_image: true },
    ]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "SB-MIX" }));
    mockRoute("/neo_video_gen/storyboard_generate", () => jsonResponse({ success: true, task_id: "t-sbmix", total: 2 }));
    mockRoute("/neo_video_gen/storyboard_status/t-sbmix", () => jsonResponse({
        success: true, status: "done", total: 2, processed: 2,
        details: [
            { index: 0, status: "done", filename: "storyboard_SB-MIX_01.png" },
            { index: 1, status: "done", filename: "storyboard_SB-MIX_02.png" },
        ],
    }));

    await openDirectorEditor({
        name: "SB-MIX",
        shared: { mode: "mixed" },
        segments: [
            { skill_id: "sk-a", prompt: "p0", duration_sec: 5, mode: "i2v" },
            { skill_id: "sk-a", prompt: "p1", duration_sec: 5, mode: "r2v" },
        ],
    });
    await sleep(60);

    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    assert.equal(setupPane.querySelector(".neo-director-setup-sb").style.display, "", "混合模式下图片分镜卡片可见");

    const sbStatus = setupPane.querySelector(".neo-director-sb-status");
    setupPane.querySelector(".neo-director-sb-gen").click();
    for (let i = 0; i < 40 && !/完成|已停止/.test(sbStatus.textContent); i++) await sleep(100);
    assert.match(sbStatus.textContent, /完成/, "分镜生成完成");

    const rows = document.querySelectorAll(".neo-director-seg");
    // 第 1 段（f2v，旧 i2v）：关键帧回填为首帧（槽位显示）；不进参考图池
    const img0 = rows[0].querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
    assert.ok(img0 && img0.src.includes("storyboard_SB-MIX_01.png"), "f2v 段关键帧立即回填为首帧");
    assert.equal(rows[0].querySelectorAll(".neo-director-refs-block .neo-director-refpick-item").length, 0, "f2v 段关键帧不进参考图池");
    // 第 2 段（r2v）：关键帧进参考图池；不进首帧槽位
    const tiles1 = Array.from(rows[1].querySelectorAll(".neo-director-refs-block .neo-director-refpick-item"));
    assert.equal(tiles1.length, 1, "r2v 段参考图池出现关键帧");
    assert.equal(tiles1[0].dataset.file, "storyboard_SB-MIX_02.png", "r2v 段关键帧文件名正确");
    assert.ok(!rows[1].querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img"), "r2v 段关键帧不进首帧");

    // 保存：f2v 段落 first_frame，r2v 段落 refs.images
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    const segs = saveCall.body.segments || [];
    assert.equal(segs[0].first_frame, "storyboard_SB-MIX_01.png", "f2v 段保存携带 first_frame");
    assert.ok(!segs[0].refs, "f2v 段无 refs");
    assert.deepEqual(segs[1].refs.images, ["storyboard_SB-MIX_02.png"], "r2v 段保存写入 refs.images");
    assert.ok(!segs[1].first_frame, "r2v 段不携带 first_frame");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：带分镜图的旧配方切到全参考模式，关键帧自动加入该段参考图池（去重不堆叠）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "SB-SW",
        shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5, storyboard: "storyboard_sb-sw_01.png" }],
    });
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    assert.equal(row.querySelectorAll(".neo-director-refs-block .neo-director-refpick-item").length, 0, "文生模式下参考图池为空");

    const modeSel = document.querySelector(".neo-director-pane-timeline .neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    await sleep(20);
    let tiles = Array.from(row.querySelectorAll(".neo-director-refs-block .neo-director-refpick-item"));
    assert.equal(tiles.length, 1, "切到全参考后关键帧进入参考图池");
    assert.equal(tiles[0].dataset.file, "storyboard_sb-sw_01.png", "进池的是已生成的分镜关键帧");

    // 再切走切回：insert 去重，不堆重复项
    modeSel.value = "t2v";
    modeSel.dispatchEvent(new Event("change"));
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    await sleep(20);
    tiles = Array.from(row.querySelectorAll(".neo-director-refs-block .neo-director-refpick-item"));
    assert.equal(tiles.length, 1, "重复切模式不堆重复项");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：身份参考开关默认开，关掉后随 shared 落盘并可回显（对比测试用）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "ID-ON" }));

    // ① 新建/旧配方（无该键）：开关默认勾选，保存时不写该键
    await openDirectorEditor({
        name: "ID-ON",
        shared: { mode: "i2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    const chk = setupPane.querySelector(".neo-director-identity-refs");
    assert.ok(chk, "📖 故事板分镜页有身份参考开关");
    assert.equal(chk.checked, true, "默认启用");
    assert.ok(setupPane.querySelector(".neo-director-setup-sb") && setupPane.querySelector(".neo-director-identity-refs"),
        "开关与图片分镜卡片同页");
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const onCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(onCall.body.shared.identity_refs, undefined, "默认开不落盘该键");
});

test("导演编辑器：身份参考开关关掉 → shared.identity_refs=false，重开回显未勾选", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "ID-OFF" }));

    // ① 旧配方里已关掉 → 回显未勾选
    await openDirectorEditor({
        name: "ID-OFF",
        shared: { mode: "i2v", identity_refs: false },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const chk = document.querySelector(".neo-director-pane-story .neo-director-identity-refs");
    assert.equal(chk.checked, false, "回显未勾选");

    // ② 勾回来 → 保存不再带该键（恢复默认；保存后编辑器自动关闭）
    chk.checked = true;
    chk.dispatchEvent(new Event("change"));
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    let saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(saveCall.body.shared.identity_refs, undefined, "勾回启用后不再落盘该键");

    // ③ 再关掉一次并保存 → 写 false
    fetchLog.length = 0;
    await openDirectorEditor({
        name: "ID-OFF",
        shared: { mode: "i2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(30);
    const chk2 = document.querySelector(".neo-director-pane-story .neo-director-identity-refs");
    chk2.checked = false;
    chk2.dispatchEvent(new Event("change"));
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(saveCall.body.shared.identity_refs, false, "关掉时落盘 false");
});

