// Neo Gallery 卡片「图片编辑」：以原图为参考，用所选技能 + 编辑指令生成新图；
// 成功后保留「再生成」按钮，支持连续重复生成，不必关窗重开。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, inputText } from "./setup.mjs";

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
