// 设置面板初始化回归：异步回填（含模型列表晚到、下拉默认落首项）不得触发
// 自动保存/本地模型切换，也不得把表单判为未保存修改；load 全部落定后才放行脏检查。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    resetEnv,
    mockRoute,
    clearRoutes,
    jsonResponse,
    fetchLog,
    flush,
    sleep,
} from "./setup.mjs";

let llmForm = null;

const localConfig = () => ({
    enabled: false,
    active_provider: "local",
    auto_unload_local: false,
    providers: {
        local: { models_dir: "D:/gguf" },
        openai: { api_key: "", base_url: "", model: "gpt-4o-mini" },
        lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" },
        ollama: { api_key: "", base_url: "http://localhost:11430/v1", model: "" },
        openrouter: { api_key: "", base_url: "https://openrouter.ai/api/v1", model: "" },
    },
});

// 已保存模型 current_model 故意不在新列表里 → 列表加载后原生 select 会落在首项
const MODELS = {
    current_model: "old-model.gguf",
    models: [
        { key: "a.gguf", name: "a.gguf", file_size: 1024 },
        { key: "b.gguf", name: "b.gguf", file_size: 2048 },
    ],
};

const saveLlmCalls = () =>
    fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/remote_llm_config");
const setModelCalls = () =>
    fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/set_model");
const localSelect = () => document.querySelector("#rs-local-model-select");

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(localConfig()));
    mockRoute("/rs_prompts/get_models", () => jsonResponse(MODELS));
    mockRoute("/rs_prompts/set_model", () => jsonResponse({ success: true, current_model: "a.gguf" }));
    const { createModelConfigForm } = await import("../../web/llm-setting.js");
    llmForm = createModelConfigForm();
    document.body.appendChild(llmForm.el);
});

test("LLM 初始化：模型列表晚到时（load 未完成）的 change 不落盘、不切模型；load 等列表填完才结束", async () => {
    // 模型列表延迟返回，模拟慢磁盘扫描
    let releaseModels = null;
    mockRoute("/rs_prompts/get_models", () => new Promise((resolve) => {
        releaseModels = () => resolve(jsonResponse(MODELS));
    }));

    const loading = llmForm.load(); // 不 await：模拟菜单打开即后台回填
    let settled = false;
    loading.then(() => { settled = true; });
    await flush(60); // 推进到“等待 get_models”挂起点

    assert.equal(settled, false, "load 应等模型列表填充完成，而非配置读完就结束");

    // 列表未回、下拉仍停在加载项时派发 change（模拟程序化/环境副作用）
    localSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    assert.equal(llmForm.isDirty(), false, "加载窗口内不算 dirty");
    assert.equal(setModelCalls().length, 0, "加载窗口内不得切换到本地模型");

    releaseModels();
    await loading;
    await sleep(400); // 若守卫失效会留下 300ms 防抖自动保存，这里等它现形
    await flush();

    const keys = [...localSelect().options].map((o) => o.value).filter((v) => v && v !== "__loading__");
    assert.deepEqual(keys, ["a.gguf", "b.gguf"], "load resolve 时模型列表已填充（含首项回落）");
    assert.equal(llmForm.isDirty(), false, "初始化完成后仍不算 dirty");
    assert.equal(setModelCalls().length, 0, "整个初始化期间不切换本地模型");
    assert.equal(saveLlmCalls().length, 0, "整个初始化期间不触发自动保存写请求");
});

test("LLM 初始化完成后的真实用户改动仍触发自动保存与脏标记", async () => {
    await llmForm.load();
    await flush();
    assert.equal(llmForm.isDirty(), false, "无改动不算 dirty");

    localSelect().value = "b.gguf";
    localSelect().dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(llmForm.isDirty(), true, "真实改动在防抖保存落盘前即 dirty");
    await sleep(400); // 等 300ms 防抖保存
    await flush();

    assert.equal(setModelCalls().length, 1, "用户选择应切换本地模型");
    assert.equal(setModelCalls()[0].body.model_key, "b.gguf");
    const saves = saveLlmCalls();
    assert.equal(saves.length, 1, "用户改动应触发一次自动保存");
    assert.equal(saves[0].body.provider, "local");
    assert.equal(saves[0].body.model, "b.gguf");
    assert.equal(llmForm.isDirty(), false, "保存成功后不再 dirty");
});

test("出图设置：load 落定前 dirty 恒 false，load 后仅改动触发 dirty", async () => {
    let releaseSettings = null;
    mockRoute("/neo_image_gen/settings", (body, call) => {
        if (call.method === "POST") return jsonResponse({ success: true });
        return new Promise((resolve) => {
            releaseSettings = () => resolve(jsonResponse({
                model: "saved-m", text_encoder: "", vae: "", loras: [],
                count: 1, base_resolution: 1280, default_ratio: "1:1",
            }));
        });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["m1", "m2"], text_encoders: [], vae: [], loras: [],
    }));

    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    const genForm = createImageGenSettingsForm();
    document.body.appendChild(genForm.el);

    const p = genForm.load();
    await flush(60);
    assert.equal(genForm.isDirty(), false, "加载窗口内不算 dirty");
    releaseSettings();
    await p;
    await flush();
    assert.equal(genForm.isDirty(), false, "load 完成、无改动不算 dirty");

    // 已保存值不在模型列表 → load 回落为「自动」；显式改选后应 dirty
    const modelSelect = genForm.el.querySelector("select"); // 表单第一个 select = 出图模型
    modelSelect.value = "m1";
    assert.equal(genForm.isDirty(), true, "改动模型值应 dirty");

    await genForm.save();
    assert.equal(genForm.isDirty(), false, "保存成功后不 dirty");
    const saved = fetchLog.filter((c) => c.method === "POST" && c.path === "/neo_image_gen/settings");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.model, "m1");
});
