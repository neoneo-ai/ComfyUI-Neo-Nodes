// 统一技能管理窗口（顶栏 🅝 菜单「🗂 技能管理」）：左侧技能列表（搜索 + 分类分组）+ 右侧内嵌详情。
// 覆盖：开窗布局 / 点击切换详情 / 搜索过滤 / 关闭整窗 / rs.skills.updated 刷新 / 未保存修改切换确认。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, flush, sleep, click, inputText, fire, keydown, setConfirmAnswer, dialogs, window } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

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
    split.dispatchEvent(new window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: toX, bubbles: true }));
    document.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
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


// ================= 独立窗口控件（Director 风格）=================
// 无遮罩（透明 + 指针穿透）+ 标题栏拖动 + ⛶ 放大/还原 + 双击标题栏 + 右下角把手
const cssText = readFileSync(new URL("../../web/prompts.css", import.meta.url), "utf8");

function mouseAt(el, type, init = {}) {
    const Ctor = type.startsWith("pointer") ? window.PointerEvent : window.MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

async function openMgrWindow() {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    openSkillManager();
    await flush();
    await sleep(50);
    const overlay = document.querySelector(".rs-skill-manager-overlay");
    return {
        overlay,
        box: overlay.querySelector(".rs-skill-manager"),
        head: overlay.querySelector(".rs-skill-manager-head"),
    };
}

test("独立窗口无遮罩：overlay 透明穿透，点窗口外不关闭；Esc 关闭", async () => {
    const { overlay, box } = await openMgrWindow();
    assert.ok(overlay.classList.contains("rs-skill-manager-overlay"), "整窗 overlay 带独立窗口类");
    assert.ok(box, "窗口挂在 overlay 内");
    mouseAt(overlay, "pointerdown");
    assert.ok(document.body.contains(overlay), "点窗口外不应关闭");
    keydown(document, "Escape");
    assert.ok(!document.body.contains(overlay), "Esc 应关闭整窗");
});

test("技能管理窗口 CSS：透明穿透 overlay、最小尺寸、标题栏与把手样式齐备", () => {
    assert.match(cssText, /\.rs-skill-modal-overlay\.rs-skill-manager-overlay\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/);
    assert.match(cssText, /\.rs-skill-manager\s*\{[^}]*min-width:\s*640px;[^}]*min-height:\s*420px;/);
    assert.match(cssText, /\.rs-skill-manager-head\s*\{[^}]*cursor:\s*move;/);
    assert.match(cssText, /\.rs-skill-manager-resize\s*\{[^}]*cursor:\s*nwse-resize;/);
    assert.match(cssText, /\.rs-wf-editor-canvas-box\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/);
});

test("标题栏 ⛶ 放大铺满视口（留 8px 边距），再点还原回放大前几何", async () => {
    const { box, head } = await openMgrWindow();
    const maxBtn = head.querySelector(".rs-skill-manager-maximize");
    assert.ok(maxBtn, "标题栏应有放大按钮");
    assert.equal(maxBtn.textContent, "⛶");
    click(maxBtn);
    assert.equal(box.style.width, "calc(100vw - 16px)");
    assert.equal(box.style.height, "calc(100vh - 16px)");
    assert.equal(box.style.left, "8px");
    assert.equal(maxBtn.textContent, "🗗");
    click(maxBtn);
    assert.equal(box.style.width, "", "还原回放大前宽度");
    assert.equal(box.style.height, "");
    assert.equal(maxBtn.textContent, "⛶");
    closeMgr(box);
});

test("双击标题栏放大 / 再双击还原（点按钮不触发）", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head, "dblclick");
    assert.equal(box.style.height, "calc(100vh - 16px)", "双击标题栏应放大");
    mouseAt(head.querySelector(".rs-skill-manager-maximize"), "dblclick");
    assert.equal(box.style.height, "calc(100vh - 16px)", "双击按钮不应触发放大/还原");
    mouseAt(head, "dblclick");
    assert.equal(box.style.height, "", "再双击应还原");
    closeMgr(box);
});

