// 生图技能输入形态分类：文生图页、图片编辑页与分镜 t2i/r2i 各列哪些技能由这三个判定决定。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

async function loadMode() {
    resetEnv();
    const mod = await import("../../web/skill.js");
    return [mod.skillImageMode, mod.skillAcceptsText, mod.skillAcceptsRef];
}

test("skillImageMode：mode 声明优先，无 mode 回落 requires_ref", async () => {
    const [skillImageMode] = await loadMode();

    assert.equal(skillImageMode({ id: "a", mode: "t2i" }), "t2i");
    assert.equal(skillImageMode({ id: "b", mode: "edit", requires_ref: true }), "edit");
    assert.equal(skillImageMode({ id: "c", mode: "t2i_edit" }), "t2i_edit");
    // 画布导入的用户技能没有 mode：有参考图槽位即编辑类（画布回写维护 requires_ref）
    assert.equal(skillImageMode({ id: "u1", requires_ref: true }), "edit");
    assert.equal(skillImageMode({ id: "u2" }), "t2i");
    // 视频技能的 mode 不是生图形态值，带参考图的视频技能按 requires_ref 归类（生图列表先过 gen_image）
    assert.equal(skillImageMode({ id: "v", mode: "i2v", requires_ref: true }), "edit");
    assert.equal(skillImageMode(null), "t2i");
});

test("skillAcceptsText / skillAcceptsRef：两栖技能两边都在列", async () => {
    const [skillImageMode, skillAcceptsText, skillAcceptsRef] = await loadMode();

    const t2i = { id: "image_gen", mode: "t2i" };
    const edit = { id: "qwen_image_21_face_swap", mode: "edit", requires_ref: true };
    const dual = { id: "qwen_image_21", mode: "t2i_edit" };

    assert.deepEqual([skillAcceptsText(t2i), skillAcceptsRef(t2i)], [true, false],
        "纯文生图只进文生图页：挂原图会被模板丢掉");
    assert.deepEqual([skillAcceptsText(edit), skillAcceptsRef(edit)], [false, true],
        "编辑类只进图片编辑页：文生图页没有图可给");
    assert.deepEqual([skillAcceptsText(dual), skillAcceptsRef(dual)], [true, true],
        "Qwen Image 2.1 生图/编辑两页都在列");
});
