// 实机验证脚本：NeoRefGrid 前端（创建节点 / 宫格 DOM / refs 持久化 / autogrow 初始态）
import { chromium } from "../node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

mkdirSync("test-results", { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8188", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

const result = await page.evaluate(async () => {
    const out = {};
    try {
        // 1) 走 LiteGraph 正常路径创建节点（graph.add 会触发 onNodeCreated 钩子）
        const node = LiteGraph.createNode("NeoRefGrid");
        app.graph.add(node);
        await new Promise((r) => setTimeout(r, 500));
        out.hasApi = !!node._neoRg;
        out.widgetNames = (node.widgets || []).map((w) => w.name);
        out.outputs = node.outputs.map((o) => o.name);
        const el = node.widgets.find((x) => x.name === "ref_grid_view")?.element;
        out.gridDom = !!el?.querySelector(".neo-rg-grid");
        out.cells = el?.querySelectorAll(".neo-rg-cell")?.length;
        // 2) 程序化填两张图，验证 DOM + refs widget 同步
        node._neoRg.setAssets(["003.png", "008.png"]);
        out.tiles = el.querySelectorAll(".neo-rg-thumb").length;
        out.countText = el.querySelector(".neo-rg-count")?.textContent;
        out.refsWidget = node.widgets.find((x) => x.name === "refs")?.value;
        // 3) 序列化验证：refs 进入 API prompt（随工作流持久化）
        const p = await app.graphToPrompt();
        const entry = p.output[String(node.id)];
        out.serializedRefs = entry?.inputs?.refs ?? null;
        out.serializedClass = entry?.class_type ?? null;
        // 4) 节点挪到左上角便于截图
        node.pos = [40, 40];
        (app.canvas || LiteGraph.canvas)?.draw(true, true);
    } catch (e) {
        out.error = `${e.name}: ${e.message}`;
    }
    return out;
});
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: "test-results/ref-grid-live.png" });
const jsErrors = errors.filter((e) => !e.includes("favicon") && !e.includes("404"));
console.log("CONSOLE_ERRORS:", JSON.stringify(jsErrors));
await browser.close();