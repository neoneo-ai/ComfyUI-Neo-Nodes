// Neo Gallery 卡片「生成九宫格分镜图」：原图当参考 + 九宫格指令，产物落独立 StoryBoard 目录，
// 供导演编辑器「🧩 宫格分镜图拆分」按行优先切成视频关键帧。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, sseResponse } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

const STORY = "雨夜的地铁口，她收起伞抬头，看见多年未见的他站在灯下。";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

// 卡片 ⋯ 菜单：gallery 桩只实现本次流程真正用到的成员（弹提示 / 跳目录 / 删除 / 卡片尺寸设置）
function makeGallery(toasts) {
    const jumps = [];
    return {
        jumps,
        gallery: {
            app: { extensionManager: { toast: { add: (t) => toasts.push(t) } } },
            maxThumbnailSize: 320,
            displayLabels: true,
            deleteItem() {},
            showDirectoryStructure(source, path) { jumps.push([source, path]); return Promise.resolve(); },
        },
    };
}

function openMenu(card, gallery) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "shot", filename: "shot.png" }, "", "Output", anchor);
}

test("buildStoryboardGridRequest：默认 6 宫格（2×3），Qwen Image 2.1 + 原图参考 + StoryBoard 目录", async () => {
    const { buildStoryboardGridRequest, buildStoryboardGridPrompt } = await import("../../web/gallery-gen.js");
    const body = buildStoryboardGridRequest("NeoAgent/portrait.png", STORY);
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.width, 2048);   // 每格约 683×384（16:9）
    assert.equal(body.height, 768);   // 默认 6 宫格（2×3）
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/portrait.png" }]);
    assert.deepEqual(body.loras, []);
    assert.equal(body.skip_enhance, true);
    assert.equal(body.output_prefix, "StoryBoard");
    assert.equal(body.prompt, buildStoryboardGridPrompt(STORY));   // 默认同 6 宫格
    assert.match(body.prompt, /六宫格/);
    assert.match(body.prompt, /第 1 格到第 6 格/);
    assert.match(body.prompt, /雨夜的地铁口/);  // 故事原文进提示词
    assert.match(body.prompt, /<image1>/);     // 身份锚定：qwen_image21 分词器为每张参考图插字面量 <imageN>
    assert.match(body.prompt, /细白缝/);       // 便于「🧩 宫格分镜图拆分」自动切格
});

test("buildStoryboardGridRequest：4 / 9 宫格布局与提示词", async () => {
    const { buildStoryboardGridRequest } = await import("../../web/gallery-gen.js");
    const b4 = buildStoryboardGridRequest("p.png", STORY, 4);
    assert.equal(b4.width, 2048);
    assert.equal(b4.height, 1152);   // 2×2，每格约 1024×576
    assert.match(b4.prompt, /四宫格/);
    assert.match(b4.prompt, /第 1 格到第 4 格/);
    const b9 = buildStoryboardGridRequest("p.png", STORY, 9);
    assert.equal(b9.width, 2048);
    assert.equal(b9.height, 1152);   // 3×3，每格约 683×384
    assert.match(b9.prompt, /九宫格/);
    assert.match(b9.prompt, /第 1 格到第 9 格/);
});

