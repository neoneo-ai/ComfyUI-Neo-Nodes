// 居中技能选择窗（替代原生 combo 下拉）：
// - 右侧浮动预览卡是详情唯一入口：点击按 skill **id** 打开（自定义可编辑、预设只读；combo 的 options.values 存的是 name，不能拿它去 load_skill）
// - 所有技能可预览：生成技能 = 配置摘要（未保存字段显示自动默认），其余技能 = skill.md 模板正文摘录
// - 选中条目写回 combo 的合法 value（对齐 options.values，Krea2/H3 skill_id 为 name）并触发 callback
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click, keydown, fire } from "./setup.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// combo 的 options.values 存 name（与 Krea2/H3 skill_id 一致），而详情弹窗按 id 加载
const SKILLS = [
    { id: "skill-id-a", name: "Alpha Skill", source: "custom", category: "task", tags: [] },
    { id: "skill-id-b", name: "Beta Skill", source: "preset", category: "task", tags: [] },
];
const NAMES = ["Alpha Skill", "Beta Skill"];

function makeComboWidget(value) {
    return { name: "skill_id", value, options: { values: NAMES.slice() }, callback: () => {} };
}
function makeNode() {
    return { onWidgetChanged() {}, graph: { change() {} } };
}
function pickerRow(labelText) {
    return Array.from(document.querySelectorAll(".rs-skill-picker-item"))
        .find((r) => r.querySelector(".rs-skill-picker-label")?.textContent === labelText);
}

test("预览卡按 skill id 打开详情（行内查看按钮已移除）", async () => {
    const { attachSkillPickerToComboWidget } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b && b.id;
        return jsonResponse({ id: b.id, name: "Loaded", content: "", files: [], gen_image: false, requires_ref: false, multi_turn: false, tags: [], category: "task" });
    });

    const widget = makeComboWidget("Alpha Skill");
    attachSkillPickerToComboWidget(widget, { title: "选择 Skill（测试）" });
    assert.equal(typeof widget.onPointerDown, "function", "attach 应设置 widget.onPointerDown（新版前端唯一能短路原生下拉的钩子）");
    assert.equal(widget.onPointerDown({ clientX: 100, clientY: 200 }, makeNode(), null), true, "onPointerDown 返回真值以抑制原生下拉");
    await sleep(30);

    const overlay = document.querySelector(".rs-skill-modal-overlay");
    assert.equal(overlay.querySelectorAll(".rs-skill-row-action").length, 0, "行内查看按钮已移除");
    click(document.querySelector(".rs-skill-picker-preview"));
    await sleep(30);

    assert.equal(loadedId, "skill-id-a", "应按 skill id 打开详情，而非 combo 的 name");
});

// agent 技能下拉的浮动预览卡：combo 点外关闭是 document mousedown，卡片 mousedown 必须 stopPropagation，
// 否则列表先关、click 到不了卡片（回归：点预览只关了下拉、没开详情）
test("agent 下拉预览卡：mousedown 不触发点外关闭，点击按 id 打开详情", async () => {
    const { createSkillDropdown, populateSkillOptions } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b && b.id;
        return jsonResponse({ id: b.id, name: "Loaded", content: "", files: [], gen_image: false, requires_ref: false, multi_turn: false, tags: [], category: "task" });
    });

    const { selectEl, combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    populateSkillOptions(selectEl, SKILLS);
    fire(document.querySelector(".rs-combo-input"), "focus"); // 展开列表
    await sleep(20);
    const rows = Array.from(document.querySelectorAll(".rs-combo-list [data-value]"));
    assert.ok(rows.length >= 1, "列表应渲染 skill 行");
    fire(rows[0], "mouseenter"); // 焦点行 → 预览卡出现
    const preview = document.querySelector(".rs-skill-picker-preview--fixed");
    assert.ok(preview && preview.style.display !== "none", "hover 行后预览卡应显示");
    const expectedId = [...selectEl.options].find((o) => o.value === rows[0].dataset.value).__skillMeta.id;

    fire(preview, "mousedown"); // 真实点击序列：先 mousedown（冒泡到 document）
    assert.notEqual(document.querySelector(".rs-combo-list").style.display, "none", "预览卡 mousedown 不应被当作点外点击关掉下拉");
    click(preview);
    await sleep(30);

    assert.equal(loadedId, expectedId, "点击预览卡应按 skill id 打开详情");
});