test("标题栏拖动移动窗口，位置钳制在视口内", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head, "pointerdown", { clientX: 100, clientY: 100 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 200 }));
    assert.equal(box.style.left, "200px");
    assert.equal(box.style.top, "100px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1 }));
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 900, clientY: 700 }));
    assert.equal(box.style.left, "200px", "松手后拖动应失效");

    mouseAt(head, "pointerdown", { clientX: 0, clientY: 0 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 4000, clientY: 4000 }));
    assert.equal(box.style.left, `${window.innerWidth - 80}px`, "向右拖到底钳到视口右缘");
    assert.equal(box.style.top, `${window.innerHeight - 44}px`, "向下拖到底钳到视口下缘");
    closeMgr(box);
});

test("标题栏按钮不触发拖动；放大态下标题栏拖动无效", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head.querySelector(".rs-skill-manager-maximize"), "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(box.style.left, "", "从按钮按下不应开始拖动");

    click(head.querySelector(".rs-skill-manager-maximize"));
    mouseAt(head, "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(box.style.left, "8px", "放大态不应被拖动改位置");
    closeMgr(box);
});

test("右下角把手拖拽调整窗口尺寸，钳制最小尺寸", async () => {
    const { box } = await openMgrWindow();
    const grip = box.querySelector(".rs-skill-manager-resize");
    assert.ok(grip, "窗口应有右下角把手");
    mouseAt(grip, "pointerdown", { clientX: 500, clientY: 500 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 700, clientY: 620 }));
    assert.equal(box.style.width, "640px", "小于最小宽应钳到 640");
    assert.equal(box.style.height, "420px", "小于最小高应钳到 420");
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 1200, clientY: 1120 }));
    assert.equal(box.style.width, "700px");
    assert.equal(box.style.height, "620px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1 }));
    closeMgr(box);
});

// 手势被取消（pointercancel）或在页面外松手（页面收不到 pointerup）时，
// 拖拽监听器必须失效：否则窗口 / 左栏会在无按键状态下继续跟着鼠标跑
test("拖拽收尾：pointercancel 与缺失 pointerup 后不再跟随鼠标", async () => {
    const { box, head } = await openMgrWindow();
    const grip = box.querySelector(".rs-skill-manager-resize");

    mouseAt(grip, "pointerdown", { clientX: 500, clientY: 500 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 700, clientY: 620 }));
    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    const size = [box.style.width, box.style.height];
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 1200, clientY: 1120 }));
    assert.deepEqual([box.style.width, box.style.height], size, "把手手势取消后尺寸应冻结");

    mouseAt(head, "pointerdown", { clientX: 100, clientY: 100 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 200 }));
    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    const pos = [box.style.left, box.style.top];
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 900, clientY: 700 }));
    assert.deepEqual([box.style.left, box.style.top], pos, "标题栏手势取消后位置应冻结");
    closeMgr(box);

    localStorage.removeItem(LEFT_W_KEY);
    const mgr = await openMgr();
    const split = mgr.querySelector(".rs-skill-manager-split");
    const left = mgr.querySelector(".rs-skill-manager-left");
    const rect = (w) => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: 800, width: w, height: 800 });
    split.parentElement.__rect = rect(1200);
    left.__rect = rect(300);
    split.dispatchEvent(new window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 300, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: 420, bubbles: true }));
    assert.equal(left.style.width, "420px");
    // 松手发生在页面外：页面只收到 pointercancel（无 pointerup），宽度必须停住
    document.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: 700, bubbles: true }));
    assert.equal(left.style.width, "420px", "分隔条手势取消后宽度应冻结");
    assert.equal(document.body.classList.contains("rs-skill-resizing"), false, "取消后应清除拖拽光标");
    assert.equal(split.classList.contains("is-dragging"), false, "取消后应清除分隔条拖拽态");
    closeMgr(mgr);
    localStorage.removeItem(LEFT_W_KEY);
});