test("⋯ 菜单「生成九宫格分镜图」：填故事后带参考图请求生图，窗内出结果预览，点「打开输出目录」跳转", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const toasts = [];
    const { gallery, jumps } = makeGallery(toasts);
    const card = new GalleryCard(gallery);   // 与 gallery.js 的 new GalleryCard(this) 同构
    openMenu(card, gallery);

    const item = itemByLabel("生成九宫格分镜图");
    assert.equal(item?.textContent, "\uD83E\uDDE9 生成九宫格分镜图");
    click(item);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null, "菜单应关闭");

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出填故事小窗");
    // 小窗里要有参考图本身（走卡片同一缩略图缓存接口），不能只给一个文件名
    const refImg = overlay.querySelector(".neo-gallery-story-ref-img");
    assert.match(refImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=shot\.png&subfolder=&size=480$/);
    assert.equal(refImg?.getAttribute("alt"), "shot");
    // 预览与卡片图片同高（320 缩略图 - 52 标签保留区），不放大小图
    assert.equal(refImg?.style.height, "268px");
    assert.equal(overlay.querySelector(".neo-gallery-story-ref-label").textContent, "参考图 · 人物沿用这张");
    assert.equal(overlay.querySelector(".neo-gallery-story-path").textContent, "shot.png");
    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");

    // 空故事：只提示、窗口留着、不发请求
    click(genBtn);
    await sleep(10);
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay);
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /请先填写/);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0);

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    mockRoute("/neo_gallery/archive", () => jsonResponse({ success: true, archived: 1 }));
    let body = null;
    mockRoute("/neo_image_gen/generate", (b) => {
        body = b;
        return jsonResponse({ task_id: "g1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/g1", () => jsonResponse({
        task_id: "g1", status: "succeeded",
        images: [{ filename: "nine_panel_storyboard_sheet_00001_.png", subfolder: "StoryBoard/2026-09-24", url: "/x.png" }],
    }));

    overlay.querySelector(".neo-gallery-story-input").value = STORY;
    click(genBtn);
    await sleep(50);

    const copy = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.ok(copy, "卡片图片应先经 copy_to_input 落到 input/ 当参考图");
    assert.equal(copy.query.get("filename"), "shot.png");
    assert.ok(body, "应发出 /neo_image_gen/generate 请求");
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.output_prefix, "StoryBoard");
    assert.deepEqual(body.references, [{ kind: "input", value: "shot.png" }]);
    assert.match(body.prompt, /雨夜的地铁口/);

    // 窗口保持打开并显示结果预览（走 thumbnail 缓存接口，size=640），不是点生成就关闭
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "生成过程中小窗不关闭");
    const resultImg = overlay.querySelector(".neo-gallery-cs-result-img");
    assert.match(resultImg?.getAttribute("src") || "",
        /\/neo_gallery\/thumbnail\?filename=nine_panel_storyboard_sheet_00001_\.png&subfolder=StoryBoard%2F2026-09-24&size=640$/);
    // 结果归档进画廊 Grid 主目录（按结果里的日期分段）
    const archive = fetchLog.find((c) => c.path === "/neo_gallery/archive");
    assert.ok(archive, "应把结果归档到画廊主目录");
    assert.equal(archive.method, "POST");
    assert.equal(archive.body.category, "grid");
    assert.equal(archive.body.date, "2026-09-24");
    assert.deepEqual(archive.body.files, [{ subfolder: "StoryBoard/2026-09-24", filename: "nine_panel_storyboard_sheet_00001_.png" }]);

    // 成功不自动跳目录，由「打开输出目录」触发（跳画廊 Grid 的日期子目录）并关窗
    assert.deepEqual(jumps, [], "成功后不自动跳目录");
    const openDirBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "打开输出目录");
    assert.ok(openDirBtn, "成功后应有「打开输出目录」按钮");
    click(openDirBtn);
    await sleep(10);
    assert.deepEqual(jumps, [["Grid", ["2026-09-24"]]], "打开归档后的日期子目录");
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), null, "跳转后关窗");
});

test("⋯ 菜单「生成九宫格分镜图」：生成中窗内显示进度条与「取消任务」，故事表单让位", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "g2", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/g2", () => jsonResponse({
        task_id: "g2", status: "running", progress: { value: 3, max: 10 }, images: [],
    }));

    overlay.querySelector(".neo-gallery-story-input").value = STORY;
    click(genBtn);
    await sleep(50);

    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "生成中小窗保持打开");
    assert.equal(overlay.querySelector(".neo-gallery-story-form").style.display, "none", "生成中故事表单让位给进度区");
    const fillEl = overlay.querySelector(".neo-gallery-cs-progress-fill");
    assert.equal(fillEl?.style.width, "30%", "进度条按 progress.value/max 填充");
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "取消任务"), "生成中可取消任务");

    // 派发终态让 watcher 收尾（不留悬挂监听/定时器），窗内转为错误/重试态
    dispatchApiEvent("rs.image_gen.status", { task_id: "g2", status: "cancelled" });
    await sleep(10);
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "取消后小窗仍在");
    assert.match(overlay.querySelector(".neo-gallery-cs-status .neo-gallery-story-hint").textContent, /已取消/);
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "重试"), "可重试");
});