test("选中条目写回 combo 合法 value（name）并触发 callback", async () => {
    const { attachSkillPickerToComboWidget } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));

    let cbValue = null;
    const widget = makeComboWidget("Alpha Skill");
    widget.callback = (v) => { cbValue = v; };
    attachSkillPickerToComboWidget(widget, { title: "选择 Skill（测试）" });
    document.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: 100, clientY: 200 }));
    widget.onPointerDown({ clientX: 100, clientY: 200 }, makeNode(), null);
    await sleep(30);

    const betaRow = pickerRow("Beta Skill");
    assert.ok(betaRow, "应渲染 Beta Skill 行");
    click(betaRow);
    await sleep(20);

    assert.equal(widget.value, "Beta Skill", "写回 combo 的 value 应为 options.values 里的 name");
    assert.equal(cbValue, "Beta Skill", "callback 应以该 value 触发（Krea2/H3 据此刷新尺寸/规格）");
});

test("同一时刻只允许一个选择窗：重复打开不叠加，关闭后可重开", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const items = [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
    ];

    openSkillPickerModal({ items });
    openSkillPickerModal({ items }); // 连点 / 异步竞态不应叠加
    assert.equal(document.querySelectorAll(".rs-skill-modal-overlay").length, 1, "已有选择窗时重复打开不应叠加出多个 overlay");

    // 无标题栏后的关闭方式：点击遮罩外部（点击面板本体不算）
    const overlayEl = document.querySelector(".rs-skill-modal-overlay");
    overlayEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await sleep(20);
    assert.equal(document.querySelectorAll(".rs-skill-modal-overlay").length, 0, "关闭后 overlay 移除、标志复位");

    openSkillPickerModal({ items });
    assert.equal(document.querySelectorAll(".rs-skill-modal-overlay").length, 1, "关闭后可再次打开");
    document.querySelector(".rs-skill-modal-overlay").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await sleep(20);
});

test("传入 anchor 时弹窗锚定到控件附近（fixed + left/top + anchored 类去遮罩）", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const items = [{ value: "a", label: "Alpha" }];
    const anchorRect = { left: 100, top: 200, right: 300, bottom: 224, width: 200, height: 24 };
    openSkillPickerModal({ items, anchor: anchorRect });

    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const wrap = overlay.querySelector(".rs-skill-picker-wrap");
    assert.ok(overlay.classList.contains("rs-skill-picker--anchored"), "锚定模式应加 anchored 类（去遮罩）");
    assert.equal(wrap.style.position, "fixed", "wrap（列表面板）改为 fixed 定位");
    assert.match(wrap.style.left, /^\d+px$/, "left 应为像素值");
    const top = parseInt(wrap.style.top, 10);
    assert.ok(top >= anchorRect.bottom, "弹窗应出现在锚点下方");
    overlay.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await sleep(20);
});

test("键盘导航：方向键移动高亮、回车确认选中并写回", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const items = [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma" },
    ];
    let picked = null;
    openSkillPickerModal({ items, onPick: (v) => { picked = v; } });
    const overlay = document.querySelector(".rs-skill-modal-overlay");

    keydown(overlay, "ArrowDown");
    const rows = Array.from(document.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(rows[0].classList.contains("is-highlighted"), true, "下移高亮第一项");
    keydown(overlay, "ArrowDown");
    assert.equal(rows[1].classList.contains("is-highlighted"), true, "再下移高亮第二项");

    keydown(overlay, "Enter");
    await sleep(20);
    assert.equal(picked, "b", "回车确认高亮项（Beta）");
    assert.equal(document.querySelectorAll(".rs-skill-modal-overlay").length, 0, "确认后关闭弹窗");
});

