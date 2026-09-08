// 出图设置表单：四视图 LoRA（文件名含 quadview/四视图）「依赖参考图」默认勾选；
// 普通 LoRA 不默认勾选；已显式保存的 ref_only 值被尊重；选中四视图 LoRA 时自动勾选。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse } from "./setup.mjs";

const QV = "krea2/Edit/Krea2-QuadView_krea2_v1.safetensors";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// 构造表单并 load，返回所有 LoRA 行的「依赖参考图」复选框
async function formLoras(settingsLoras, modelLoras) {
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_image_gen/settings", () => jsonResponse({
        model: "", count: 1, base_resolution: 1280, default_ratio: "1:1", loras: settingsLoras,
    }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: [], text_encoders: [], vae: [], loras: modelLoras,
    }));
    const { el, load } = createImageGenSettingsForm();
    document.body.appendChild(el);
    await load();
    return { el, chks: [...el.querySelectorAll(".rs-gen-lora-refonly")] };
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
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ loras: [{ name: QV, strength: 1.0 }] }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: [], text_encoders: [], vae: [],
        loras: [QV, "style_a.safetensors"], suggested_lora: QV,
    }));
    const { el, load } = createImageGenSettingsForm();
    document.body.appendChild(el);
    await load();
    const row = el.querySelector(".rs-gen-lora-row");
    assert.ok(row, "应有 LoRA 行");
    const select = row.querySelector("select");
    assert.ok(select, "应有 LoRA 下拉");
    // suggested_lora 经 shortModelName（取末段去扩展名）后作为「自动」项文案
    assert.equal(select.options[0].textContent, "自动（Krea2-QuadView_krea2_v1）", "首项应为带建议名的「自动」");
});