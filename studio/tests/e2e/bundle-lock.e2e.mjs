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

test("实时连线：连 bundle → recipe 隐藏 + 时间轴隐藏，断开 → 恢复", { timeout: 60000 }, async (t) => {
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
        // 时间轴行 / 操作条由 director-node.js 直接置 display:none；节点 DOM 层在离屏时整块隐藏，
        // 所以只看行自身的 inline style，不看页面渲染状态。
        const tlHidden = () => tlEl?.querySelector(".neo-dtl-tlrow")?.style.display === "none";
        const actHidden = () => tlEl?.querySelector(".neo-dtl-actbar")?.style.display === "none";
        const snap = () => ({ locked: recipe.hidden === true, tlHidden: tlHidden(), actHidden: actHidden(), h: director.size[1] });
        const before = snap();
        agent.connect(bOut, director, bIn);
        await new Promise((res) => setTimeout(res, 250));
        const afterConnect = snap();
        director.disconnectInput(bIn);
        await new Promise((res) => setTimeout(res, 250));
        const afterDisconnect = snap();
        return { before, afterConnect, afterDisconnect };
    });
    assert.equal(r.before.locked, false, "初始未连 bundle 时 recipe 应可用");
    assert.equal(r.before.tlHidden, false, "初始时间轴应显示");
    assert.equal(r.before.actHidden, false, "初始操作条应显示");
    assert.equal(r.afterConnect.locked, true, "连上 bundle 后 recipe 应隐藏（单段模式换用视频 skill）");
    assert.equal(r.afterConnect.tlHidden, true, "连上 bundle 后时间轴应隐藏");
    assert.equal(r.afterConnect.actHidden, true, "连上 bundle 后操作条应隐藏");
    assert.ok(r.afterConnect.h < r.before.h, "连上 bundle 后节点高度应收缩");
    assert.equal(r.afterDisconnect.locked, false, "断开 bundle 后 recipe 应恢复");
    assert.equal(r.afterDisconnect.tlHidden, false, "断开 bundle 后时间轴应恢复显示");
    assert.equal(r.afterDisconnect.actHidden, false, "断开 bundle 后操作条应恢复显示");
    assert.ok(r.afterDisconnect.h >= r.before.h - 1, "断开 bundle 后节点高度应恢复");
    await ctx.close();
});

test("加载已连 bundle 的工作流：recipe 置灰", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const r = await page.evaluate(async () => {
        // 现场连线再序列化回灌：bundle 落在节点定义的哪个槽位都不影响用例。
        app.graph.clear();
        const agent = LiteGraph.createNode("NeoPromptAgent");
        app.graph.add(agent);
        const director = LiteGraph.createNode("NeoH3VideoDirector");
        app.graph.add(director);
        const bIn = director.inputs.findIndex((i) => i.name === "bundle");
        const bOut = agent.outputs.findIndex((o) => /bundle/i.test(o.name));
        agent.connect(bOut, director, bIn);
        await new Promise((res) => setTimeout(res, 300));
        const saved = app.graph.serialize();
        app.graph.clear();
        app.loadGraphData(saved);
        await new Promise((res) => setTimeout(res, 600));
        const d2 = app.graph.getNodeById(director.id);
        const recipe = d2?.widgets?.find((w) => w.name === "recipe");
        const tlEl = d2?.widgets?.find((w) => w.name === "director_timeline")?.element;
        const tlHidden = tlEl?.querySelector(".neo-dtl-tlrow")?.style.display === "none";
        return { bundleLink: d2?.inputs?.find((i) => i.name === "bundle")?.link, hidden: recipe?.hidden === true, tlHidden };
    });
    assert.ok(r.bundleLink != null, "工作流中 bundle 输入应已连接");
    assert.equal(r.hidden, true, "加载已连 bundle 的工作流后 recipe 应隐藏");
    assert.equal(r.tlHidden, true, "加载已连 bundle 的工作流后时间轴应隐藏");
    await ctx.close();
});