// 浮动预览卡：生成技能结构化显示 主模型 / LoRA chips / 长边尺寸 / 默认比例 / 步数（未保存字段显示与详情一致的自动默认值），非生成技能显示 skill.md 模板正文摘录；随行焦点（键盘高亮 + hover）切换
test("gen_config 预览卡：结构化渲染、随焦点切换、非生成技能显示正文摘录", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({ id: b.id, name: "Plain", content: "模板正文：把输入改写为提示词", files: [] }));
    const items = [
        { value: "full", label: "Full Skill", genImage: true, genConfig: { model: "qwen3.safetensors", loras: ["a.safetensors", "b.safetensors", "c.safetensors"], base_resolution: 1024, default_ratio: "9:16", steps: 8 } },
        { value: "partial", label: "Partial Skill", genImage: true, genConfig: { model: "m.safetensors" } },
        { value: "none", label: "Plain Skill" },
    ];
    const res = openSkillPickerModal({ items });
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "有技能带 gen_config 时渲染右侧预览卡");
    assert.match(preview.textContent, /浏览技能/, "无焦点行时显示操作提示");

    keydown(overlay, "ArrowDown"); // 聚焦第一项 Full Skill
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "Full Skill", "预览卡头部为焦点技能名");
    const rowsOf = () => Array.from(preview.querySelectorAll(".rs-skill-preview-row"));
    assert.deepEqual(rowsOf().map((r) => r.querySelector(".rs-skill-preview-key").textContent), ["主模型", "LoRA", "长边尺寸", "默认比例", "步数"], "五字段按序展示");
    assert.equal(rowsOf()[0].querySelector(".rs-skill-preview-val").textContent, "qwen3.safetensors");
    assert.deepEqual(Array.from(preview.querySelectorAll(".rs-skill-preview-chip")).map((c) => c.textContent), ["a.safetensors", "b.safetensors", "c.safetensors"], "LoRA 逐条 chip 展示不折叠");
    assert.equal(rowsOf()[2].querySelector(".rs-skill-preview-val").textContent, "1024px");
    assert.equal(rowsOf()[3].querySelector(".rs-skill-preview-val").textContent, "9:16");
    assert.equal(rowsOf()[4].querySelector(".rs-skill-preview-val").textContent, "8", "已保存步数直接显示");

    keydown(overlay, "ArrowDown"); // Partial Skill：仅保存主模型，长边/比例/步数显示与详情一致的默认值
    assert.deepEqual(rowsOf().map((r) => r.querySelector(".rs-skill-preview-key").textContent), ["主模型", "长边尺寸", "默认比例", "步数"], "未保存字段显示自动默认值");
    assert.equal(rowsOf()[0].querySelector(".rs-skill-preview-val").textContent, "m.safetensors");
    assert.equal(rowsOf()[1].querySelector(".rs-skill-preview-val").textContent, "默认 (1280)");
    assert.equal(rowsOf()[2].querySelector(".rs-skill-preview-val").textContent, "默认 (1:1)");
    assert.equal(rowsOf()[3].querySelector(".rs-skill-preview-val").textContent, "默认 (20)", "未保存步数显示缺省 20");

    keydown(overlay, "ArrowDown"); // Plain Skill：非生成技能 → skill.md 模板正文摘录
    await sleep(30);
    assert.match(preview.querySelector(".rs-skill-preview-body").textContent, /模板正文/, "非生成技能显示 skill.md 正文摘录");

    fire(pickerRow("Full Skill"), "mouseenter"); // hover 行同样切换预览卡
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "Full Skill", "hover 行同步预览卡");
    res.close();

    const res2 = openSkillPickerModal({ items: [{ value: "x", label: "X" }] });
    assert.equal(document.querySelector(".rs-skill-picker-preview"), null, "非技能条目（如配方）不显示预览卡");
    res2.close();
});

