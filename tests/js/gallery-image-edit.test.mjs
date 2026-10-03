// Neo Gallery 卡片「图片编辑」：以原图为参考，用所选技能 + 编辑指令生成新图；
// 成功后保留「再生成」按钮，支持连续重复生成，不必关窗重开。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, inputText, window } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

test("图片编辑弹窗：idle 有「生成」，成功后保留「再生成」可连续重复生成", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");

    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    assert.ok(overlay, "应弹出图片编辑弹窗");

    // idle：有「生成」按钮，且尚未发请求
    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map((b) => b.textContent);
    const idleGenBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");
    assert.ok(idleGenBtn, "idle 应有「生成」按钮");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0);

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: "ie1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/ie1", () => jsonResponse({
        task_id: "ie1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "edit_00001_.png", subfolder: "Output/2026-09-30", url: "/e.png" }],
    }));

    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click(idleGenBtn);
    await sleep(80);

    // 第一次生成成功：结果显示，且操作区保留「再生成」+「关闭」（核心修复点）
    const resultImg = overlay.querySelector(".neo-gallery-edit-compare-img[alt='编辑结果']");
    assert.match(resultImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=edit_00001_\.png/);
    assert.ok(btns().includes("再生成"), "成功后应保留「再生成」按钮");
    assert.ok(btns().includes("关闭"), "成功后应有「关闭」按钮");
    assert.equal(genCount, 1);

    // 点「再生成」→ 再次发请求，无需关窗重开（连续重复生成）
    const regenBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "再生成");
    click(regenBtn);
    await sleep(80);
    assert.equal(genCount, 2, "点「再生成」应再次发出 /neo_image_gen/generate 请求");
});

test("图片编辑弹窗：扩图开关切到扩图技能，拖框后请求带 outpaint 且不带 loras", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    // skills mock 必须在开窗前注册（下拉 fetch 在开窗时同步发出）
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：给原图显示/自然尺寸（显示 400×300，自然 800×600）
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    // 打开扩图：技能切到扩图技能、控制行出现、宽高输入隐藏、提示词预填默认触发词
    const outpaintBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn");
    click(outpaintBtn);
    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21_outpaint", "开扩图应切到扩图技能");
    assert.notEqual(overlay.querySelector(".neo-gallery-edit-outpaint-row").style.display, "none");
    assert.equal(overlay.querySelector("#img-edit-width").style.display, "none");
    assert.match(overlay.querySelector(".neo-gallery-story-input").value, /Outpaint the image/);

    // 拖 se 手柄：显示 400×300 → 500×360（自然像素 right=208 bottom=128）
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 500, 360);
    pointerAt(window, "pointerup", 500, 360);

    // 画布（500×360）超出舞台（显示 400×300）→ 整体等比缩小 scale(0.8)，手柄反向缩放保持可抓取
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.transform, "scale(0.8)");
    assert.equal(canvasEl.style.getPropertyValue("--op-inv"), "1.2500");

    // 结果尺寸标签：画布 1008×728 → 1MP 目标 1184×864
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1008×728 → 1184×864");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let genBody = null;
    mockRoute("/neo_image_gen/generate", (body) => {
        genBody = body;
        return jsonResponse({ task_id: "ie2", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/ie2", () => jsonResponse({
        task_id: "ie2", status: "succeeded", width: 1184, height: 864,
        images: [{ filename: "outp_00001_.png", subfolder: "Output/2026-10-03", url: "/o.png" }],
    }));

    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);

    assert.ok(genBody, "应发出扩图生成请求");
    assert.equal(genBody.skill_id, "qwen_image_21_outpaint");
    assert.deepEqual(genBody.outpaint, { left: 0, top: 0, right: 208, bottom: 128, total_pixels: 1 });
    assert.equal(genBody.loras, undefined, "扩图模式不应传 loras（由技能 config 固定）");
    assert.equal(genBody.width, 1184);
    assert.equal(genBody.height, 864);

    // 关闭扩图：技能切回、拖框移除
    click(outpaintBtn);
    assert.equal(skillSel.value, "qwen_image_21");
    assert.equal(overlay.querySelector(".neo-gallery-edit-outpaint-box"), null);
});

test("图片编辑弹窗：扩图拖框画布边长封顶 4× 原图，超出舞台整体缩小", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：给原图显示/自然尺寸（显示 400×300，自然 800×600）
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    // 一次拖到极远处：画布被封顶在 4× 原图（1600×1200）
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 20000, 20000);
    pointerAt(window, "pointerup", 20000, 20000);

    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "1600px");
    assert.equal(canvasEl.style.height, "1200px");
    // 显示缩放 min(1, 400/1600, 300/1200) = 0.25，画布始终不越出舞台
    assert.equal(canvasEl.style.transform, "scale(0.25)");
});
test("图片编辑弹窗：扩图基准取 contain 后的可见图片尺寸，原图元素盒的留黑不算进画布", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "wide", filename: "wide.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // 原图元素盒 800×300（object-fit:contain 左右留黑），自然 800×600；舞台 800×300
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 800], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }
    const stage = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    for (const [key, value] of [["clientWidth", 800], ["clientHeight", 300]]) {
        Object.defineProperty(stage, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));

    // contain: min(800/800, 300/600)=0.5 → 画布 400×300（把元素盒当画布会得到 800×300，即"点开自动变大"）
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "400px");
    assert.equal(canvasEl.style.height, "300px");
    // 基准冻结：原图移进画布后不再反量它（画布内量它只会得到 0 → 退回自然尺寸）
    assert.equal(origImg.style.width, "400px");
    assert.equal(origImg.style.height, "300px");
    assert.equal(canvasEl.style.transform, "scale(1)");
    // 无留白 → 目标尺寸就是原图自然尺寸
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 800×600 → 1152×864");
});