test("Studio 内嵌模式：不加放大按钮 / 把手 / 拖动，保持内嵌布局", async () => {
    const { createSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mgr = createSkillManager(host, { showClose: false, showCanvasBtn: false });
    await flush();
    await sleep(50);

    assert.equal(mgr.el.querySelector(".rs-skill-manager-maximize"), null, "内嵌模式不应有放大按钮");
    assert.equal(mgr.el.querySelector(".rs-skill-manager-resize"), null, "内嵌模式不应有把手");
    mouseAt(mgr.head, "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(mgr.el.style.left, "", "内嵌模式标题栏不应可拖动");
    assert.equal(mgr.el.parentNode, host, "根节点仍内嵌在宿主里");
    mgr.close();
});


// ================= 工作流区：只读流程图 ⇄ 内嵌 litegraph 编辑 =================
const WF_TEMPLATE = {
    "1": { class_type: "NeoPromptAgent", inputs: { prompt: "{{PROMPT}}" }, _meta: { title: "Prompt" } },
    "2": { class_type: "KSampler", inputs: { seed: "{{SEED}}" }, _meta: { title: "Sampler" } },
};

// 内嵌编辑走真实 litegraph 加载路径（API prompt → litegraph 序列化 → configure / start / LGraphCanvas），
// 这里给最小可断言桩：LiteGraph.createNode 返回带 widget/槽位顺序的节点模板
function stubLiteGraph({ unregistered = [] } = {}) {
    const created = { graphs: [], canvases: [], lite: [] };
    class FakeGraph {
        constructor() { this._nodes = []; created.graphs.push(this); }
        configure(lite) {
            created.lite.push(lite);
            this._nodes = (lite.nodes || []).map((n) => ({ id: n.id, type: n.type, size: n.size, pos: n.pos, widgets_values: n.widgets_values, removed: false }));
        }
        removeNode(n) { n.removed = true; this._nodes = this._nodes.filter((x) => x !== n); }
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; }
        start() { this.started = true; }
        clear() { this.cleared = true; }
    }
    class FakeCanvas {
        constructor(el, graph) {
            this.el = el;
            this.graph = graph;
            this.ds = { scale: 1, offset: [0, 0] };
            this.ctx = { setTransform: (a) => { this.transform = a; } };
            created.canvases.push(this);
        }
        resize(w, h) { this.size = [w, h]; }
        setDirty() {}
        draw() { this.drawn = (this.drawn || 0) + 1; }
        stopRendering() { this.stopped = true; }
        unbindEvents() { this.unbound = true; }
        // 同前端 litegraph：弹窗挂 canvas.parentNode，按「clientX - canvas 左上角」定位
        prompt(name, value, callback, event) {
            const dlg = document.createElement("div");
            dlg.className = "graphdialog";
            this.el.parentNode.appendChild(dlg);
            const rect = this.el.getBoundingClientRect();
            dlg.style.left = `${(event ? event.clientX : this.el.width * 0.5) - rect.left - 20}px`;
            dlg.style.top = `${(event ? event.clientY : 0) - rect.top - 20}px`;
            this.prompt_box = dlg;
        }
    }
    const LiteGraph = {
        createNode(type) {
            if (unregistered.includes(type)) return null;
            return {
                type, size: [210, 90], mode: 0, flags: {},
                widgets: [{ name: "prompt" }, { name: "seed" }], widgets_values: ["", 0],
                inputs: [{ name: "prompt", type: "STRING" }, { name: "seed", type: "INT" }],
                outputs: [{ name: "MODEL", type: "MODEL" }],
            };
        },
    };
    globalThis.LGraph = FakeGraph;
    globalThis.LGraphCanvas = FakeCanvas;
    globalThis.LiteGraph = LiteGraph;
    window.LGraph = FakeGraph;
    window.LGraphCanvas = FakeCanvas;
    window.LiteGraph = LiteGraph;
    return created;
}

function mockWfSkill({ id = "wf_demo", source = "custom", workflow = WF_TEMPLATE } = {}) {
    skills = [{ id, name: "WF Skill", source, category: "image_gen", gen_image: true, gen_video: false }];
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id, name: "WF Skill", content: "正文", source,
        files: [{ name: "skill.md", size: 4 }, ...(workflow ? [{ name: "workflow.json", size: 9 }] : [])],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "正文" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ workflow }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["m.safetensors"], suggested_diffusion_models: "m.safetensors",
        text_encoders: ["t.safetensors"], suggested_text_encoders: "t.safetensors",
        vae: ["v.safetensors"], suggested_vae: "v.safetensors", loras: [],
    }));
    mockRoute("/object_info", () => jsonResponse({}));
}

