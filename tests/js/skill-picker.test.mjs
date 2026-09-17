// 居中技能选择窗（替代原生 combo 下拉）：
// - 行内 👁 查看按钮按 skill **id** 打开详情（自定义可编辑、预设只读；combo 的 options.values 存的是 name，不能拿它去 load_skill）
// - 选中条目写回 combo 的合法 value（对齐 options.values，Krea2/H3 skill_id 为 name）并触发 callback
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click, keydown } from "./setup.mjs";

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

test("行内 Edit/查看按 skill id 打开详情（而非 combo 里的 name）", async () => {
    const { attachSkillPickerToComboWidget } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b && b.id;
        return jsonResponse({ id: b.id, name: "Loaded", content: "", files: [], gen_image: false, requires_ref: false, multi_turn: false, tags: [], category: "task" });
    });

    const widget = makeComboWidget("Alpha Skill");
    const node = makeNode();
    attachSkillPickerToComboWidget(widget, { title: "选择 Skill（测试）" });
    assert.equal(typeof widget.onPointerDown, "function", "attach 应设置 widget.onPointerDown（新版前端唯一能短路原生下拉的钩子）");
    assert.equal(widget.onPointerDown({ clientX: 100, clientY: 200 }, node, null), true, "onPointerDown 返回真值以抑制原生下拉");
    await sleep(30);

    const alphaRow = pickerRow("Alpha Skill");
    assert.ok(alphaRow, "应渲染 Alpha Skill 行");
    click(alphaRow.querySelector(".rs-skill-row-action"));
    await sleep(30);

    assert.equal(loadedId, "skill-id-a", "应按 skill id 打开详情，而非 combo 的 name");
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
    const panel = overlay.querySelector(".rs-skill-modal.rs-skill-picker");
    assert.ok(overlay.classList.contains("rs-skill-picker--anchored"), "锚定模式应加 anchored 类（去遮罩）");
    assert.equal(panel.style.position, "fixed", "面板改为 fixed 定位");
    assert.match(panel.style.left, /^\d+px$/, "left 应为像素值");
    const top = parseInt(panel.style.top, 10);
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
