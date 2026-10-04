// 统一技能管理窗口（顶栏 🅝 菜单「🗂 技能管理」）：左侧技能列表（搜索 + 分类分组）+ 右侧内嵌详情。
// 覆盖：开窗布局 / 点击切换详情 / 搜索过滤 / 关闭整窗 / rs.skills.updated 刷新 / 未保存修改切换确认。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, flush, sleep, click, inputText, fire, setConfirmAnswer, dialogs, window } from "./setup.mjs";

const LEFT_W_KEY = "neo.skillManagerLeftWidth";

let skills;
beforeEach(() => {
    resetEnv();
    clearRoutes();
    skills = [
        { id: "preset_img", name: "Preset Image", cn_name: "预设生图", source: "presets", category: "image_gen" },
        { id: "custom_a", name: "Custom A", source: "custom", category: "" },
    ];
});

function mockSkills() {
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
}
function mockLoadSkill() {
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Preset Image", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: false, gen_video: false, multi_turn: false, tags: [],
        category: skills.find((s) => s.id === b.id)?.category || "",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
}

async function openMgr() {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    openSkillManager();
    await flush();
    await sleep(50);
    return document.querySelector(".rs-skill-manager");
}
function closeMgr(box) {
    click(box.querySelector(".rs-skill-manager-head .rs-skill-modal-close"));
}

test("打开技能管理窗口：左侧列表按分类分组，右侧内嵌详情并默认选中默认展开分类的第一项", async () => {
    const box = await openMgr();
    assert.ok(box, "应创建 .rs-skill-manager 窗口");
    // 左侧列表：两条技能行 + 分类分组头
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 2, "左侧应有 2 条技能行");
    assert.ok(box.querySelector(".rs-combo-category"), "应渲染分类分组头");
    // 右侧内嵌详情：.rs-skill-modal 挂在右面板内（非独立 overlay）
    const right = box.querySelector(".rs-skill-manager-right");
    const modal = right.querySelector(".rs-skill-modal");
    assert.ok(modal, "右侧应内嵌 .rs-skill-modal");
    assert.notEqual(modal.style.display, "none", "详情应可见（默认选中第一项）");
    // 默认选中「🖼️ 直接生图或编辑」分类（默认展开）的第一项，而非按分组名排序的列表首项
    const sel = box.querySelector(".rs-skill-picker-item.is-selected");
    assert.ok(sel && sel.textContent.includes("预设生图"), "默认应选中展开分类的第一项（预设生图）");
    const openCat = box.querySelector(".rs-skill-manager-cat.is-open");
    assert.ok(openCat && openCat.textContent.includes("直接生图或编辑"), "默认展开「直接生图或编辑」分类");
    closeMgr(box);
    await flush();
    assert.equal(document.querySelector(".rs-skill-manager"), null, "关闭后窗口移除");
});

test("点击列表项切换右侧详情（按 skill id 加载）", async () => {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b.id;
        return jsonResponse({ id: b.id, name: "Custom A", content: "body-a", files: [{ name: "skill.md", size: 6 }], gen_image: false, multi_turn: false, tags: [], category: "" });
    });
    openSkillManager();
    await flush();
    await sleep(50);

    const box = document.querySelector(".rs-skill-manager");
    const target = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    assert.ok(target, "应找到 Custom A 行");
    click(target);
    await flush();
    await sleep(50);

    assert.equal(loadedId, "custom_a", "应按 skill id 加载详情");
    const sel = box.querySelector(".rs-skill-picker-item.is-selected");
    assert.ok(sel && sel.textContent.includes("Custom A"), "选中行应切到 Custom A");
    closeMgr(box);
});

test("搜索框过滤左侧列表", async () => {
    const box = await openMgr();
    const search = box.querySelector(".rs-skill-picker-search");
    inputText(search, "Custom");
    await flush();
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 1, "搜索后应只剩 1 条");
    assert.ok(items[0].textContent.includes("Custom A"), "应命中 Custom A");
    closeMgr(box);
});