test("图片编辑弹窗：扩图拖框体是平移留白，不会把框缩回原图", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    // 先拖 se 手柄加留白：400×300 → 500×360
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 500, 360);
    pointerAt(window, "pointerup", 500, 360);
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "500px");

    // 再拖框体向左：此时显示缩放 0.8（指针位移换算 ×1.25），但框必须包住原图 → 左移被夹在 100
    const boxEl = overlay.querySelector(".neo-gallery-edit-outpaint-box");
    pointerAt(boxEl, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 300, 300);
    pointerAt(window, "pointerup", 300, 300);
    assert.equal(canvasEl.style.width, "500px", "拖框体不应改变画布尺寸");
    assert.equal(canvasEl.style.height, "360px");
    assert.equal(origImg.style.left, "100px", "原图应在画布内右移 100（左边留白）");
    assert.equal(origImg.style.top, "0px");

    // 继续左拖：夹在包住原图的极限，不再移动
    pointerAt(boxEl, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 0, 300);
    pointerAt(window, "pointerup", 0, 300);
    assert.equal(origImg.style.left, "100px");

    // 留白总量不变（右 208 变成左 208）
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1008×728 → 1184×864");
});

test("图片编辑弹窗：局部开关切到局部技能、涂抹画布出现，未涂抹禁止生成", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_local_edit", cn_name: "Qwen Image 2.1 高分局部编辑", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    const localBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn:nth-of-type(2)");
    assert.ok(localBtn && localBtn.textContent.includes("局部"), "应有「局部」按钮");
    click(localBtn);
    await sleep(10);

    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21_local_edit", "开局部应切到局部技能");
    const localRow = [...overlay.querySelectorAll(".neo-gallery-edit-outpaint-row")]
        .find((r) => r.contains(overlay.querySelector(".neo-gallery-edit-brush")));
    assert.ok(localRow && localRow.style.display !== "none", "应出现局部控制行（画笔/橡皮）");
    assert.ok(overlay.querySelector(".neo-gallery-edit-paint-canvas"), "应出现涂抹画布");
    assert.equal(overlay.querySelector("#img-edit-width").style.display, "none", "局部模式隐藏宽高输入");

    // 未涂抹直接生成 → 报错、不发请求
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => { genCount += 1; return jsonResponse({ task_id: "ie3", status: "queued", images: [] }); });
    inputText(overlay.querySelector(".neo-gallery-story-input"), "把划痕去掉");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(40);
    assert.equal(genCount, 0, "未涂抹不应发出请求");
    assert.match(overlay.querySelector(".neo-gallery-story-hint-error")?.textContent || "", /涂抹/);

    // 关闭局部：技能切回、画布移除
    click(localBtn);
    await sleep(10);
    assert.equal(skillSel.value, "qwen_image_21");
    assert.equal(overlay.querySelector(".neo-gallery-edit-paint-canvas"), null);
});

test("图片编辑弹窗：第二参考图拖放选中后随请求发送，扩图/局部模式下不可用", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "body_b.png" }));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const refDropZone = overlay.querySelector(".neo-gallery-edit-refdrop");
    assert.ok(refDropZone, "应有参考图拖放区");

    // 模拟从素材库拖放（application/x-neo-gallery MIME）
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"body_b.png","subfolder":"people"}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    refDropZone.dispatchEvent(dropEv);
    await sleep(30);

    const chipImg = overlay.querySelector(".neo-gallery-edit-refchip-img");
    assert.ok(chipImg, "拖放后应显示参考图缩略图");
    assert.match(chipImg.getAttribute("src"), /filename=body_b\.png/);

    // 生成请求携带第二张参考图
    let genBody = null;
    mockRoute("/neo_image_gen/generate", (body) => { genBody = body; return jsonResponse({ task_id: "ie4", status: "queued", images: [] }); });
    inputText(overlay.querySelector(".neo-gallery-story-input"), "把脸换成参考图的脸");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(60);
    assert.ok(genBody, "应发出生成请求");
    assert.equal(genBody.references.length, 2);
    assert.deepEqual(genBody.references[1], { kind: "input", value: "body_b.png" });

    // 开扩图：第二参考不可用且被清除
    const outpaintBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn");
    click(outpaintBtn);
    await sleep(10);
    assert.ok(refDropZone.classList.contains("disabled"), "扩图模式下拖放区应禁用");
    assert.equal(overlay.querySelector(".neo-gallery-edit-refchip-img"), null, "扩图模式应清除已选第二参考");
});

test("图片编辑弹窗：生成失败（缺模型）弹 action toast 引导去技能详情", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie5", status: "queued", images: [] }));
    // 非终态：resync 不结算（getJson 遇 error 字段会抛并被吞），失败终态由 WS 事件推送
    mockRoute("/neo_image_gen/status/ie5", () => jsonResponse({ task_id: "ie5", status: "running" }));

    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(50);

    // 派发失败终态：缺模型（非 LLM 报文），带候选提示
    dispatchApiEvent("rs.image_gen.status", { task_id: "ie5", status: "failed", error: "找不到模型 Qwen/qwen_image_2.1_int8_convrot.safetensors（diffusion_models）；候选: QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors" });
    await sleep(10);

    // 窗内留错误 + 可重试
    assert.match(overlay.querySelector(".neo-gallery-story-hint-error")?.textContent || "", /找不到模型/);
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "重试"), "可重试");

    // 弹 action toast：summary/detail + 「打开技能详情」入口（而非仅提示）
    const toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.ok(toast, "应弹 action toast");
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "图片编辑生成失败");
    assert.match(toast.querySelector(".neo-at-detail").textContent, /找不到模型/);
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开技能详情");
});

