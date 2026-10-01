// 画廊搜索行「🖼️ 生成素材」：纯提示词一键生成新素材，默认 Krea2 文生图（image_gen），
// 成功后可打开 Output 下实际落盘的日期子目录。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, fetchLog, sleep, click, inputText, changeValue } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

test("生成素材弹窗：默认 Krea2 文生图，成功后可打开输出目录", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    const dirCalls = [];
    const gallery = { showDirectoryStructure: (source, segs) => dirCalls.push([source, segs]) };

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, requires_ref: true },
    ]));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: "gm1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/gm1", () => jsonResponse({
        task_id: "gm1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00001_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog(gallery);
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    assert.ok(overlay, "应弹出生成素材弹窗");

    await sleep(50);
    // 技能下拉只列纯文生图技能（无参考图要求），默认 Krea2 文生图
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.ok(skillSel, "应有技能下拉");
    assert.equal([...skillSel.options].map(o => o.value).join(","), "image_gen", "只列纯文生图技能");
    assert.equal(skillSel.value, "image_gen", "默认选中 Krea2 文生图");

    // idle：有「生成」按钮，且尚未发请求
    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map(b => b.textContent);
    assert.ok(btns().includes("生成"), "idle 应有「生成」按钮");
    assert.equal(fetchLog.filter(c => c.path === "/neo_image_gen/generate").length, 0);

    inputText(overlay.querySelector(".neo-gallery-story-input"), "红色陶瓷杯的白底产品图");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);

    // 请求体：skill_id=image_gen、skip_enhance=true，不带参考图
    const genReq = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(genReq?.body.skill_id, "image_gen");
    assert.equal(genReq?.body.skip_enhance, true);
    assert.ok(!genReq?.body.references, "纯文生图不应带参考图");

    // 成功：结果预览 + 「打开输出目录 / 再生成 / 关闭」
    const resultImg = overlay.querySelector(".neo-gallery-cs-result-img");
    assert.match(resultImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=krea2_00001_\.png/);
    assert.ok(btns().includes("打开输出目录"), "成功后应有「打开输出目录」按钮");
    assert.ok(btns().includes("再生成"), "成功后应保留「再生成」按钮");

    // 点「打开输出目录」→ 跳到 Output/NeoAgent/<日期>
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "打开输出目录"));
    assert.deepEqual(dirCalls, [["Output", ["NeoAgent", "2026-10-01"]]]);
    assert.equal(genCount, 1);
});

test("生成素材弹窗：生成中显示预览区与进度条，成功后结果图原位替换", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm2", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm2", () => jsonResponse({
        task_id: "gm2", status: "running", progress: { value: 3, max: 10 }, images: [],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    inputText(overlay.querySelector(".neo-gallery-story-input"), "海边灯塔");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(50);

    // 生成中：预览区（spinner + 进度条 30%）
    const preview = overlay.querySelector(".neo-gallery-gm-preview");
    assert.ok(preview, "生成中应有预览区");
    assert.equal(preview.querySelector(".neo-gallery-cs-progress-fill")?.style.width, "30%", "进度条按 progress.value/max 填充");

    // 实时预览推送：预览图替换 spinner（与节点预览同源）
    const previewUrl = "data:image/jpeg;base64,QUJDREVG";
    dispatchApiEvent("rs.image_gen.status", {
        task_id: "gm2", status: "running", progress: { value: 5, max: 10 }, preview: previewUrl,
    });
    await sleep(20);
    const liveImg = overlay.querySelector(".neo-gallery-gm-preview-img");
    assert.ok(liveImg, "生成中拿到实时预览图应在预览区显示");
    assert.equal(liveImg.getAttribute("src"), previewUrl);
    assert.equal(preview.querySelector(".neo-gallery-cs-progress-fill")?.style.width, "50%");

    // 派发终态：结果图原位替换预览区（同一容器变为 .neo-gallery-cs-result）
    dispatchApiEvent("rs.image_gen.status", {
        task_id: "gm2", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00002_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    });
    await sleep(20);
    const resultBox = overlay.querySelector(".neo-gallery-cs-result");
    assert.ok(resultBox, "成功后预览区应原位替换为结果区");
    assert.match(resultBox.querySelector("img")?.getAttribute("src") || "", /krea2_00002_\.png/, "结果图显示在预览区原位置");
});

test("生成素材弹窗：提示词为空时不发请求", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));

    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(50);
    assert.equal(fetchLog.filter(c => c.path === "/neo_image_gen/generate").length, 0, "空提示词不应发请求");
});

