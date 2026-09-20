// 配方列表卡片：多段导演配方点缩略图直接进编辑器（跳过详情）；普通配方仍打开详情。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, dialogs, setConfirmAnswer } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

test("配方列表：多段导演配方点缩略图直接打开编辑器，普通配方仍打开详情", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [] },
        { name: "normal-recipe", source: "custom", prompt: "hello", assets: [{ kind: "image", file: "a.png" }], samples: [] },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    const covers = Array.from(panel.querySelectorAll(".neo-recipes-card-cover"));
    assert.equal(covers.length, 2, "两个配方卡片");

    // 多段导演配方（第一个）：点缩略图 → 打开编辑器浮层，不打开详情
    covers[0].click();
    await sleep(80);
    assert.ok(document.querySelector(".neo-director-overlay"), "导演配方点缩略图打开编辑器");
    assert.equal(document.querySelector(".neo-recipes-detail"), null, "未打开详情浮层");

    // 关闭编辑器，再测普通配方
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);

    // 普通配方（第二个）：点缩略图 → 打开详情浮层，不打开编辑器
    covers[1].click();
    await sleep(30);
    assert.ok(document.querySelector(".neo-recipes-detail"), "普通配方点缩略图打开详情");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "未打开编辑器");
});

test("配方卡片：每个配方都有复制按钮，点击调用 /rs_recipes/copy 传源名", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "src-recipe", source: "custom", prompt: "hello", assets: [], samples: [] },
        { name: "preset-x", source: "preset", prompt: "pp", assets: [], samples: [] },
    ]));
    let copyBody = null;
    mockRoute("/rs_recipes/copy", (body) => {
        copyBody = body;
        return jsonResponse({ success: true, name: "src-recipe-copy" });
    });

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    // custom 与 preset 配方都应显示复制按钮（preset 可复制成 custom）
    assert.equal(panel.querySelectorAll(".neo-recipes-card").length, 2, "两个配方卡片");
    const copyBtns = panel.querySelectorAll(".neo-recipes-copy");
    assert.equal(copyBtns.length, 2, "每个配方都有复制按钮");

    copyBtns[0].click();
    await sleep(80);
    assert.deepEqual(copyBody, { name: "src-recipe" }, "调用 /rs_recipes/copy 传源配方名");
    assert.ok(appState.toasts.some(t => t.summary === "配方已复制"), "复制成功弹 toast");
});

test("配方详情：导演配方显示段数/模式/技能/宽×高/总时长概览行", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "sk-b", name: "技能 B", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        {
            name: "dir-unified", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 1344, height: 768, mode: "t2v" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p2", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p3", duration_sec: 5 },
            ],
        },
        {
            name: "dir-mixed", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 768, height: 1344, mode: "mixed" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5, mode: "i2v" },
                { skill_id: "sk-b", prompt: "p2", duration_sec: 3.5, mode: "t2v" },
            ],
        },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    // 统一模式：技能同名聚合 ×3，总时长 15s
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(80);
    let meta = document.querySelector(".neo-recipes-detail-meta");
    assert.ok(meta, "导演配方详情有概览行");
    assert.equal(meta.textContent, "3 段 · 文生视频 · 技能 A ×3 · 1344×768 · 总时长 15s", "统一模式概览行内容");

    // 混合模式：多技能并列、小数总时长
    document.querySelector(".neo-recipes-detail-close")?.click();
    await sleep(20);
    const names = panel.querySelectorAll(".neo-recipes-card-name");
    names[1].click();
    await sleep(80);
    meta = document.querySelector(".neo-recipes-detail-meta");
    assert.equal(meta.textContent, "2 段 · 混合模式 · 技能 A、技能 B · 768×1344 · 总时长 8.5s", "混合模式概览行内容");
});

test("配方卡片：多段导演配方正文显示摘要行（代替无提示词）", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        {
            name: "dir-card", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 960, height: 544, mode: "i2v" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p2", duration_sec: 5 },
            ],
        },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const meta = panel.querySelector(".neo-recipes-card-meta");
    assert.equal(meta.textContent, "2 段 · 图生视频 · 技能 A ×2 · 960×544 · 总时长 10s", "多段导演卡片正文显示摘要行");
});


// ---- 配方结果（results）：执行产物路径的查看与删除 ----

function resultRecipe(over = {}) {
    return {
        name: "res-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
        result_count: 1,
        results: [{ filename: "shot_00001.mp4", subfolder: "", kind: "video", at: "2026-01-01 00:00:00" }],
        ...over,
    };
}

test("配方详情：结果区按 output 路径渲染，点击打开 Lightbox，卡片显示结果数", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([resultRecipe()]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    assert.match(panel.querySelector(".neo-recipes-card-meta").textContent, /1 个结果/, "卡片元信息带结果数");

    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);
    const sections = [...document.querySelectorAll(".neo-recipes-detail-section")].map(e => e.textContent);
    assert.ok(sections.includes("结果（1）"), `详情有结果区：${sections.join(",")}`);

    const item = document.querySelector(".neo-recipes-result-del").closest(".neo-recipes-detail-asset");
    const video = item.querySelector("video");
    assert.ok(video, "视频结果用 video 缩略图");
    assert.equal(video.getAttribute("src"), "/view?filename=shot_00001.mp4&subfolder=&type=output", "走 ComfyUI 原生 /view 读 output 文件");
    assert.match(item.querySelector(".neo-recipes-detail-file").textContent, /shot_00001\.mp4/);
    assert.match(document.querySelector(".neo-recipes-result-del").title, /output/, "删除按钮说明会删磁盘文件");

    item.click();
    await sleep(60);
    assert.ok(document.querySelector(".neo-lightbox"), "点击结果打开 Lightbox");
    document.querySelector(".neo-lightbox-close")?.click();
});

test("配方详情：🗑 删除结果先 confirm；取消不删，确认后调 delete_result 并刷新", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let recipes = [resultRecipe()];
    mockRoute("/rs_recipes/list", () => jsonResponse(recipes));
    let deleted = null;
    mockRoute("/rs_recipes/delete_result", (body) => {
        deleted = body;
        recipes = [resultRecipe({ results: [], result_count: 0 })];
        return jsonResponse({ success: true, deleted: true });
    });

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);

    setConfirmAnswer(false); // 取消
    document.querySelector(".neo-recipes-result-del").click();
    await sleep(40);
    assert.equal(deleted, null, "取消确认不得调用删除接口");
    assert.equal(dialogs.confirms.length, 1);
    assert.match(dialogs.confirms[0], /shot_00001\.mp4/, "确认文案带文件名");
    assert.ok(document.querySelector(".neo-recipes-result-del"), "条目仍在");

    setConfirmAnswer(true); // 确认
    document.querySelector(".neo-recipes-result-del").click();
    await sleep(100);
    assert.deepEqual(deleted, { name: "res-recipe", filename: "shot_00001.mp4", subfolder: "", kind: "video" },
        "传配方名 + 路径 + 类型");
    assert.equal(document.querySelectorAll(".neo-recipes-result-del").length, 0, "删除后详情重渲染，结果区消失");
});

