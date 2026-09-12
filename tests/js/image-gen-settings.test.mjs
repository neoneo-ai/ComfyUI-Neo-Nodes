// 生图设置：全局「生图默认设置」表单含 生图模型区 + 生视频模型区（MiniMax H3）+ 输出前缀（LoRA/张数/比例只在每技能设置）；
// 每技能模型区 createModelConfigSection 的四视图 LoRA（文件名含 quadview/四视图）「依赖参考图」默认勾选、
// 普通 LoRA 不默认勾选、已显式保存的 ref_only 值被尊重、选中四视图 LoRA 时自动勾选、「自动」项显示建议名。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse } from "./setup.mjs";

const QV = "krea2/Edit/Krea2-QuadView_krea2_v1.safetensors";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// 构造每技能模型区并 load（同步），返回所有 LoRA 行的「依赖参考图」复选框
async function formLoras(settingsLoras, modelLoras) {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    section.load({ loras: settingsLoras }, { loras: modelLoras });
    return { el: section.el, chks: [...section.el.querySelectorAll(".rs-gen-lora-refonly")] };
}

test("四视图 LoRA（无显式 ref_only）默认勾选「依赖参考图」", async () => {
    const { chks } = await formLoras([{ name: QV, strength: 1.0 }], [QV]);
    assert.equal(chks.length, 1);
    assert.equal(chks[0].checked, true, "四视图 LoRA 应默认勾选");
});

test("中文四视图名称同样命中（大小写不敏感）", async () => {
    const name = "krea2/Edit/Krea2-四视图QuadView_v1.safetensors";
    const { chks } = await formLoras([{ name, strength: 1.0 }], [name]);
    assert.equal(chks[0].checked, true);
});

test("普通 LoRA 不默认勾选；显式 ref_only=false 被尊重", async () => {
    const { chks } = await formLoras(
        [
            { name: "krea2/Edit/SomeStyle.safetensors", strength: 1.0 },
            { name: QV, strength: 1.0, ref_only: false },
        ],
        ["krea2/Edit/SomeStyle.safetensors", QV],
    );
    assert.equal(chks.length, 2);
    assert.equal(chks[0].checked, false, "普通 LoRA 不默认勾选");
    assert.equal(chks[1].checked, false, "显式 ref_only=false 应尊重（不强制勾选）");
});

test("新建行选中四视图 LoRA 时自动勾选「依赖参考图」", async () => {
    const { el } = await formLoras([], [QV]);
    assert.equal(el.querySelectorAll(".rs-gen-lora-row").length, 0, "空设置无 LoRA 行");
    el.querySelector(".rs-gen-lora-add").click();
    const row = el.querySelector(".rs-gen-lora-row");
    const select = row.querySelector("select");
    const chk = row.querySelector(".rs-gen-lora-refonly");
    assert.equal(chk.checked, false, "新建空行默认不勾选");
    select.value = QV;
    select.dispatchEvent(new Event("change"));
    assert.equal(chk.checked, true, "选中四视图 LoRA 后应自动勾选");
});

test("LoRA「自动」选项显示后端建议的四视图 LoRA", async () => {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    section.load({ loras: [{ name: QV, strength: 1.0 }] },
        { loras: [QV, "style_a.safetensors"], suggested_lora: QV });
    const row = section.el.querySelector(".rs-gen-lora-row");
    assert.ok(row, "应有 LoRA 行");
    const select = row.querySelector("select");
    assert.ok(select, "应有 LoRA 下拉");
    // suggested_lora 经 shortModelName（取末段去扩展名）后作为「自动」项文案
    assert.equal(select.options[0].textContent, "自动（Krea2-QuadView_krea2_v1）", "首项应为带建议名的「自动」");
});

test("全局生图默认设置表单只含 生图模型区 + 输出前缀（不含 LoRA/张数/比例/视频）", async () => {
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const form = createImageGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const labels = [...form.el.querySelectorAll(".rs-form-label")].map((el) => el.textContent);
    assert.deepEqual(labels, ["生图模型", "Text Encoder", "VAE", "输出前缀"]);
    assert.equal(form.el.querySelector(".rs-gen-lora-list"), null, "全局表单不应有 LoRA 列表");
    assert.equal(form.el.querySelector("input[type=number]"), null, "全局表单不应有张数/强度数字框");
    assert.ok(form.el.querySelector(".rs-gen-save"), "应保留保存按钮");
});