async function openMgrWf(opts) {
    const { openSkillManager } = await import("../../web/skill.js");
    mockWfSkill(opts);
    openSkillManager();
    await flush();
    await sleep(120);
    await flush();
    const box = document.querySelector(".rs-skill-manager");
    return { box, wf: box.querySelector(".rs-skill-workflow") };
}

const modeBtn = (wf, text) => Array.from(wf.querySelectorAll(".rs-content-mode-btn")).find((b) => b.textContent.includes(text));
const wfBarBtn = (wf, text) => Array.from(wf.querySelectorAll(".rs-wf-editor-bar button")).find((b) => b.textContent.includes(text));

test("工作流区：渲染只读/编辑模式切换；前端无 LiteGraph 时隐藏「编辑」", async () => {
    const { box, wf } = await openMgrWf();
    assert.ok(wf, "带 workflow.json 的技能应渲染工作流区");
    assert.ok(modeBtn(wf, "流程图"), "应有只读流程图模式按钮");
    assert.ok(modeBtn(wf, "流程图").classList.contains("rs-content-mode-active"), "默认只读模式");
    assert.equal(modeBtn(wf, "编辑").style.display, "none", "无 LiteGraph 时应隐藏编辑按钮");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "编辑区默认隐藏");
    closeMgr(box);
});

test("内嵌编辑：灌入 workflow.json 模板挂 LGraphCanvas，只读流程图收起", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);

    assert.equal(created.graphs.length, 1, "应创建独立 LGraph 子图");
    assert.equal(created.canvases.length, 1, "应创建 LGraphCanvas");
    const lite = created.lite[0];
    assert.equal(lite.nodes.length, 2, "API prompt 应转成 litegraph 节点");
    assert.deepEqual(lite.nodes.map((n) => n.widgets_values), [["{{PROMPT}}", 0], ["", "{{SEED}}"]], "widget 值按名对齐模板顺序");
    assert.equal(created.graphs[0].started, true, "子图应 start()");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "flex", "编辑区应显示");
    assert.ok(wf.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas"), "canvas 应挂进盒子");
    assert.equal(modeBtn(wf, "编辑").classList.contains("rs-content-mode-active"), true);
    assert.equal(modeBtn(wf, "流程图").classList.contains("rs-content-mode-active"), false);
    assert.equal(wf.querySelector(".rs-wf-body").style.display, "none", "编辑模式收起只读流程图");
    assert.notEqual(wfBarBtn(wf, "保存工作流").style.display, "none", "自定义技能应显示保存按钮");
    closeMgr(box);
});

test("内嵌编辑：按 dpr 下发后备缓冲并重设前层变换（高分屏画布不被缩成一小块）", async () => {
    window.devicePixelRatio = 1.25;
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    // jsdom 无布局：盒子 clientWidth/Height 为 0，refit 走 800x420 兜底尺寸
    assert.deepEqual(created.canvases[0].size, [1000, 525], "resize 应收到 CSS 尺寸 × dpr");
    assert.equal(created.canvases[0].transform, 1.25, "前层 ctx 应按 dpr 重设变换");
    closeMgr(box);
    window.devicePixelRatio = 1;
});

test("内嵌编辑：widget 弹窗按视口坐标落点（画布在窗口里偏移时不飞到左上角）", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    const canvas = created.canvases[0];
    canvas.el.getBoundingClientRect = () => ({ left: 391, top: 415, width: 1119, height: 465, right: 1510, bottom: 880, x: 391, y: 415 });
    canvas.prompt("seed", 1, null, { clientX: 678, clientY: 684 });
    const dlg = canvas.prompt_box;
    assert.ok(dlg, "prompt 应生成弹窗");
    assert.equal(dlg.style.left, "658px", "弹窗应贴着鼠标（视口坐标），不应再减画布左上角偏移");
    assert.equal(dlg.style.top, "664px");
    closeMgr(box);
});


const WF_LINK_TEMPLATE = {
    "1": { class_type: "NeoPromptAgent", inputs: { prompt: "hi" }, _meta: { title: "A" } },
    "2": { class_type: "KSampler", inputs: { prompt: ["1", 0, "STRING"] }, _meta: { title: "B" } },
};

