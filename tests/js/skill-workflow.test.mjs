// 出图技能工作流导出与每技能设置 UI：
// 技能下拉「📋 From Canvas」把画布 API prompt 导出为出图技能（空画布不发请求）；
// 详情弹窗对 gen_image 技能显示 config.json 覆盖区（自定义可编辑保存 / 预设只读 / 非出图技能隐藏）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, dialogs, flush, sleep } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// combo 列表（含底部工具栏）挂在 document.body 上，按钮从 body 里找
function canvasBtn() {
    return Array.from(document.querySelectorAll(".rs-skill-footer-btn"))
        .find((b) => b.textContent === "📋 From Canvas");
}

test("From Canvas：导出画布 API prompt 为出图技能", async () => {
    const { createSkillDropdown } = await import("../../web/skill.js");
    appState.promptGraph = { output: { "10": { class_type: "KSampler", inputs: {} } }, workflow: null };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let body = null;
    mockRoute("/neo_image_gen/save_workflow_skill", (b) => {
        body = b;
        return jsonResponse({ success: true, id: "my-skill", warnings: [] });
    });

    const { combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    dialogs.promptAnswer = "My Skill"; // 三次 prompt（名称/描述/标签）共用同一回答
    canvasBtn().click();
    await sleep(60);

    assert.ok(body, "应发出 /neo_image_gen/save_workflow_skill");
    assert.equal(body.name, "My Skill");
    assert.deepEqual(body.workflow, { "10": { class_type: "KSampler", inputs: {} } });
    assert.deepEqual(body.tags, ["My Skill"]);
});

test("From Canvas：画布无有效工作流时不发请求并提示", async () => {
    const { createSkillDropdown } = await import("../../web/skill.js");
    appState.promptGraph = null; // mock 回落 { output: {}, workflow: null }
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let called = false;
    mockRoute("/neo_image_gen/save_workflow_skill", (b) => {
        called = true;
        return jsonResponse({ success: true, id: "x" });
    });

    const { combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    canvasBtn().click();
    await sleep(60);

    assert.equal(called, false, "output 为空不应发请求");
    assert.ok(dialogs.alerts.some((m) => m.includes("Cannot export")), "应提示无法导出");
});

// 详情弹窗出图设置区：mock 一条 load_skill + skill_config（GET/POST 分流）+ models
async function openGenPopup({ id, source, genImage = true, config = {}, category = "" }) {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: genImage, requires_ref: false, multi_turn: false, tags: [], category,
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    let saved = null;
    mockRoute("/neo_image_gen/skill_config", (b, call) => {
        if (call.method === "GET") return jsonResponse(config);
        saved = b;
        return jsonResponse({ success: true });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: ["q.safetensors"],
    }));

    const popup = createSkillDetailPopup();
    await popup.openExisting(id, source);
    return { wrap: document.querySelector(".rs-skill-gen-settings"), get saved() { return saved; } };
}

test("详情弹窗：gen_image 技能显示设置区，回填 config 并可保存覆盖", async () => {
    const r = await openGenPopup({
        id: "image_gen_text", source: "custom",
        config: { default_ratio: "9:16", loras: [{ name: "q.safetensors", strength: 0.8 }] },
    });
    const wrap = r.wrap;

    assert.ok(wrap, "应渲染出图设置区");
    assert.notEqual(wrap.style.display, "none", "gen_image 技能应显示设置区");
    // config 回填：默认比例 + LoRA 行强度（尺寸区两个原生 select：长边 / 默认比例）
    const sizeSelects = wrap.querySelectorAll(".rs-gen-size-section select");
    assert.equal(sizeSelects.length, 2);
    assert.equal(sizeSelects[1].value, "9:16");
    const loraStrength = wrap.querySelector(".rs-gen-lora-strength");
    assert.ok(loraStrength, "应回填 LoRA 行");
    assert.equal(parseFloat(loraStrength.value), 0.8);
    assert.equal(loraStrength.disabled, false, "自定义技能 LoRA 行可编辑");
    assert.equal(wrap.querySelector(".rs-gen-readonly-hint").style.display, "none", "自定义技能不显示只读提示");

    // 修改张数后点底部 Save → 先写正文（/rs_prompts/save_skill）再 POST skill_config（{ skill_id, config }）
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    const countInput = wrap.querySelector(".rs-gen-advanced input[type=number]");
    countInput.value = "3";
    document.querySelector(".rs-tpl-save-btn").click();
    await sleep(80);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill（正文）");
    assert.ok(r.saved, "应发出 /neo_image_gen/skill_config POST");
    assert.equal(r.saved.skill_id, "image_gen_text");
    assert.equal(r.saved.config.count, 3);
    assert.equal(r.saved.config.default_ratio, "9:16");
});

test("详情弹窗：预设 gen_image 技能设置区只读（控件禁用、无独立保存按钮）", async () => {
    const { wrap } = await openGenPopup({
        id: "image_gen", source: "presets",
        config: { loras: [{ name: "q.safetensors", strength: 0.5 }] },
    });

    assert.ok(wrap);
    assert.notEqual(wrap.style.display, "none");
    const controls = wrap.querySelectorAll("select, input");
    assert.ok(controls.length > 0, "应有可展示的控件");
    for (const el of controls) assert.equal(el.disabled, true, "预设技能控件应禁用");
    assert.equal(wrap.querySelector(".rs-gen-save"), null, "设置区不应有独立保存按钮（统一走底部 Save）");
    const footerSave = document.querySelector(".rs-tpl-save-btn");
    assert.ok(footerSave && footerSave.style.display === "none", "预设技能底部 Save 应隐藏");
    // load 动态新建的 LoRA 行在只读模式下同样禁用
    const loraStrength = wrap.querySelector(".rs-gen-lora-strength");
    assert.ok(loraStrength, "预设 config 的 LoRA 行应回填");
    assert.equal(loraStrength.disabled, true);
    assert.notEqual(wrap.querySelector(".rs-gen-readonly-hint").style.display, "none", "只读提示应显示");
});

test("详情弹窗：非 gen_image 技能不显示设置区", async () => {
    const { wrap } = await openGenPopup({ id: "some_style", source: "custom", genImage: false });

    assert.ok(wrap);
    assert.equal(wrap.style.display, "none");
});

test("复制为自定义：出图技能保留 category/gen_image/requires_ref", async () => {
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    await openGenPopup({ id: "image_gen", source: "presets", category: "image_gen" });

    const copyBtn = Array.from(document.querySelectorAll(".rs-skill-detail-actions button"))
        .find((b) => b.textContent.includes("Copy as custom"));
    assert.ok(copyBtn, "预设技能应显示复制按钮");
    copyBtn.click();
    await sleep(60);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill 请求");
    assert.equal(savedSkill.source, "custom");
    assert.equal(savedSkill.category, "image_gen", "复制后应保留出图分类");
    assert.equal(savedSkill.gen_image, true, "复制后 gen_image 应保留");
    assert.equal(savedSkill.requires_ref, false);
});

test("复制为自定义：name 与已有 skill 冲突时递增序号", async () => {
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    // 已有两个同名副本 → 第三次复制应得 "Gen Skill (Copy) 3"
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "a", name: "Gen Skill (Copy)" },
        { id: "b", name: "Gen Skill (Copy) 2" },
    ]));
    await openGenPopup({ id: "image_gen", source: "presets", category: "image_gen" });

    const copyBtn = Array.from(document.querySelectorAll(".rs-skill-detail-actions button"))
        .find((b) => b.textContent.includes("Copy as custom"));
    assert.ok(copyBtn, "预设技能应显示复制按钮");
    copyBtn.click();
    await sleep(60);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill");
    assert.equal(savedSkill.name, "Gen Skill (Copy) 3", "冲突时 name 递增序号");
});