test("生成素材弹窗：模型覆盖——自动不带覆盖，选主模型+LoRA 后请求体带上", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: ["style_a.safetensors", "Krea2-QuadView.safetensors"],
        suggested_diffusion_models: "krea2.safetensors",
        suggested_lora: "Krea2-QuadView.safetensors",
    }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm3", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm3", () => jsonResponse({
        task_id: "gm3", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00003_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充

    // 默认折叠；展开后显示模型覆盖区（主模型下拉预填「自动」= 跟随设置）
    const toggle = overlay.querySelector(".neo-gallery-gm-model-toggle");
    assert.ok(toggle, "应有「模型覆盖」折叠行");
    click(toggle);
    const modelBox = overlay.querySelector(".neo-gallery-gm-model-box");
    assert.notEqual(modelBox.style.display, "none", "点击后应展开");
    const modelSel = overlay.querySelector(".rs-gen-model-section select");
    assert.ok(modelSel, "展开后应有主模型下拉");
    assert.equal(overlay.querySelectorAll(".rs-gen-model-section .rs-gen-adv-row").length, 0, "覆盖区只露出生图模型与 LoRA（无 TE / VAE 行）");
    assert.equal(modelSel.value, "", "默认「自动」（跟随设置），不预填");
    assert.equal(overlay.querySelectorAll(".rs-gen-lora-row").length, 0, "默认无 LoRA 行");

    // 自动态：请求体不带 model / loras 覆盖（不冲掉全局设置）
    inputText(overlay.querySelector(".neo-gallery-story-input"), "海边灯塔");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);
    let req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.ok(!("model" in (req.body || {})), "自动态请求体不应带 model 覆盖");
    assert.ok(!("loras" in (req.body || {})), "自动态请求体不应带 loras 覆盖");

    // 选主模型 + 加一条 LoRA（强度 0.8）→「再生成」请求体带上覆盖
    modelSel.value = "qwen_image_2.1.safetensors";
    click(overlay.querySelector(".rs-gen-lora-add"));
    const loraRow = overlay.querySelector(".rs-gen-lora-row");
    assert.ok(loraRow, "应有 LoRA 行");
    loraRow.querySelector("select").value = "style_a.safetensors";
    loraRow.querySelector(".rs-gen-lora-strength").value = "0.8";
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "再生成"));
    await sleep(80);
    req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(req.body.model, "qwen_image_2.1.safetensors", "请求体应带所选主模型");
    assert.deepEqual(req.body.loras, [{ name: "style_a.safetensors", strength: 0.8, ref_only: false }], "请求体应带所选 LoRA 与强度");

    // 关窗重开：覆盖清除，回到「自动」且无 LoRA 行
    click(overlay.querySelector(".neo-gallery-story-close"));
    assert.equal(document.querySelector(".neo-gallery-gm-modal-overlay"), null, "关闭后弹窗应移除");
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay2 = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充
    click(overlay2.querySelector(".neo-gallery-gm-model-toggle"));
    assert.equal(overlay2.querySelector(".rs-gen-model-section select").value, "", "重开后主模型回到「自动」");
    assert.equal(overlay2.querySelectorAll(".rs-gen-lora-row").length, 0, "重开后无 LoRA 行");
});

test("生成素材弹窗：成功后可删除结果图并回到 idle", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    const deletedCalls = [];
    const gallery = {
        showDirectoryStructure: () => {},
        deleteItem: async (name, sub) => { deletedCalls.push([name, sub]); return true; },
    };

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm5", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm5", () => jsonResponse({
        task_id: "gm5", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00009_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog(gallery);
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    inputText(overlay.querySelector(".neo-gallery-story-input"), "红色陶瓷杯的白底产品图");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);

    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map(b => b.textContent);
    assert.ok(btns().includes("删除"), "成功后应有「删除」按钮");

    // 点「删除」→ 按落盘 filename/subfolder 调 deleteItem，删完回 idle（结果图清除、可再生成）
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "删除"));
    await sleep(30);
    assert.deepEqual(deletedCalls, [["krea2_00009_.png", "NeoAgent/2026-10-01"]], "deleteItem 应带落盘文件名与子目录");
    assert.ok(btns().includes("生成"), "删除后应回到 idle，可继续生成");
    assert.equal(overlay.querySelector(".neo-gallery-cs-result-img"), null, "删除后结果图应清除");
});