test("内嵌编辑：API 连线按槽位名转成 litegraph links", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf({ workflow: WF_LINK_TEMPLATE });
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    const lite = created.lite[0];
    assert.deepEqual(lite.links, [[1, 1, 0, 2, 0, "STRING"]], "连线应带 origin/slot/type");
    assert.equal(lite.nodes[1].inputs[0].link, 1, "目标输入槽应挂 link");
    assert.deepEqual(lite.nodes[0].outputs[0].links, [1], "源输出槽应登记 link");
    closeMgr(box);
});

test("内嵌编辑：节点类型未注册时拒绝进编辑（保存会丢节点）", async () => {
    const created = stubLiteGraph({ unregistered: ["KSampler"] });
    const { box, wf } = await openMgrWf();
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    assert.equal(created.graphs.length, 0, "未注册节点不应挂载子图");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "应留在只读模式");
    closeMgr(box);
});


test("内嵌编辑保存：graphToPrompt(子图) → update_workflow_skill → 回只读并卸载画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    let saved = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        saved = b;
        return jsonResponse({ success: true, id: "wf_demo", warnings: [] });
    });
    appState.promptGraph = { output: { "1": { class_type: "KSampler", inputs: { seed: 7 } } }, workflow: { "1": {} } };

    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    click(wfBarBtn(wf, "保存工作流"));
    await flush();
    await sleep(120);
    await flush();

    assert.ok(saved, "应发出 /neo_image_gen/update_workflow_skill");
    assert.equal(saved.skill_id, "wf_demo");
    assert.deepEqual(saved.workflow, appState.promptGraph.output);
    assert.equal(appState.promptGraphArg, created.graphs[0], "graphToPrompt 应收到内嵌子图");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "保存后回到只读模式");
    assert.equal(created.canvases[0].stopped, true, "内嵌画布应停止渲染并解绑事件");
    assert.equal(created.canvases[0].unbound, true, "内嵌画布应解绑事件");
    assert.equal(created.graphs[0]._nodes.length, 0, "子图节点应逐个 removeNode 卸载");
    assert.equal(created.graphs[0].cleared, true, "子图应 clear()");
    assert.equal(wf.querySelector(".rs-wf-editor-canvas-box").children.length, 0, "画布 DOM 应清空");
    closeMgr(box);
});

test("内嵌编辑：预设技能隐藏保存按钮；重新载入重建子图；适配视图重绘画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf({ id: "preset_wf", source: "presets" });
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    assert.equal(wfBarBtn(wf, "保存工作流").style.display, "none", "预设技能不应显示保存按钮");

    click(wfBarBtn(wf, "重新载入"));
    await flush();
    await sleep(50);
    assert.equal(created.graphs.length, 2, "重新载入应重建子图");
    assert.equal(created.canvases.length, 2, "重新载入应重建画布");
    assert.equal(created.canvases[0].stopped, true, "旧画布应卸载");

    click(wfBarBtn(wf, "适配视图"));
    assert.ok(created.canvases[1].drawn > 0, "适配视图应触发重绘");
    closeMgr(box);
});

test("内嵌编辑：折叠工作流区 / 切换技能 / 关闭窗口均卸载画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    click(modeBtn(wf, "编辑"));
    await flush();
    await sleep(50);
    assert.equal(created.canvases.length, 1);

    click(wf.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);
    assert.equal(created.canvases[0].stopped, true, "折叠工作流区应卸载画布");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none");

    // 切到无工作流的技能：旧画布不残留，工作流区收起
    skills = [{ id: "other", name: "Other", source: "custom", category: "image_gen" }];
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "other", name: "Other", content: "正文", source: "custom",
        files: [{ name: "skill.md", size: 4 }], gen_image: false, gen_video: false,
        requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    click(box.querySelector(".rs-skill-picker-item"));
    await flush();
    await sleep(80);
    assert.equal(created.canvases.length, 1, "切换技能不应残留画布");
    assert.equal(created.canvases[0].stopped, true, "切换技能应卸载旧画布");

    closeMgr(box);
    assert.ok(!document.querySelector(".rs-skill-manager-overlay"), "关闭窗口应移除整窗");
});

