// combo Esc 回归：下拉列表开着时 Esc 只消费在「关列表」（stopPropagation），不冒泡到
// document 级外层处理器（设置菜单等）；列表已关则照常冒泡，第二次 Esc 交给外层。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetEnv, window as testWindow } from "./setup.mjs";

test("combo：Esc 列表开着只关列表不冒泡；列表已关则冒泡", async () => {
    resetEnv();
    const { attachComboBox } = await import("../../web/combo-box.js");

    const select = document.createElement("select");
    for (const v of ["a", "b"]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
    }
    document.body.appendChild(select);
    const { box, destroy } = attachComboBox(select);
    document.body.appendChild(box);

    let docSawEscape = 0;
    const onDocKey = (e) => { if (e.key === "Escape") docSawEscape++; };
    document.addEventListener("keydown", onDocKey);

    const inputEl = box.querySelector("input");
    // 点击框体展开全量列表
    inputEl.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    assert.notEqual(document.querySelector(".rs-combo-list").style.display, "none", "点击应展开列表");

    // 第一次 Esc：关列表并被消费，不得冒泡到 document 级外层处理器
    inputEl.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector(".rs-combo-list").style.display, "none", "Esc 应关闭列表");
    assert.equal(docSawEscape, 0, "列表开着时 Esc 不得冒泡到外层处理器");

    // 第二次 Esc（列表已关）：照常冒泡，交给外层（如设置菜单的放弃并关闭）
    inputEl.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(docSawEscape, 1, "列表已关时 Esc 应冒泡到外层处理器");

    document.removeEventListener("keydown", onDocKey);
    destroy();
});

test("combo：列表盖过技能选择窗遮罩，且整条 Neo 阶梯低于 LiteGraph 弹层（9999）", async () => {
    resetEnv();
    const { attachComboBox } = await import("../../web/combo-box.js");

    const select = document.createElement("select");
    const o = document.createElement("option");
    o.value = "a";
    o.textContent = "a";
    select.appendChild(o);
    document.body.appendChild(select);
    const { destroy } = attachComboBox(select);
    const listZ = Number(document.querySelector(".rs-combo-list").style.zIndex);

    // 遮罩层级从真实 CSS 取，避免两处数字各写一份
    const css = readFileSync(new URL("../../web/prompts.css", import.meta.url), "utf8");
    const overlayZ = Number(/\.rs-skill-modal-overlay\s*\{[^}]*?z-index:\s*(\d+)/.exec(css)[1]);

    // 列表挂在 body 上：技能详情弹窗（.rs-skill-modal-overlay）内打开时也必须可见
    assert.ok(listZ > overlayZ, `combo 列表 z-index 必须高于 prompts.css .rs-skill-modal-overlay：${listZ} vs ${overlayZ}`);
    // 内嵌 LiteGraph 画布的 combo / 文件选择弹窗（.litecontextmenu = 9999）要能浮在技能弹窗之上
    assert.ok(listZ < 9999, `Neo 阶梯必须整条低于 LiteGraph 弹层 9999，实际 ${listZ}`);
    destroy();
});
