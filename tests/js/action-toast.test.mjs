// action toast（web/toast.js）：需用户处理的错误通知——不自动关闭，点 action 执行回调后关闭，✕ 手动关闭。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, sleep } from "./setup.mjs";

beforeEach(() => { resetEnv(); });

test("渲染：severity 色条类、summary/detail、action 与 ✕ 按钮", async () => {
    const { actionToast } = await import("../../web/toast.js");
    const { el } = actionToast({ severity: "warning", summary: "缺模型", detail: "1 个模型缺失", actionLabel: "查看详情" });
    assert.ok(el.classList.contains("neo-at-warning"), "severity 类名");
    assert.equal(el.querySelector(".neo-at-summary").textContent, "缺模型");
    assert.equal(el.querySelector(".neo-at-detail").textContent, "1 个模型缺失");
    assert.equal(el.querySelector(".neo-at-action").textContent, "查看详情");
    assert.ok(el.querySelector(".neo-at-close"), "✕ 关闭按钮");
});

test("不自动关闭：等待后仍在 DOM", async () => {
    const { actionToast } = await import("../../web/toast.js");
    const { el } = actionToast({ summary: "生图失败", detail: "模型缺失", actionLabel: "打开技能详情" });
    await sleep(80); // 内置 toast 5s 才消失；这里只验证没有更短的自动关闭逻辑
    assert.ok(el.parentNode, "action toast 不自动消失");
});

test("点 action：执行 onAction 后关闭", async () => {
    const { actionToast } = await import("../../web/toast.js");
    let called = null;
    const { el } = actionToast({ summary: "LLM 处理失败", detail: "401", actionLabel: "打开 LLM 设置", onAction: () => { called = true; } });
    el.querySelector(".neo-at-action").click();
    assert.equal(called, true, "onAction 被调用");
    await sleep(250); // 关闭有 200ms 淡出
    assert.ok(!el.parentNode, "点击 action 后关闭");
});

test("✕ 手动关闭；不影响同栈其他 toast", async () => {
    const { actionToast } = await import("../../web/toast.js");
    const a = actionToast({ summary: "第一条", actionLabel: "处理" });
    const b = actionToast({ summary: "第二条" });
    assert.equal(document.querySelectorAll(".neo-at").length, 2, "两条堆叠在同一栈");
    a.el.querySelector(".neo-at-close").click();
    await sleep(250);
    assert.ok(!a.el.parentNode, "✕ 关闭自己");
    assert.ok(b.el.parentNode, "不影响其他 toast");
});

test("无 actionLabel：不渲染 action 按钮", async () => {
    const { actionToast } = await import("../../web/toast.js");
    const { el } = actionToast({ summary: "普通提示" });
    assert.equal(el.querySelector(".neo-at-action"), null);
});