test("全局生视频默认设置表单含 视频模型 / Text Encoder (视频) / VAE (视频) / VAE (音频)", async () => {
    const { createVideoGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const form = createVideoGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const labels = [...form.el.querySelectorAll(".rs-form-label")].map((el) => el.textContent);
    assert.deepEqual(labels, ["视频模型", "Text Encoder (视频)", "VAE (视频)", "VAE (音频)"]);
    assert.ok(form.el.querySelector(".rs-gen-save"), "应保留保存按钮");
});

test("createVideoModelConfigSection：load 填充四个模型下拉、collect 返回 model/text_encoder/vae/audio_vae", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load(
        { model: "h3/model.safetensors", text_encoder: "h3/te.safetensors",
          vae: "h3/video_vae.safetensors", audio_vae: "h3/audio_vae.safetensors" },
        { diffusion_models: ["h3/model.safetensors"],
          text_encoders: ["h3/te.safetensors"],
          vae: ["h3/video_vae.safetensors", "h3/audio_vae.safetensors"] });
    const selects = [...section.el.querySelectorAll("select")];
    assert.equal(selects.length, 4, "应有 4 个模型下拉");
    assert.equal(selects[0].value, "h3/model.safetensors");
    assert.equal(selects[1].value, "h3/te.safetensors");
    assert.equal(selects[2].value, "h3/video_vae.safetensors");
    assert.equal(selects[3].value, "h3/audio_vae.safetensors");
    // 「自动」项标注客户端建议名（videoSuggestion 挑首个含 h3/minimax，shortModelName 取末段去扩展名）
    assert.equal(selects[0].options[0].textContent, "自动（model）");
    assert.deepEqual(section.collect(), { model: "h3/model.safetensors", text_encoder: "h3/te.safetensors",
        vae: "h3/video_vae.safetensors", audio_vae: "h3/audio_vae.safetensors", loras: [] });
});

test("createVideoModelConfigSection：视频 LoRA 行 load/collect 往返，且无「依赖参考图」复选框", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load(
        { model: "h3/model.safetensors", loras: [
            { name: "h3/style_a.safetensors", strength: 0.8 },
            { name: "h3/style_b.safetensors", strength: -0.5 },
        ] },
        { diffusion_models: ["h3/model.safetensors"], loras: [
            "h3/style_a.safetensors", "h3/style_b.safetensors" ] });
    const rows = section.el.querySelectorAll(".rs-gen-lora-row");
    assert.equal(rows.length, 2, "应有 2 个 LoRA 行");
    // 视频区没有「依赖参考图」复选框（与生图区不同）
    assert.equal(section.el.querySelector(".rs-gen-lora-refonly"), null, "视频 LoRA 不应有 ref_only 复选框");
    const strengthInputs = [...section.el.querySelectorAll(".rs-gen-lora-strength")];
    assert.equal(parseFloat(strengthInputs[0].value), 0.8);
    assert.equal(parseFloat(strengthInputs[1].value), -0.5);
    const collected = section.collect();
    assert.deepEqual(collected.loras, [
        { name: "h3/style_a.safetensors", strength: 0.8 },
        { name: "h3/style_b.safetensors", strength: -0.5 },
    ]);
});

test("createVideoModelConfigSection：新增 LoRA 行后 collect 收集（空名跳过）", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load({}, { loras: ["h3/style_a.safetensors"] });
    assert.equal(section.el.querySelectorAll(".rs-gen-lora-row").length, 0, "空设置无 LoRA 行");
    section.el.querySelector(".rs-gen-lora-add").click();   // 空名行，collect 应跳过
    section.el.querySelector(".rs-gen-lora-add").click();
    const rows = section.el.querySelectorAll(".rs-gen-lora-row");
    rows[1].querySelector("select").value = "h3/style_a.safetensors";
    rows[1].querySelector(".rs-gen-lora-strength").value = "0.6";
    assert.deepEqual(section.collect().loras, [{ name: "h3/style_a.safetensors", strength: 0.6 }]);
});
