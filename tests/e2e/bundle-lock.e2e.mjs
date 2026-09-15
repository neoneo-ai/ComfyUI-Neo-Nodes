// E2E：bundle 输入连线后禁用「以 bundle 为准」的控件（Director: recipe；Krea2: prompt/skill_id）。
// 需 ComfyUI 运行中。用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";

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

test("NeoNodes.BundleLock 扩展已注册", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const registered = await page.evaluate(() =>
        (app.extensions || []).some((e) => e.name === "NeoNodes.BundleLock"));
    assert.ok(registered, "bundle-lock.js 的 registerExtension 应执行成功");
    await ctx.close();
});

test("实时连线：连 bundle → recipe 置灰 + 时间轴隐藏，断开 → 恢复", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const r = await page.evaluate(async () => {
        const mk = (type) => { const n = LiteGraph.createNode(type); app.graph.add(n); return n; };
        const director = mk("NeoH3VideoDirector");
        const agent = mk("NeoPromptAgent");
        const recipe = director.widgets.find((w) => w.name === "recipe");
        const tlEl = director.widgets.find((w) => w.name === "director_timeline")?.element;
        const bIn = director.inputs.findIndex((i) => i.name === "bundle");
        const bOut = Math.max(0, agent.outputs.findIndex((o) => /bundle/i.test(o.name)));
        const snap = () => ({ disabled: recipe.disabled, tl: tlEl ? tlEl.style.display : null, h: director.size[1] });
        const before = snap();
        agent.connect(bOut, director, bIn);
        await new Promise((res) => setTimeout(res, 250));
        const afterConnect = snap();
        director.disconnectInput(bIn);
        await new Promise((res) => setTimeout(res, 250));
        const afterDisconnect = snap();
        return { before, afterConnect, afterDisconnect };
    });
    assert.equal(r.before.disabled, false, "初始未连 bundle 时 recipe 应可用");
    assert.notEqual(r.before.tl, "none", "初始时间轴应显示");
    assert.equal(r.afterConnect.disabled, true, "连上 bundle 后 recipe 应置灰");
    assert.equal(r.afterConnect.tl, "none", "连上 bundle 后时间轴应隐藏");
    assert.ok(r.afterConnect.h < r.before.h, "连上 bundle 后节点高度应收缩");
    assert.equal(r.afterDisconnect.disabled, false, "断开 bundle 后 recipe 应恢复");
    assert.notEqual(r.afterDisconnect.tl, "none", "断开 bundle 后时间轴应恢复显示");
    assert.ok(r.afterDisconnect.h >= r.before.h - 1, "断开 bundle 后节点高度应恢复");
    await ctx.close();
});

test("加载已连 bundle 的工作流：recipe 置灰", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const r = await page.evaluate(async () => {
        app.graph.clear();
        app.loadGraphData({
            last_node_id: 2,
            last_link_id: 1,
            nodes: [
                { id: 1, type: "NeoPromptAgent", pos: [0, 0], size: [320, 220], order: 0,
                    inputs: [], outputs: [{ name: "PROMPT", type: "STRING", links: null }, { name: "BUNDLE", type: "STRING", links: [1] }] },
                { id: 2, type: "NeoH3VideoDirector", pos: [400, 0], size: [320, 360], order: 1,
                    inputs: [{ name: "model", type: "MODEL", link: null }, { name: "bundle", type: "STRING", link: 1 }],
                    outputs: [{ name: "video", type: "VIDEO", links: null }] },
            ],
            links: [[1, 1, 1, 2, 1, "STRING"]],
        });
        await new Promise((res) => setTimeout(res, 600));
        const director = app.graph.getNodeById(2);
        const recipe = director?.widgets?.find((w) => w.name === "recipe");
        const tlEl = director?.widgets?.find((w) => w.name === "director_timeline")?.element;
        return { bundleLink: director?.inputs?.find((i) => i.name === "bundle")?.link, disabled: recipe?.disabled, tl: tlEl ? tlEl.style.display : null };
    });
    assert.ok(r.bundleLink != null, "工作流中 bundle 输入应已连接");
    assert.equal(r.disabled, true, "加载已连 bundle 的工作流后 recipe 应置灰");
    assert.equal(r.tl, "none", "加载已连 bundle 的工作流后时间轴应隐藏");
    await ctx.close();
});