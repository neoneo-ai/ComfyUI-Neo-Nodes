// Neo Gallery 卡片「生成九宫格分镜图」：原图当参考 + 九宫格指令，产物落独立 StoryBoard 目录，
// 供导演编辑器「🧩 宫格分镜图拆分」按行优先切成视频关键帧。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, sseResponse } from "./setup.mjs";

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

test("buildStoryboardGridRequest：Qwen Image 2.1 + 原图参考 + 九宫格指令 + StoryBoard 目录", async () => {
    const { buildStoryboardGridRequest, buildStoryboardGridPrompt } = await import("../../web/gallery-gen.js");
    const body = buildStoryboardGridRequest("NeoAgent/portrait.png", STORY);
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.width, 2048);   // 2048 基准 16:9，与导演编辑器一键九宫格同尺寸（每格约 683×384）
    assert.equal(body.height, 1152);
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/portrait.png" }]);
    assert.deepEqual(body.loras, []);
    assert.equal(body.skip_enhance, true);
    assert.equal(body.output_prefix, "StoryBoard");
    assert.equal(body.prompt, buildStoryboardGridPrompt(STORY));
    assert.match(body.prompt, /九宫格/);
    assert.match(body.prompt, /雨夜的地铁口/);  // 故事原文进提示词
    assert.match(body.prompt, /<image1>/);     // 身份锚定：qwen_image21 分词器为每张参考图插字面量 <imageN>
    assert.match(body.prompt, /细白缝/);       // 便于「🧩 宫格分镜图拆分」自动切格
});

test("⋯ 菜单「生成九宫格分镜图」：填故事后带参考图请求生图，成功后跳到产物目录", async () => {
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
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), null, "提交后小窗应关闭");
    assert.deepEqual(jumps, [["Output", ["StoryBoard", "2026-09-24"]]], "成功后跳到产物所在目录");
    assert.ok(toasts.some((t) => t.severity === "success"), "应弹成功提示");
});

test("⋯ 菜单「直达分镜目录」打开 Output/StoryBoard", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery, jumps } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);

    const item = itemByLabel("直达分镜目录");
    assert.equal(item?.textContent, "\uD83D\uDCC2 直达分镜目录");
    click(item);
    await sleep(10);
    assert.deepEqual(jumps, [["Output", ["StoryBoard"]]]);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null);
});

test("小窗「✨ LLM 生成提示词」：参考图经反推流式写入故事框（已有内容追加）", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const toasts = [];
    const { gallery } = makeGallery(toasts);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出填故事小窗");
    const llmBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "✨ LLM 生成提示词");
    assert.ok(llmBtn, "应有「LLM 生成提示词」按钮");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    let llmBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        llmBody = b;
        return sseResponse([
            'data: {"text":"雨夜的地铁口，","kind":"content"}',
            'data: {"text":"她收起伞抬头。","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    // 已有内容应保留并追加到下方，而非被覆盖
    overlay.querySelector(".neo-gallery-story-input").value = "我想要一个悬疑开场";
    click(llmBtn);
    await sleep(50);

    assert.ok(llmBody, "应调用 /rs_prompts/stream_generate_prompt");
    assert.equal(llmBody.skillId, "reverse_prompt");
    assert.deepEqual(llmBody.images, [{ kind: "input", value: "shot.png" }]);
    assert.ok(fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input"), "参考图应先经 copy_to_input 落到 input/ 再交给 LLM");

    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "我想要一个悬疑开场\n\n雨夜的地铁口，她收起伞抬头。");
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /已按参考图生成提示词/);
    assert.equal(llmBtn.disabled, false, "完成后按钮应恢复可用");
    assert.equal(llmBtn.textContent, "✨ LLM 生成提示词");
});