// 非生成技能：预览卡懒加载 skill.md 正文摘录，缓存避免重复请求，超长截断
test("非生成技能：预览卡显示 skill.md 模板正文摘录（懒加载 + 缓存 + 截断）", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const longBody = "提示词模板 ".repeat(200); // 1200 字符 > 400
    let loadCalls = 0;
    mockRoute("/rs_prompts/load_skill", (b) => { loadCalls++; return jsonResponse({ id: b.id, name: "T", content: longBody, files: [] }); });
    const items = [
        { value: "t1", label: "Task A", skillId: "t1" },
        { value: "t2", label: "Task B", skillId: "t2" },
    ];
    openSkillPickerModal({ items });
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "纯任务技能列表也渲染预览卡");

    keydown(overlay, "ArrowDown"); // Task A：首次聚焦懒加载
    await sleep(30);
    const bodyEl = () => preview.querySelector(".rs-skill-preview-body");
    assert.ok(bodyEl(), "非生成技能显示正文摘录区");
    assert.match(bodyEl().textContent, /…$/, "超长正文截断并加省略号");
    assert.equal(bodyEl().textContent.length, 401, "截断到 400 字符 + …");

    keydown(overlay, "ArrowUp"); // Task B：第二次加载
    await sleep(30);
    assert.equal(loadCalls, 2, "每个技能首次聚焦各加载一次");
    keydown(overlay, "ArrowUp"); // 回到 Task A：缓存命中（同样截断）
    await sleep(30);
    assert.match(bodyEl().textContent, /…$/);
    assert.equal(bodyEl().textContent.length, 401, "缓存路径同样截断到 400 字符 + …");
    assert.equal(loadCalls, 2, "重复聚焦同一技能走缓存不重新加载");
    overlay.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); // 关闭选择窗，避免 _skillPickerOpen 泄漏到后续测试
    await sleep(20);
});

// 导演编辑器分段技能下拉（attachSkillPickerToSelect）：option 携带 __skillMeta 时透传给选择窗条目，预览卡正常渲染
test("select 拦截弹窗：option 元数据透传，生视频技能显示配置预览", async () => {
    const { attachSkillPickerToSelect } = await import("../../web/skill.js");
    const selectEl = document.createElement("select");
    const mkOpt = (id, name, meta) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = name;
        o.dataset.source = meta.source || "custom";
        o.__skillMeta = meta;
        selectEl.appendChild(o);
    };
    mkOpt("", "（无可用视频技能）", {});
    mkOpt("sk-v", "H3 全能参考", { id: "sk-v", name: "H3 全能参考", source: "preset", category: "video_gen", gen_video: true, gen_config: { model: "minimax_h3.safetensors" } });
    mkOpt("sk-t", "提示词优化", { id: "sk-t", name: "提示词优化", source: "custom", category: "task" });
    selectEl.value = "sk-v";
    attachSkillPickerToSelect(selectEl);
    selectEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await sleep(30);

    const overlay = document.querySelector(".rs-skill-modal-overlay");
    assert.ok(overlay, "点击 select 弹出选择窗");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "技能条目带元数据时渲染预览卡");
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "H3 全能参考", "初始高亮当前值所在行");
    assert.match(preview.textContent, /minimax_h3\.safetensors/);

    keydown(overlay, "ArrowDown"); // 切到非生成技能 → 正文摘录（未 mock load_skill → 空正文）
    await sleep(30);
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "提示词优化");
    assert.match(preview.textContent, /无正文/);
    overlay.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); // 关闭选择窗，避免 _skillPickerOpen 泄漏到后续测试
    await sleep(20);
});

