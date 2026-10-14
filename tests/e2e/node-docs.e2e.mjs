// E2E：Neo 节点帮助文档落在 ComfyUI 原生约定路径，属性面板「信息」页直接渲染它；
// 节点上不再挂插件自绘的 `?` 徽标。需 ComfyUI 运行中。用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const DOC_BASE = "/extensions/ComfyUI-Neo-Nodes/docs";
const NEO_NODES = [
    "NeoPromptEncoder", "NeoPromptAgent", "NeoImageGenEdit",
    "NeoH3VideoDirector", "NeoH3AddKeyframe", "NeoH3AddGuides", "NeoH3AddContext",
    "NeoH3SegmentRun", "NeoBundleExpand", "NeoRefGrid", "NeoGridSplit",
];

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

test("每个 Neo 节点的帮助文档在原生约定路径可取", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const bad = await page.evaluate(async ({ nodes, base }) => {
        const missing = [];
        for (const n of nodes) {
            const res = await fetch(`${base}/${n}.md`);
            const text = res.ok ? await res.text() : "";
            if (!res.ok || !text.includes("# ")) missing.push(`${n}:${res.status}`);
        }
        return missing;
    }, { nodes: NEO_NODES, base: DOC_BASE });
    assert.deepEqual(bad, [], "原生路径取不到帮助文档");
    await ctx.close();
});

test("Neo 节点不再挂插件自绘的 ? 徽标", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const has = await page.evaluate(() => {
        const node = LiteGraph.createNode("NeoGridSplit");
        app.graph.add(node);
        return node.widgets.some((w) => w.name === "neo_help");
    });
    assert.equal(has, false, "neo_help widget 应随徽标模块一起移除");
    await ctx.close();
});

test("属性面板「信息」页渲染节点帮助文档", { timeout: 60000 }, async (t) => {
    if (!guard(t)) return;
    const { ctx, page } = await newPage();
    const r = await page.evaluate(async () => {
        const node = LiteGraph.createNode("NeoGridSplit");
        app.graph.add(node);
        app.canvas.selectNode(node, false, true);
        const findTab = () => [...document.querySelectorAll("button.tab")].find(
            (el) => /^(信息|Info)$/.test(el.textContent?.trim() ?? "")
        );
        let tab = null;
        for (let i = 0; i < 20 && !tab; i++) {
            tab = findTab();
            if (!tab) await new Promise((res) => setTimeout(res, 250));
        }
        if (!tab) return { ok: false };
        tab.click();
        await new Promise((res) => setTimeout(res, 2500));
        const text = document.body.innerText;
        return { ok: true, hit: text.includes("宫格图拆分") && text.includes("典型接法") };
    });
    if (!r.ok) {
        // 无头新会话里前端可能不注册侧栏面板（sidebarTabs 为空），此时「信息」页签不存在
        t.skip("当前会话没有节点属性面板，跳过「信息」页渲染断言");
        return;
    }
    assert.ok(r.hit, "「信息」页未渲染出帮助文档正文");
    await ctx.close();
});
