// 技能下拉分类分组回归：category → optgroup 归属与排序。
// 重点守护 video_gen（生视频 H3）有独立分组，不再回落进「图像提示词增强」。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

test("populateSkillOptions：video_gen 技能落入独立「🎬 生视频 (H3)」组，不回落 image_enhance", async () => {
    resetEnv();
    const { populateSkillOptions, CATEGORY_LABELS } = await import("../../web/skill.js");

    // CATEGORY_LABELS 必须含 video_gen（否则 line 里 `CATEGORY_LABELS[s.category] ? ... : "image_enhance"` 会误归类）
    assert.ok(CATEGORY_LABELS.video_gen, "CATEGORY_LABELS 应定义 video_gen 分类");

    const select = document.createElement("select");
    populateSkillOptions(select, [
        { id: "krea2", name: "Krea2 出图", category: "image_gen" },
        { id: "h3_t2v", name: "H3 文生视频", category: "video_gen" },
        { id: "h3_i2v", name: "H3 图生视频", category: "video_gen" },
        { id: "anime_style", name: "动漫风格", category: "image_enhance" },
        { id: "weird", name: "未知分类", category: "no_such_cat" }, // 回落 image_enhance
    ]);

    const groupOf = (id) => select.querySelector(`option[value="${id}"]`).parentElement;
    const labelOf = (id) => groupOf(id).label;

    // video_gen 技能进「🎬 生视频 (H3)」组，而非 image_enhance
    assert.equal(labelOf("h3_t2v"), "🎬 生视频 (H3)");
    assert.equal(labelOf("h3_i2v"), "🎬 生视频 (H3)");

    // 对照：image_gen / image_enhance 归属不变；未知分类仍回落 image_enhance
    assert.equal(labelOf("krea2"), "🖼️ 生图 (Krea2)");
    assert.equal(labelOf("anime_style"), "🎨 图像提示词增强");
    assert.equal(labelOf("weird"), "🎨 图像提示词增强");

    // 排序：image_gen → video_gen → image_enhance（生成类排前，未知回落组在其后）
    const order = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    assert.deepEqual(order, [
        "🖼️ 生图 (Krea2)",
        "🎬 生视频 (H3)",
        "🎨 图像提示词增强",
    ]);
});
