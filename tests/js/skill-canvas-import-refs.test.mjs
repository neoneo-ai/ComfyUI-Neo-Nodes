// 画布导入的参考槽与画布尺寸：ImageScale 的 number widget 不能收到 "{{CANVAS_*}}" 串（NaN），
// 参考槽位只留模板声明的演示槽（容量在 config.json 的 max_refs，运行时才扩展）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const QWEN_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "{{TEXT_ENCODER}}" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "{{VAE}}" } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: {
        clip: ["2", 0], prompt: "{{PROMPT}}", negative_prompt: "{{NEGATIVE}}", vae: ["3", 0],
        "images.image_1": ["30", 0], "images.image_2": ["12", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", batch_size: "{{COUNT}}" } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed: "{{SEED}}", steps: "{{STEPS}}",
        positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "{{PREFIX}}" } },
    "10": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_1}}" } },
    "12": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_2}}" } },
    "30": { class_type: "ImageScale", inputs: { image: ["10", 0], upscale_method: "lanczos",
        width: "{{CANVAS_WIDTH}}", height: "{{CANVAS_HEIGHT}}", crop: "disabled" } },
};

const CONFIG = { model: "m.safetensors", default_ratio: "16:9", base_resolution: 1024, steps: 25, max_refs: 10 };

beforeEach(() => {
    resetEnv();
    clearRoutes();
    appState.promptGraph = null;
});

async function openPopup() {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "qwen_image_21", name: "Qwen Image 2.1", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "qwen_image_21", workflow: QWEN_TEMPLATE }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(CONFIG) : jsonResponse({ success: true }));
    mockObjectInfo({ LoadImage: { input: { required: { image: [["example.png", "other.png"], { image_upload: true }] } } } });
    const popup = createSkillDetailPopup();
    await popup.openExisting("qwen_image_21", "preset");
    await sleep(80);
    return popup;
}

function importBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-import-btn");
    return all.length ? all[all.length - 1] : null;
}

async function importToCanvas() {
    const loadedAt = appState.loaded.length;
    click(importBtn());
    await sleep(80);
    const api = appState.loaded.slice(loadedAt).filter((l) => l.kind === "api");
    assert.equal(api.length, 1, "应调 app.loadApiJson 一次");
    return api[0].data;
}

test("导入到画布：ImageScale 的画布宽高灌成数字（不残留 {{CANVAS_*}} 串 → 无 NaN）", async () => {
    await openPopup();
    const wf = await importToCanvas();
    const scale = wf["30"].inputs;
    assert.strictEqual(wf["5"].inputs.width, 1040, "长边 1024 按 16 对齐（与后端 _round_multiple 同口径）");
    assert.strictEqual(wf["5"].inputs.height, 592, "16:9 短边 576 按 16 对齐");
    assert.strictEqual(scale.width, 1056, "画布尺寸按 32 对齐（后端 _edit_canvas_size 口径）");
    assert.strictEqual(scale.height, 608);
    assert.ok(Number.isFinite(scale.width) && Number.isFinite(scale.height), "number widget 必须是有限数字");
});

test("导入到画布：参考槽位只留模板声明的槽（占串替换为默认图片避免红框）", async () => {
    await openPopup();
    const wf = await importToCanvas();
    const loads = Object.values(wf).filter((n) => n.class_type === "LoadImage");
    assert.equal(loads.length, 2, "画布只显示模板的 2 个演示槽");
    assert.deepEqual(loads.map((n) => n.inputs.image), ["example.png", "other.png"],
        "槽位 N 取 combo[N-1]，两槽不共用同一张图");
    assert.ok(!Object.keys(wf["4"].inputs).some((k) => /^images\.image_[3-9]$/.test(k)),
        "导入不预造空槽位连线");
});