test("⋯ 菜单「直达分镜目录」打开画廊 Grid 主目录", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery, jumps } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);

    const item = itemByLabel("直达分镜目录");
    assert.equal(item?.textContent, "\uD83D\uDCC2 直达分镜目录");
    click(item);
    await sleep(10);
    assert.deepEqual(jumps, [["Grid", []]]);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null);
});

test("小窗「✨ LLM 生成分镜故事」：简要故事 + 参考图按所选宫格数生成逐格故事，覆盖写入上方故事框", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const toasts = [];
    const { gallery } = makeGallery(toasts);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出填故事小窗");
    const llmBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "✨ LLM 生成分镜故事");
    assert.ok(llmBtn, "应有「LLM 生成分镜故事」按钮");
    // 现有输入框（九宫格故事）下面还要有个「简要故事 / 想法」输入框
    const ideaBox = overlay.querySelector(".neo-gallery-story-idea");
    assert.ok(ideaBox, "九宫格故事框下面应有简要故事输入框");
    // 宫格数下拉：4 / 6 / 9，默认 6
    const gridSel = overlay.querySelector(".neo-gallery-story-grid");
    assert.ok(gridSel, "应有宫格数下拉");
    assert.equal(gridSel.value, "6", "默认 6 宫格");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    let llmBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        llmBody = b;
        return sseResponse([
            'data: {"text":"雨夜的地铁口，她收起伞仰望。","kind":"content"}',
            'data: {"text":"\\n他站在灯下，两人相望。","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    overlay.querySelector(".neo-gallery-story-input").value = "我手写的旧故事";
    ideaBox.value = "雨夜地铁口偶遇旧友";
    click(llmBtn);
    await sleep(50);

    assert.ok(llmBody, "应调用 /rs_prompts/stream_generate_prompt");
    assert.equal(llmBody.skillId, "storyboard_story", "应走九宫格故事任务（不是反推）");
    assert.equal(llmBody.text, "雨夜地铁口偶遇旧友（按 6 格分镜）", "简要故事 + 宫格数一起带给 LLM");
    assert.deepEqual(llmBody.images, [{ kind: "input", value: "shot.png" }]);
    assert.ok(fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input"), "参考图应先经 copy_to_input 落到 input/ 再交给 LLM");

    // 生成结果覆盖写入上方故事框（不是追加），供继续编辑后再「生成」
    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "雨夜的地铁口，她收起伞仰望。\n他站在灯下，两人相望。");
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /已生成分镜故事/);
    assert.equal(llmBtn.disabled, false, "完成后按钮应恢复可用");
    assert.equal(llmBtn.textContent, "✨ LLM 生成分镜故事");
});

test("小窗「✨ LLM 生成分镜故事」：简要故事留空则只按参考图生成", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const llmBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "✨ LLM 生成分镜故事");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    let llmBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        llmBody = b;
        return sseResponse([
            'data: {"text":"她把伞收好，走向灯下。","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    overlay.querySelector(".neo-gallery-story-idea").value = "   ";   // 只输空格 = 没填
    click(llmBtn);
    await sleep(50);

    assert.ok(llmBody, "留空也应调用 LLM");
    assert.equal(llmBody.text, "（按 6 格分镜，按参考图设计故事）", "留空时只带宫格数，按参考图生成");
    assert.deepEqual(llmBody.images, [{ kind: "input", value: "shot.png" }]);
    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "她把伞收好，走向灯下。");
});
