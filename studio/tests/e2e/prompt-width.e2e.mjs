// E2E：prompt_ui DOM widget 宽度必须跟节点宽度一致。
// LiteGraph 的 size setter 不触发 onResize，工作流 configure 还原宽度时插件要补同步。
// 需 ComfyUI 运行中。用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const PROMPT_NODES = ["NeoPromptAgent", "NeoPromptEncoder"];

let browser;
let skipReason;

test.before(async () => {
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

async function newPage() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForFunction(() => !!window.app && !!app.graph, null, { timeout: 20000 });
    await page.waitForTimeout(1000);
    return { ctx, page };
}

test("prompt_ui 宽度跟随节点宽度（创建 / setSize / configure）", { timeout: 90000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const rows = await page.evaluate(async (nodes) => {
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const snap = (n) => ({ size: n.size[0], w: n.widgets.find((w) => w.name === "prompt_ui")?.width });
        const out = [];
        for (const type of nodes) {
            const node = LiteGraph.createNode(type);
            app.graph.add(node);
            await sleep(1200);
            const created = snap(node);
            node.setSize([420, 320]);
            const resized = snap(node);
            const data = node.serialize();
            data.size = [500, 360];
            node.configure(data);
            await sleep(200);
            out.push({ type, created, resized, configured: snap(node) });
        }
        return out;
    }, PROMPT_NODES);

    for (const { type, created, resized, configured } of rows) {
        assert.equal(created.w, created.size, `${type} 创建后 widget 宽度未跟节点宽度`);
        assert.equal(resized.w, resized.size, `${type} setSize 后 widget 宽度未跟节点宽度`);
        assert.equal(configured.size, 500, `${type} configure 未还原节点宽度`);
        assert.equal(configured.w, configured.size, `${type} configure 还原宽度后 widget 宽度未跟上`);
    }
    await ctx.close();
});