test("关闭整窗（✕）移除 overlay", async () => {
    const box = await openMgr();
    assert.ok(box, "窗口应已打开");
    closeMgr(box);
    await flush();
    assert.equal(document.querySelector(".rs-skill-manager"), null, "关闭后应移除窗口");
});

test("技能增删改广播 rs.skills.updated 自动刷新列表", async () => {
    const box = await openMgr();
    skills.push({ id: "custom_b", name: "Custom B", source: "custom", category: "" });
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
    await flush();
    await sleep(50);
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 3, "广播后列表应刷新为 3 条");
    closeMgr(box);
});

test("有未保存修改时切换先出确认（取消则保持当前项）", async () => {
    const box = await openMgr();
    // 编辑正文 → 详情变脏
    const ta = box.querySelector(".rs-skill-modal .rs-tpl-content");
    assert.ok(ta, "应找到正文输入框");
    inputText(ta, "edited");
    setConfirmAnswer(false);   // 用户选择「继续编辑」
    const before = box.querySelector(".rs-skill-picker-item.is-selected").textContent;
    const target = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => !r.classList.contains("is-selected"));
    assert.ok(target, "应找到未选中的行");
    click(target);
    await flush();
    await sleep(50);
    assert.ok(dialogs.confirms.length > 0, "应弹出未保存确认");
    const after = box.querySelector(".rs-skill-picker-item.is-selected").textContent;
    assert.equal(after, before, "取消后选中项不变");
    closeMgr(box);
});