test("生成素材弹窗：记住上次选中的技能（关窗不清除）", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "flux_t2i", cn_name: "Flux 文生图", category: "image_gen", gen_image: true },
    ]));

    // 首次打开：无记忆 → 默认 Krea2 文生图
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    let overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.equal(skillSel.value, "image_gen", "无记忆时默认 Krea2 文生图");

    // 切到 Flux 并关窗 → 重开：记住 Flux
    changeValue(skillSel, "flux_t2i");
    overlay.remove();
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    assert.equal(overlay.querySelector(".neo-recipes-sort").value, "flux_t2i", "重开后应记住上次选中的技能");

    // 记住的技能已不在列表 → 回 Krea2 默认
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    overlay.remove();
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    assert.equal(overlay.querySelector(".neo-recipes-sort").value, "image_gen", "记住的技能失效时回 Krea2 文生图");
    localStorage.clear();
});

test("生成素材弹窗：选中的主模型+LoRA 组合可保存为新技能", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_style_a", cn_name: "qwen_image_2.1-style_a", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: ["style_a.safetensors"],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充

    click(overlay.querySelector(".neo-gallery-gm-model-toggle"));
    const saveBtn = overlay.querySelector(".neo-gallery-gm-save-skill");
    assert.ok(saveBtn, "应有「保存为新技能」按钮");
    assert.equal(saveBtn.style.display, "none", "未选主模型 / LoRA 时保存按钮应隐藏");

    // 选主模型 + LoRA → 保存按钮出现
    const modelSel = overlay.querySelector(".rs-gen-model-section select");
    changeValue(modelSel, "qwen_image_2.1.safetensors");
    click(overlay.querySelector(".rs-gen-lora-add"));
    const loraRow = overlay.querySelector(".rs-gen-lora-row");
    changeValue(loraRow.querySelector("select"), "style_a.safetensors");
    loraRow.querySelector(".rs-gen-lora-strength").value = "0.8";
    assert.notEqual(saveBtn.style.display, "none", "选中主模型 + LoRA 后保存按钮应出现");

    // 点保存 → 请求体带当前技能 + 主模型 + LoRA；成功后下拉选中新技能并记住
    mockRoute("/neo_image_gen/save_combo_skill", () => jsonResponse({
        success: true, id: "qwen_image_21_style_a", name: "qwen_image_2.1-style_a",
    }));
    click(saveBtn);
    await sleep(50);
    const saveReq = fetchLog.filter(c => c.path === "/neo_image_gen/save_combo_skill").at(-1);
    assert.equal(saveReq?.body.skill_id, "image_gen", "请求体应带当前技能");
    assert.equal(saveReq?.body.model, "qwen_image_2.1.safetensors");
    assert.deepEqual(saveReq?.body.loras, [{ name: "style_a.safetensors", strength: 0.8, ref_only: false }]);

    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.ok([...skillSel.options].some(o => o.value === "qwen_image_21_style_a"), "新技能应出现在下拉里");
    assert.equal(skillSel.value, "qwen_image_21_style_a", "保存后下拉应选中新技能");
    assert.equal(localStorage.getItem("neo.gallery.gen_material.skill"), "qwen_image_21_style_a", "新技能应被记住");

    // 失败：后端 400 → 错误 toast，下拉选择不变
    mockRoute("/neo_image_gen/save_combo_skill", () => jsonResponse({ error: "请先选择主模型或 LoRA" }, 400));
    click(saveBtn);
    await sleep(50);
    const toasts = [...document.querySelectorAll(".neo-at")].map(t => t.textContent).join("|");
    assert.match(toasts, /保存为新技能失败/, "失败应弹错误 toast");
    assert.equal(skillSel.value, "qwen_image_21_style_a", "失败时下拉选择不变");
});

