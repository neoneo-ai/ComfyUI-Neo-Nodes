// E2E：prompt/skill 请求体关键链路验证（需 ComfyUI 运行中）。
// 用法：npm run e2e
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行，工作流文件存在。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const WORKFLOW_FILE = process.env.NEO_E2E_WORKFLOW ||
    path.resolve(__dirname, "../../../../user/default/workflows/MMH3/☆小脸不崩！打斗不糊！H3 sigma强化+潜空间放大工作流（不油啦！）.json");

let browser;
let skipReason;

test.before(async () => {
    if (!existsSync(WORKFLOW_FILE)) {
        skipReason = `工作流文件不存在: ${WORKFLOW_FILE}`;
        return;
    }
    try {
        const resp = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        skipReason = `ComfyUI 不可达 (${BASE}): ${e.message}`;
        return;
    }
    browser = await chromium.launch({ headless: true });
});

test.after(async () => {
    if (browser) await browser.close();
});

function guard(t) {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return false; }
    return true;
}

/** 加载工作流，通过 evaluate 直接操作 DOM（避免 headless 下节点面板折叠导致元素不可见） */
async function setupAndTrigger(page, { quickText = "测试", thinkingDepth = null } = {}) {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    const wfData = JSON.parse(readFileSync(WORKFLOW_FILE, "utf-8"));
    await page.evaluate((data) => { app.loadGraphData(data); }, wfData);
    await page.waitForTimeout(2000);

    // 切换思考深度（可选）
    if (thinkingDepth) {
        await page.evaluate((depth) => {
            const sel = document.querySelector("select.rs-thinking-depth-select");
            if (sel) { sel.value = depth; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        }, thinkingDepth);
    }

    // 设置快捷输入并触发生成
    await page.evaluate((text) => {
        const ta = document.querySelector("textarea.rs-quick-input");
        if (!ta) throw new Error("rs-quick-input not found");
        ta.value = text;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        // 模拟 Enter 触发生成
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }, quickText);
}

function captureRequest(page) {
    const captured = [];
    page.on("request", (req) => {
        if (req.method() === "POST" && req.url().includes("/rs_prompts/stream_generate_prompt")) {
            try { captured.push(JSON.parse(req.postData())); } catch {}
        }
    });
    return captured;
}

test("默认思考深度：请求体带 reasoning_effort=medium", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const captured = captureRequest(page);
    await setupAndTrigger(page, { quickText: "测试提示词" });
    await page.waitForTimeout(5000);
    await ctx.close();

    assert.ok(captured.length > 0, "应捕获到 stream_generate_prompt 请求");
    const body = captured[0];
    assert.equal(body.reasoning_effort, "medium", `reasoning_effort 应为 medium，实际: ${JSON.stringify(body.reasoning_effort)}`);
    assert.equal(body.enable_thinking, undefined, "off 以外不应有 enable_thinking");
});

test("思考深度 off：请求体带 enable_thinking=false", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const captured = captureRequest(page);
    await setupAndTrigger(page, { quickText: "测试 off", thinkingDepth: "off" });
    await page.waitForTimeout(5000);
    await ctx.close();

    assert.ok(captured.length > 0, "应捕获到请求");
    const body = captured[0];
    assert.equal(body.enable_thinking, false, "off 应发送 enable_thinking: false");
    assert.equal(body.reasoning_effort, undefined, "off 时不应有 reasoning_effort");
});

test("H3 工作流上下文：请求体 context 含 H3 节点和参考图", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const captured = captureRequest(page);
    await setupAndTrigger(page, { quickText: "测试 H3 上下文" });
    await page.waitForTimeout(5000);
    await ctx.close();

    assert.ok(captured.length > 0, "应捕获到请求");
    const body = captured[0];
    assert.ok(body.context, `context 不应为 null/undefined，实际: ${JSON.stringify(body.context)}`);
    assert.ok(Array.isArray(body.context.nodes), "context.nodes 应为数组");
    assert.ok(body.context.h3.length > 0, `context.h3 应包含 H3 节点，实际: ${body.context.h3?.length}`);
    const h3Types = body.context.h3.map(n => n.type);
    assert.ok(h3Types.some(ty => ty.includes("MiniMaxH3")), `应包含 MiniMaxH3 节点，实际: ${h3Types.join(", ")}`);
    if (body.context.references) {
        assert.ok(body.context.references.length > 0, "context.references 应包含参考图");
        const imgRefs = body.context.references.filter(r => r.kind === "image");
        assert.ok(imgRefs.length > 0, "应有图片参考");
    }
});

test("思考深度 high：请求体带 reasoning_effort=xhigh", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const captured = captureRequest(page);
    await setupAndTrigger(page, { quickText: "测试深度", thinkingDepth: "high" });
    await page.waitForTimeout(5000);
    await ctx.close();

    assert.ok(captured.length > 0, "应捕获到请求");
    const body = captured[0];
    assert.equal(body.reasoning_effort, "xhigh", `high 应映射为 xhigh，实际: ${body.reasoning_effort}`);
});