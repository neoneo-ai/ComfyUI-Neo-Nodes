// 统一技能管理窗口（顶栏 🅝 菜单「🗂 技能管理」）：左侧技能列表（搜索 + 分类分组）+ 右侧内嵌详情。
// 覆盖：开窗布局 / 点击切换详情 / 搜索过滤 / 关闭整窗 / rs.skills.updated 刷新 / 未保存修改切换确认。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, flush, sleep, click, inputText, setConfirmAnswer, dialogs } from "./setup.mjs";

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
        gen_image: false, gen_video: false, multi_turn: false, tags: [], category: "",
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

test("打开技能管理窗口：左侧列表按分类分组，右侧内嵌详情并默认选中第一项", async () => {
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
    assert.ok(box.querySelector(".rs-skill-picker-item.is-selected"), "应有选中高亮行");
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
    const labels = () => Array.from(list.querySelectorAll(".rs-skill-picker-item")).map((r) => r.textContent.trim());
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