test("生成素材弹窗：✨ 增强仿 agent quick input + output，支持选择增强 skill", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "smart_prompt", cn_name: "智能提示词", category: "task" },
        { id: "general_enhance", cn_name: "通用增强", category: "image_enhance" },
    ]));
    let enhanceBody = null;
    let releaseContent;
    const contentGate = new Promise((r) => { releaseContent = r; });
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        enhanceBody = b;
        // 自定义 reader：thinking / status 帧送达后暂停正文，便于断言流中面板状态
        const enc = new TextEncoder();
        const lines = [
            'data: {"text":"分析主体……","kind":"thinking"}\n',
            'data: {"text":"⏳ 生成中（按需读引用文件）…","kind":"status"}\n',
            'data: {"text":"红色陶瓷杯，","kind":"content"}\n',
            'data: {"text":"白底产品图，柔和布光。","kind":"content"}\n',
            "data: [DONE]\n",
        ];
        let i = 0;
        return {
            ok: true,
            status: 200,
            async json() { throw new Error("sse"); },
            async text() { return lines.join(""); },
            body: {
                getReader: () => ({
                    async read() {
                        if (i >= lines.length) return { done: true, value: undefined };
                        if (i === 2) await contentGate;
                        return { done: false, value: enc.encode(lines[i++]) };
                    },
                    releaseLock() {},
                })
            }
        };
    });

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等技能下拉填充

    // agent 式双框（chat 习惯）：output 在上 + quick input 在下；增强 skill 下拉只列图像增强类，顶部「默认」空选项
    const quickInput = overlay.querySelector(".neo-gallery-gm-quick-input");
    const outputInput = overlay.querySelector(".neo-gallery-story-input");
    const enhanceSel = overlay.querySelector(".neo-gallery-gm-enhance-skill");
    assert.ok(quickInput && outputInput, "应有 quick input 与 output 双框");
    const modalChildren = [...overlay.querySelector(".neo-gallery-story-modal").children];
    assert.ok(modalChildren.indexOf(outputInput) < modalChildren.indexOf(quickInput), "output 应在 quick input 上方（chat 习惯）");
    assert.equal([...enhanceSel.options].map(o => o.value).join(","), ",general_enhance", "增强下拉只列图像增强技能（顶部默认空选项，task / 生图类排除）");

    const enhanceBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "✨ 增强");
    assert.ok(enhanceBtn, "应有「✨ 增强」按钮");

    // 双框皆空：不发请求
    click(enhanceBtn);
    await sleep(20);
    assert.equal(fetchLog.filter(c => c.path === "/rs_prompts/stream_generate_prompt").length, 0, "双框皆空不应发请求");

    // quick input 有内容：请求体带 text + skillId（默认 = 空值，后端 smart_prompt 自动路由）
    inputText(quickInput, "红色陶瓷杯");
    click(enhanceBtn);
    await sleep(40); // thinking / status 帧送达且 rAF 已刷
    assert.ok(enhanceBody, "应调用 /rs_prompts/stream_generate_prompt");
    assert.equal(enhanceBody.text, "红色陶瓷杯");
    assert.equal(enhanceBody.skillId, "", "默认增强 skill 发空值（后端自动路由）");

    // 流中：思考面板 + 流程状态行显示在 output 上方（与节点输出框共用）
    const panels = [...overlay.querySelectorAll(".rs-thinking")];
    assert.equal(panels.length, 2, "流中应有思考面板与状态行两个面板");
    assert.match(panels[0].querySelector(".rs-thinking-body").textContent, /分析主体/, "思考面板应显示 reasoning_content");
    assert.match(panels[1].querySelector(".rs-thinking-body").textContent, /生成中/, "状态行应显示流程阶段");

    // 正文出现：思考面板清除、状态行保留到流结束，正文完整写入 output，quick input 被消费清空
    releaseContent();
    await sleep(80);
    const remain = [...overlay.querySelectorAll(".rs-thinking")];
    assert.equal(remain.length, 1, "正文出现后只剩状态行");
    assert.ok(!outputInput.value.includes("分析主体"), "thinking 不应写入 output");
    assert.ok(!outputInput.value.includes("生成中"), "status 不应写入 output");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。");
    assert.equal(quickInput.value, "", "增强成功后 quick input 应被消费清空");
    assert.equal(enhanceBtn.textContent, "✨ 增强", "完成后按钮应恢复");

    // 第二轮：output 已有提示词 + quick input 新指令 → 按 \n\n---\n\n 拼接（同节点）；所选增强 skill 随请求发出并被记住
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        enhanceBody = b;
        return sseResponse([
            'data: {"text":"红色陶瓷杯，白底产品图，柔和布光。改为写实风格。","kind":"content"}\n',
            "data: [DONE]\n",
        ]);
    });
    changeValue(enhanceSel, "general_enhance");
    inputText(quickInput, "改成写实风格");
    click(enhanceBtn);
    await sleep(80);
    assert.equal(enhanceBody.text, "红色陶瓷杯，白底产品图，柔和布光。\n\n---\n\n改成写实风格", "quick 新指令应与 output 已有提示词拼接");
    assert.equal(enhanceBody.skillId, "general_enhance", "skillId 取所选增强 skill");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。改为写实风格。");
    assert.equal(quickInput.value, "", "第二轮 quick input 也应被消费");
    assert.equal(localStorage.getItem("neo.gallery.gen_material.enhance_skill"), "general_enhance", "增强 skill 选择应被记住");

    // 失败：错误 toast（带 LLM 设置入口），output 保持原文
    mockRoute("/rs_prompts/stream_generate_prompt", () => jsonResponse({ error: "LLM 未配置" }, 500));
    inputText(quickInput, "再改一次");
    click(enhanceBtn);
    await sleep(80);
    const toasts = [...document.querySelectorAll(".neo-at")].map(t => t.textContent).join("|");
    assert.match(toasts, /提示词增强失败/, "失败应弹错误 toast");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。改为写实风格。", "失败时 output 保持原文");
});