// 后端 /rs_prompts/skills 的 gen_config 透传为条目 genConfig 并渲染到右侧预览卡；点预览卡按 skillId（而非 combo name）打开详情编辑弹窗，选择窗关闭且不触发选中写回
test("预览卡点击：按 skillId 打开详情、关闭选择窗、不触发选中写回", async () => {
    const { attachSkillPickerToComboWidget } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "gen-skill-id", name: "Gen Skill Name", source: "custom", category: "image_gen", tags: [], gen_image: true, gen_config: { model: "qwen3.safetensors", default_ratio: "9:16" } },
    ]));
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b && b.id;
        return jsonResponse({ id: b.id, name: "Gen Skill Name", content: "", files: [{ name: "skill.md", size: 5 }], gen_image: true, requires_ref: false, multi_turn: false, tags: [], category: "image_gen" });
    });
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "" }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => {
        if (call.method === "GET") return jsonResponse({});
        return jsonResponse({ success: true });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));

    let cbValue = null;
    const widget = { name: "skill_id", value: "Gen Skill Name", options: { values: ["Gen Skill Name"] }, callback: (v) => { cbValue = v; } };
    attachSkillPickerToComboWidget(widget, { title: "选择 Skill（测试）" });
    widget.onPointerDown({ clientX: 100, clientY: 200 }, makeNode(), null);
    await sleep(30);

    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "后端 gen_config 应透传为条目 genConfig 并渲染预览卡");
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "Gen Skill Name", "初始高亮当前值所在行并显示其配置");
    assert.match(preview.textContent, /qwen3\.safetensors/);
    assert.match(preview.textContent, /9:16/);

    const overlayEl = document.querySelector(".rs-skill-modal-overlay");
    click(preview);
    await sleep(30);

    assert.equal(loadedId, "gen-skill-id", "应按 skill id 打开详情（而非 combo 的 name）");
    assert.equal(overlayEl.isConnected, false, "点预览卡后选择窗应关闭");
    assert.equal(cbValue, null, "点预览卡不应触发选中写回");
});

// 未保存配置的生成技能：预览卡仍渲染，主模型取与详情同源的自动建议（生图 suggested_diffusion_models / 生视频 H3 名称线索），长边/比例取后端默认
test("未保存配置：预览卡显示与详情一致的自动默认值", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["krea2-turbo.safetensors"], suggested_diffusion_models: "krea2-turbo.safetensors", text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["minimax_h3_7b.safetensors", "other.safetensors"], text_encoders: [], vae: [] }));

    const items = [
        { value: "img", label: "Img NoCfg", genImage: true },
        { value: "vid", label: "Vid NoCfg", genVideo: true },
    ];
    const res = openSkillPickerModal({ items });
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "无保存配置的生成技能也应渲染预览卡（显示自动默认值）");

    keydown(overlay, "ArrowDown"); // Img NoCfg
    await sleep(30); // 等模型列表拉取到位后刷新
    const rowsOf = () => Array.from(preview.querySelectorAll(".rs-skill-preview-row"));
    assert.deepEqual(rowsOf().map((r) => r.querySelector(".rs-skill-preview-key").textContent), ["主模型", "长边尺寸", "默认比例", "步数"]);
    assert.equal(rowsOf()[0].querySelector(".rs-skill-preview-val").textContent, "自动（krea2-turbo）", "未保存主模型显示与详情一致的建议模型");
    assert.equal(rowsOf()[1].querySelector(".rs-skill-preview-val").textContent, "默认 (1280)");
    assert.equal(rowsOf()[2].querySelector(".rs-skill-preview-val").textContent, "默认 (1:1)");
    assert.equal(rowsOf()[3].querySelector(".rs-skill-preview-val").textContent, "默认 (20)");

    keydown(overlay, "ArrowDown"); // Vid NoCfg
    await sleep(30);
    assert.deepEqual(rowsOf().map((r) => r.querySelector(".rs-skill-preview-key").textContent), ["主模型", "长边尺寸", "默认比例", "步数"], "生视频同样显示全部字段（含默认值）");
    assert.equal(rowsOf()[0].querySelector(".rs-skill-preview-val").textContent, "自动（minimax_h3_7b）", "生视频按 H3 名称线索自动挑选，与详情一致");
    assert.equal(rowsOf()[1].querySelector(".rs-skill-preview-val").textContent, "默认 (1280)");
    assert.equal(rowsOf()[2].querySelector(".rs-skill-preview-val").textContent, "默认 (1:1)");
    assert.equal(rowsOf()[3].querySelector(".rs-skill-preview-val").textContent, "默认 (20)");
    res.close(); // 清理 _skillPickerOpen，避免影响后续测试
});

