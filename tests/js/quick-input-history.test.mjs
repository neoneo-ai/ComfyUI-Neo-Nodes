// L1：快捷输入命令终端式 ↑/↓ 历史共享模块（createQuickInputHistory）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, keydown, inputText } from "./setup.mjs";
import { createQuickInputHistory } from "../../web/quick-input-history.js";

const KEY = "neo.test.quick_history";

function makeInput(value = "") {
    const el = document.createElement("textarea");
    el.value = value;
    document.body.appendChild(el);
    return el;
}

beforeEach(() => {
    resetEnv();
    localStorage.clear();
});

test("↑ 从最近一条依次召回，↓ 逐条前进并回到导航前草稿", () => {
    const el = makeInput("draft");
    const h = createQuickInputHistory(el, { storageKey: KEY });
    h.record("old");
    h.record("new");

    keydown(el, "ArrowUp");
    assert.equal(el.value, "new");
    keydown(el, "ArrowUp");
    assert.equal(el.value, "old");
    keydown(el, "ArrowDown");
    assert.equal(el.value, "new");
    keydown(el, "ArrowDown");
    assert.equal(el.value, "draft");
});

test("记录去重、最新在前，超上限裁剪", () => {
    const el = makeInput();
    const h = createQuickInputHistory(el, { storageKey: KEY, cap: 3 });
    h.record("a");
    h.record("b");
    h.record("a");
    h.record("c");
    h.record("d");
    assert.deepEqual(JSON.parse(localStorage.getItem(KEY)), ["d", "c", "a"]);
});

test("历史持久化在 localStorage，新输入框可召回", () => {
    const el1 = makeInput();
    createQuickInputHistory(el1, { storageKey: KEY }).record("persisted");

    const el2 = makeInput();
    createQuickInputHistory(el2, { storageKey: KEY });
    keydown(el2, "ArrowUp");
    assert.equal(el2.value, "persisted");
});

test("编辑（input 事件）退出导航态，当前内容成为新草稿", () => {
    const el = makeInput("draft");
    const h = createQuickInputHistory(el, { storageKey: KEY });
    h.record("old");

    keydown(el, "ArrowUp");
    assert.equal(el.value, "old");
    inputText(el, "old edited");
    keydown(el, "ArrowDown");   // 已退出导航态，不再变化
    assert.equal(el.value, "old edited");
});

test("多行文本：仅在第一/最后一行响应方向键", () => {
    const el = makeInput("line1\nline2\nline3");
    const h = createQuickInputHistory(el, { storageKey: KEY });
    h.record("old");

    el.setSelectionRange(7, 7);   // line2 中间
    keydown(el, "ArrowUp");
    assert.equal(el.value, "line1\nline2\nline3", "中间行不应召回");
});

test("带修饰键的方向键忽略", () => {
    const el = makeInput("");
    const h = createQuickInputHistory(el, { storageKey: KEY });
    h.record("old");

    keydown(el, "ArrowUp", { ctrlKey: true });
    assert.equal(el.value, "");
});

test("空历史时 ↑ 无动作；空白记录不入史", () => {
    const el = makeInput("draft");
    const h = createQuickInputHistory(el, { storageKey: KEY });
    keydown(el, "ArrowUp");
    assert.equal(el.value, "draft");

    h.record("   ");
    assert.equal(localStorage.getItem(KEY), null);
});