test("分类头点击折叠/展开其下技能", async () => {
    // 两个同分类（image_gen）+ 一个未分组，验证折叠只影响本组
    skills = [
        { id: "p1", name: "P1", source: "preset", category: "image_gen" },
        { id: "p2", name: "P2", source: "preset", category: "image_gen" },
        { id: "c1", name: "C1", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const list = box.querySelector(".rs-skill-picker-list");
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 3, "初始应有 3 条技能行");
    const cat = list.querySelector(".rs-combo-category");
    assert.ok(cat, "应渲染分类分组头");
    click(cat);
    await flush();
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 1, "折叠后只剩未分组的 C1");
    click(cat);
    await flush();
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 3, "展开后恢复 3 条");
    closeMgr(box);
});
test("分类手风琴：默认只展开「生图」，展开别的分类自动收起前一个", async () => {
    skills = [
        { id: "g1", name: "Gen 1", source: "preset", category: "image_gen" },
        { id: "v1", name: "Vid 1", source: "preset", category: "video_gen" },
        { id: "e1", name: "Enh 1", source: "preset", category: "image_enhance" },
        { id: "c1", name: "C1", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const list = box.querySelector(".rs-skill-picker-list");
    const labels = () => Array.from(list.querySelectorAll(".rs-skill-picker-item .rs-skill-picker-label")).map((r) => r.textContent.trim());
    const catOf = (text) => Array.from(list.querySelectorAll(".rs-combo-category")).find((c) => c.textContent.includes(text));
    const openCats = () => Array.from(list.querySelectorAll(".rs-combo-category.is-open"));

    assert.deepEqual(labels().sort(), ["C1", "Gen 1"], "首屏只展开「生图」，其余分类收起（未分组项无分类头，常显）");
    assert.equal(openCats().length, 1, "同时只有一个分类被标记为展开态");
    assert.ok(openCats()[0].textContent.includes("直接生图或编辑"), "展开态高亮在「生图」");

    click(catOf("生视频 (H3)"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Vid 1"], "展开生视频后「生图」被收起");
    assert.ok(openCats()[0].textContent.includes("生视频 (H3)"), "高亮随展开的分类一起切换");

    click(catOf("直接生图或编辑"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Gen 1"], "回到生图，生视频被收起");

    click(catOf("直接生图或编辑"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1"], "点当前分类头收起它自己");
    assert.equal(openCats().length, 0, "全部收起后没有分类处于高亮态");

    click(catOf("图像提示词增强"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Enh 1"], "全部收起后点其它分类直接展开它");
    closeMgr(box);
});

test("task 分类技能在管理窗口隐藏，video_gen / custom 保持可见", async () => {
    skills = [
        { id: "task_a", name: "Task A", source: "tasks", category: "task" },
        { id: "video_a", name: "Video A", source: "presets", category: "video_gen" },
        { id: "custom_a", name: "Custom A", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const labels = Array.from(box.querySelectorAll(".rs-skill-picker-item")).map((r) => r.textContent);
    assert.ok(!labels.some((t) => t.includes("Task A")), "task 技能应隐藏");
    assert.ok(labels.some((t) => t.includes("Video A")), "video_gen 技能应保持可见");
    assert.ok(labels.some((t) => t.includes("Custom A")), "custom 技能应保持可见");
    closeMgr(box);
});

test("左侧列表行内操作：预设行只有 ⧉ 复制，自定义行有 ⧉ + 🗑", async () => {
    const box = await openMgr();
    const rowOf = (text) => Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes(text));
    const presetRow = rowOf("预设生图");
    const customRow = rowOf("Custom A");
    assert.equal(presetRow.querySelectorAll(".rs-skill-row-btn").length, 1, "预设行只给复制按钮（预设不可删）");
    assert.equal(customRow.querySelectorAll(".rs-skill-row-btn").length, 2, "自定义行给复制 + 删除");
    assert.ok(customRow.querySelector(".rs-skill-row-del"), "删除按钮带 .rs-skill-row-del（hover 淡入样式）");
    closeMgr(box);
});

test("行内 ⧉ 复制：写为自定义副本并刷新列表、切到副本详情", async () => {
    const box = await openMgr();
    let saved = null;
    mockRoute("/rs_prompts/save_skill", (b) => {
        saved = b;
        skills.push({ id: b.id, name: b.name, source: "custom", category: "" });
        return jsonResponse({ success: true, id: b.id });
    });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("预设生图"));
    click(row.querySelector(".rs-skill-row-btn"));
    await flush();
    await sleep(50);

    assert.equal(saved.source, "custom", "副本写为自定义技能");
    assert.equal(saved.category, "image_gen", "保留源技能分类");
    assert.ok(saved.name.includes("(Copy)"), "副本名称加 (Copy) 后缀");
    const items = box.querySelectorAll(".rs-skill-picker-item");
    assert.equal(items.length, 3, "广播后列表刷新为 3 条");
    assert.ok(box.querySelector(".rs-skill-picker-item.is-selected").textContent.includes("(Copy)"), "右侧详情切到副本");
    closeMgr(box);
});

test("行内 🗑 删除：确认后删除自定义技能并刷新列表", async () => {
    const box = await openMgr();
    let deleted = null;
    mockRoute("/rs_prompts/delete_skill", (b) => {
        deleted = b.id;
        skills = skills.filter((s) => s.id !== b.id);
        return jsonResponse({ success: true });
    });
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);

    assert.equal(deleted, "custom_a", "按 skill id 删除");
    assert.equal(box.querySelectorAll(".rs-skill-picker-item").length, 1, "列表刷新为 1 条");
    closeMgr(box);
});

test("行内 🗑 删除当前选中技能：右侧详情收起为占位提示", async () => {
    const box = await openMgr();
    mockRoute("/rs_prompts/delete_skill", (b) => {
        skills = skills.filter((s) => s.id !== b.id);
        return jsonResponse({ success: true });
    });
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row);                       // 先选中 Custom A，右侧显示其详情
    await flush();
    await sleep(50);
    assert.notEqual(box.querySelector(".rs-skill-manager-right .rs-skill-modal").style.display, "none", "详情已打开");

    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);
    assert.equal(box.querySelector(".rs-skill-manager-right .rs-skill-modal").style.display, "none", "被删技能的详情收起");
    assert.ok(!box.querySelector(".rs-skill-manager-empty").hidden, "占位提示恢复显示");
    closeMgr(box);
});

test("行内 🗑 删除取消确认时不发请求", async () => {
    const box = await openMgr();
    setConfirmAnswer(false);
    mockRoute("/rs_prompts/delete_skill", () => jsonResponse({ success: true }));
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);
    assert.ok(dialogs.confirms.some((m) => m.includes("Custom A")), "应弹出删除确认");
    assert.equal(box.querySelectorAll(".rs-skill-picker-item").length, 2, "取消后列表不变");
    closeMgr(box);
});

test("内嵌模式（Studio 技能页）：无 ✕ / 无「从画布」按钮，close() 移除根节点并清监听", async () => {
    const { createSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mgr = createSkillManager(host, { showClose: false, showCanvasBtn: false });
    await flush();
    await sleep(50);

    assert.ok(mgr.el.classList.contains("rs-skill-manager"), "根节点应为 .rs-skill-manager");
    assert.equal(mgr.closeBtn, null, "内嵌模式不应有 ✕");
    const btns = Array.from(mgr.el.querySelectorAll(".rs-skill-footer-btn")).map((b) => b.textContent);
    assert.ok(btns.some((t) => t.includes("新建")), "应保留「新建」按钮");
    assert.ok(!btns.some((t) => t.includes("从画布")), "内嵌模式不应有「从画布」按钮");
    assert.equal(mgr.el.querySelectorAll(".rs-skill-picker-item").length, 2, "列表应加载");

    // rs.skills.updated 仍刷新列表；close() 后清监听并移除根节点
    skills.push({ id: "custom_b", name: "Custom B", source: "custom", category: "" });
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
    await flush();
    await sleep(50);
    assert.equal(mgr.el.querySelectorAll(".rs-skill-picker-item").length, 3, "广播后列表应刷新为 3 条");
    mgr.close();
    assert.equal(host.querySelector(".rs-skill-manager"), null, "close() 应移除根节点");
});

// 拖拽分隔条改左栏宽度：jsdom 无布局，用 __rect 给出主体/左栏的可预测宽度
function dragSplit(split, fromX, toX, { bodyW = 1200, leftW = 300 } = {}) {
    const rect = (w) => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: 800, width: w, height: 800 });
    split.parentElement.__rect = rect(bodyW);
    split.parentElement.querySelector(".rs-skill-manager-left").__rect = rect(leftW);
    split.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, clientX: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: toX, bubbles: true }));
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
}

test("左栏分隔条：拖拽调整宽度，松手记忆到 localStorage 并在重开窗口时沿用", async () => {
    localStorage.removeItem(LEFT_W_KEY);
    const box = await openMgr();
    const split = box.querySelector(".rs-skill-manager-split");
    const left = box.querySelector(".rs-skill-manager-left");
    assert.ok(split, "左右面板之间应有可拖拽分隔条");
    assert.equal(left.style.width, "", "首次开窗使用 CSS 默认宽度");

    dragSplit(split, 300, 420);
    assert.equal(left.style.width, "420px", "拖拽后左栏宽度跟随光标");
    assert.equal(localStorage.getItem(LEFT_W_KEY), "420px", "松手写入宽度记忆");

    closeMgr(box);
    const box2 = await openMgr();
    assert.equal(box2.querySelector(".rs-skill-manager-left").style.width, "420px", "重开窗口沿用上次宽度");
    closeMgr(box2);
    localStorage.removeItem(LEFT_W_KEY);
});

test("左栏宽度钳制在上下限之间；双击分隔条清除记忆回到默认宽度", async () => {
    localStorage.removeItem(LEFT_W_KEY);
    const box = await openMgr();
    const split = box.querySelector(".rs-skill-manager-split");
    const left = box.querySelector(".rs-skill-manager-left");

    dragSplit(split, 300, 40);
    assert.equal(left.style.width, "180px", "向左拖到底钳到左栏下限");
    dragSplit(split, 300, 1200, { bodyW: 1200, leftW: 180 });
    assert.equal(left.style.width, "880px", "向右拖到底钳到主体宽 - 右栏下限");
    assert.equal(localStorage.getItem(LEFT_W_KEY), "880px", "两次拖拽均落盘");

    fire(split, "dblclick");
    assert.equal(left.style.width, "", "双击回到 CSS 默认宽度");
    assert.equal(localStorage.getItem(LEFT_W_KEY), null, "双击清除宽度记忆");
    closeMgr(box);
});