// 预览卡以焦点行为锚点：紧贴其右侧、顶边对齐；右侧放不下翻到行左侧（jsdom 无布局，stub rect/offset 验证坐标计算）
test("预览卡跟随焦点行锚定在其右侧（放不下翻左侧）", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const items = [
        { value: "a", label: "Alpha", genImage: true, genConfig: { model: "m.safetensors" } },
        { value: "b", label: "Beta", genVideo: true, genConfig: { model: "v.safetensors" } },
    ];
    const res = openSkillPickerModal({ items });
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "存在生成技能时渲染预览卡");
    Object.defineProperty(preview, "offsetWidth", { value: 340, configurable: true });
    Object.defineProperty(preview, "offsetHeight", { value: 120, configurable: true });
    const rows = Array.from(document.querySelectorAll(".rs-skill-picker-item"));
    rows[0].getBoundingClientRect = () => ({ left: 100, right: 420, top: 200, bottom: 230, width: 320, height: 30 });
    rows[1].getBoundingClientRect = () => ({ left: 100, right: 420, top: 240, bottom: 270, width: 320, height: 30 });

    keydown(overlay, "ArrowDown"); // 焦点行 0
    assert.equal(preview.style.left, "428px", "紧贴焦点行右侧（right + 8）");
    assert.equal(preview.style.top, "200px", "顶边与焦点行对齐");

    keydown(overlay, "ArrowDown"); // 焦点移到行 1，卡片跟随
    assert.equal(preview.style.left, "428px");
    assert.equal(preview.style.top, "240px", "随焦点移动重新锚定");

    rows[1].getBoundingClientRect = () => ({ left: 900, right: 1220, top: 300, bottom: 330, width: 320, height: 30 });
    fire(rows[1], "mouseenter"); // 行贴近视口右缘（jsdom vw=1024），右侧放不下 → 翻到行左侧
    assert.equal(preview.style.left, "552px", "右侧放不下时翻到行左侧（left - w - 8）");
    assert.equal(preview.style.top, "300px");
    res.close(); // 清理 _skillPickerOpen，避免影响后续测试
});

// 自定义 previewRenderer（导演配方选择窗用）：条目无 skillId/genImage 也渲染预览卡、由调用方函数渲染；
// 点卡片走 onPreviewClick（打开配方编辑器）而非技能详情
test("previewRenderer 自定义预览卡：随焦点更新，点击触发 onPreviewClick 并关窗", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    let clicked = null;
    const res = openSkillPickerModal({
        items: [
            { value: "rec-a", label: "配方 A" },
            { value: "rec-b", label: "配方 B" },
        ],
        previewRenderer: (preview, it) => { preview.textContent = it ? `preview:${it.value}` : "hint"; },
        onPreviewClick: (it) => { clicked = it; },
    });
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "传 previewRenderer 时，无 skillId/genImage 的条目也应渲染预览卡");
    assert.equal(preview.textContent, "hint", "无焦点行时由自定义渲染器画提示态");

    keydown(overlay, "ArrowDown"); // 焦点行 0
    await sleep(20);
    assert.equal(preview.textContent, "preview:rec-a");

    keydown(overlay, "ArrowDown"); // 焦点移到行 1，预览卡跟随
    await sleep(20);
    assert.equal(preview.textContent, "preview:rec-b");

    click(preview);
    await sleep(20);
    assert.ok(clicked && clicked.value === "rec-b", "点预览卡应以焦点条目调用 onPreviewClick");
    assert.equal(document.querySelector(".rs-skill-modal-overlay"), null, "点预览卡后选择窗应关闭");
});

// 回归：不传 previewRenderer 且条目无 skillId/genImage（纯 label 条目）时不渲染预览卡
test("无 previewRenderer 的纯文本条目：不渲染预览卡", async () => {
    const { openSkillPickerModal } = await import("../../web/skill.js");
    const res = openSkillPickerModal({ items: [{ value: "x", label: "X" }] });
    assert.equal(document.querySelector(".rs-skill-picker-preview"), null, "无技能条目且无自定义渲染器时不渲染预览卡");
    res.close();
});
