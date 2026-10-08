// E2E：技能管理独立窗口（Director 风格控件）+ 内嵌 litegraph 工作流编辑（需 ComfyUI 运行中）。
// 用法：npm run e2e   或   node --test --test-force-exit --test-timeout=180000 tests/e2e/skill-manager.e2e.mjs
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行且已加载 Neo-Nodes 插件。
// 只保留必须真浏览器才能验的核心用例（overlay 穿透与放大、内嵌画布挂载 + LoRA 灌值、combo 弹层层级、搜索框扛中文 IME 指针离开）；
// 标题栏拖动 / 把手拉伸 / 拖拽手势取消 / widget 弹窗落点由 tests/js/skill-manager.test.mjs 覆盖。
// 只读校验：预设技能「保存工作流」仅值覆盖，结构变更自动复制为自定义技能；测试全程不点保存，不写用户数据。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";

let browser;
let skipReason;

test.before(async () => {
    try {
        const resp = await fetch(`${BASE}/extensions/ComfyUI-Neo-Nodes/skill.js`, { signal: AbortSignal.timeout(4000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        skipReason = `ComfyUI / Neo-Nodes 不可达 (${BASE}): ${e.message}`;
        return;
    }
    browser = await chromium.launch({ headless: true });
});

test.after(async () => {
    if (browser) await browser.close();
});

async function openManagerPage(deviceScaleFactor = 1) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900, deviceScaleFactor } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // domcontentloaded + 显式选择器等待：ComfyUI 前端常驻轮询，networkidle 会白等十几秒
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#graph-canvas, .litegraph-canvas", { timeout: 30000 });
    // Neo 的 prompts.css 由插件异步注入（带 ?v= 时间戳）：不等它就读到无样式的 overlay，断言全飘
    await page.waitForFunction(
        () => [...document.styleSheets].some((s) => (s.href || "").includes("ComfyUI-Neo-Nodes/prompts.css")),
        { timeout: 20000 }
    );
    await page.evaluate(async () => {
        const m = await import("/extensions/ComfyUI-Neo-Nodes/skill.js");
        m.openSkillManager();
    });
    await page.waitForSelector(".rs-skill-manager .rs-skill-picker-item", { timeout: 20000 });
    return { page, errors };
}

const rect = (page, sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

// 整窗关闭只走「✕」：Esc 在窗口内被就地吞掉（内嵌画布 / 输入框 / 浮窗各管各的事），不会关掉整个窗口
const closeWithX = async (page) => {
    await page.click(".rs-skill-manager .rs-skill-modal-close");
    await page.waitForSelector(".rs-skill-manager", { state: "detached", timeout: 5000 });
};

test("技能管理窗口：透明穿透 overlay、⛶ 放大还原、标题栏双击放大、点窗口外不关闭、✕ 关闭", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage();
    try {
        const style = await page.locator(".rs-skill-manager-overlay").evaluate((el) => {
            const cs = getComputedStyle(el);
            return { bg: cs.backgroundColor, pe: cs.pointerEvents };
        });
        assert.equal(style.pe, "none", "overlay 应指针穿透（画布保持可操作）");
        assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(style.bg), `overlay 背景应透明，实际 ${style.bg}`);

        // ⛶ 放大 → 铺满视口（留 8px 边距）→ 还原；两次点击间隔拉开，避免浏览器合成 dblclick 叠加标题栏放大
        const before = await rect(page, ".rs-skill-manager");
        await page.click(".rs-skill-manager-maximize");
        const max = await rect(page, ".rs-skill-manager");
        const vp = page.viewportSize();
        assert.ok(Math.abs(max.w - (vp.width - 16)) <= 2, `放大宽应铺满视口，实际 ${max.w}`);
        assert.ok(Math.abs(max.h - (vp.height - 16)) <= 2, `放大高应铺满视口，实际 ${max.h}`);
        await page.waitForTimeout(700);
        await page.click(".rs-skill-manager-maximize");
        const restored = await rect(page, ".rs-skill-manager");
        assert.ok(Math.abs(restored.w - before.w) <= 2 && Math.abs(restored.h - before.h) <= 2,
            `还原应回到放大前尺寸：${before.w}x${before.h} → ${restored.w}x${restored.h}`);

        // 标题栏双击放大 / 双击还原
        await page.locator(".rs-skill-manager-head").dblclick({ position: { x: 24, y: 10 } });
        const dblMax = await rect(page, ".rs-skill-manager");
        assert.ok(Math.abs(dblMax.w - (vp.width - 16)) <= 2, `标题栏双击应放大，实际 ${dblMax.w}`);
        await page.locator(".rs-skill-manager-head").dblclick({ position: { x: 24, y: 10 } });
        const dblRestored = await rect(page, ".rs-skill-manager");
        assert.ok(Math.abs(dblRestored.w - before.w) <= 2, `标题栏再次双击应还原，实际 ${dblRestored.w}`);

        // 点窗口外（overlay 空白处）不关闭
        await page.mouse.click(4, 4);
        assert.equal(await page.locator(".rs-skill-manager").count(), 1, "点窗口外不应关闭");

        await closeWithX(page);
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

test("内嵌工作流编辑：展开工作流区直接挂画布（LoRA 槽位按 config.loras 灌值）", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage(1.25);
    const hasLiteGraph = await page.evaluate(() => !!window.LGraph && !!window.LGraphCanvas);
    if (!hasLiteGraph) { await page.close(); t.skip("前端未暴露 window.LGraph / LGraphCanvas，内嵌编辑不可用"); return; }
    try {
        // 选一个「模板带 {{LORA_i_*}} 槽位且 config.loras 非空」的技能：预设 workflow.json 把 LoRA 路径写死的
        // 技能验不到槽位灌值这条路径。左列表是手风琴，首屏只展开「生图」组，折叠组不渲染行 → 只在
        // image_gen 里挑；行文本是 cn_name。
        const loraSkill = await page.evaluate(async () => {
            const get = async (url) => (await (await fetch(url)).json());
            const list = await get("/api/rs_prompts/skills");
            for (const s of list) {
                if (!s.gen_image || s.category !== "image_gen") continue;
                const cfg = await get(`/api/neo_image_gen/skill_config?skill_id=${encodeURIComponent(s.id)}`);
                if (!(cfg.loras || []).length) continue;
                const wf = await get(`/api/neo_image_gen/skill_workflow?skill_id=${encodeURIComponent(s.id)}`);
                if (!/\{\{LORA_1_NAME\}\}/.test(JSON.stringify(wf))) continue;
                return { label: s.cn_name || s.name || s.id, source: s.source, loras: cfg.loras };
            }
            return null;
        });
        const row = loraSkill
            ? page.locator(".rs-skill-manager .rs-skill-picker-item", { hasText: loraSkill.label }).first()
            : page.locator(".rs-skill-manager .rs-skill-picker-item").first();
        await row.click();
        await page.waitForSelector(".rs-skill-workflow", { timeout: 20000 });
        assert.equal(await page.locator(".rs-skill-workflow .rs-content-mode-btn").count(), 0, "不应再有流程图/编辑切换按钮");

        // 打开技能默认折叠、不预挂画布；点头部展开才挂内嵌编辑画布（只读流程图退为回落路径）
        assert.ok(await page.locator(".rs-skill-workflow").evaluate((el) => el.classList.contains("rs-wf-collapsed")), "工作流区应默认折叠");
        assert.equal(await page.locator("canvas.rs-wf-editor-canvas").count(), 0, "折叠态不应预挂画布");
        // 内嵌画布实例只在构造时拿得到（canvas 元素上不挂 __litegraph）：展开前拦下 LGraphCanvas 取子图
        await page.evaluate(() => {
            window.__neoWfCanvases = [];
            const C = window.LGraphCanvas;
            window.LGraphCanvas = new Proxy(C, { construct: (T, a) => { const i = new T(...a); window.__neoWfCanvases.push(i); return i; } });
        });
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.waitForSelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas", { timeout: 20000 });
        await page.waitForTimeout(300);   // 挂载后 refit 在下一帧执行，等它把后备缓冲铺满盒子
        const layout = await page.evaluate(() => {
            const box = document.querySelector(".rs-wf-editor-canvas-box");
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            const b = box.getBoundingClientRect();
            const t = c.getContext("2d").getTransform();
            return { boxW: Math.round(b.width), boxH: Math.round(b.height), cw: Math.round(c.width / devicePixelRatio), ch: Math.round(c.height / devicePixelRatio), dpr: devicePixelRatio, sx: t.a, inBox: box.contains(c) };
        });
        assert.ok(layout.inBox, "canvas 应挂进盒子");
        assert.ok(layout.boxW > 200 && layout.boxH > 200, `画布盒子应有尺寸：${layout.boxW}x${layout.boxH}`);
        assert.ok(layout.cw >= layout.boxW - 4 && layout.ch >= layout.boxH - 4, `canvas 后备缓冲应铺满盒子：${layout.cw}x${layout.ch} vs ${layout.boxW}x${layout.boxH}`);
        assert.ok(Math.abs(layout.sx - layout.dpr) < 0.01, `前层 ctx 变换应等于 dpr（否则背景层只铺满 1/dpr 画布）：${layout.sx} vs ${layout.dpr}`);

        // converter 默认把每个节点写成 pos [0,0]，必须按 canvasLayout 排开；全叠在原点就是布局没跑
        const nodeLayout = await page.evaluate(() => {
            const nodes = window.__neoWfCanvases.at(-1).graph._nodes;
            return { nodes: nodes.length, spots: new Set(nodes.map((n) => `${Math.round(n.pos[0])},${Math.round(n.pos[1])}`)).size };
        });
        assert.ok(nodeLayout.nodes > 3, `内嵌画布应挂出多个节点：${nodeLayout.nodes}`);
        assert.ok(nodeLayout.spots === nodeLayout.nodes, `节点应排开不叠块：${nodeLayout.nodes} 节点 / ${nodeLayout.spots} 个位置`);

        // LoRA 槽位：画布 widget 必须显示 config.loras 的路径与强度，不能留 {{LORA_i_*}} 原串
        if (!loraSkill) t.diagnostic("无 config.loras 非空的生图技能，LoRA 灌值断言跳过");
        if (loraSkill) {
            t.diagnostic(`LoRA 灌值校验技能：${loraSkill.label} / ${loraSkill.loras.map((l) => l.name).join(", ")}`);
            const slots = await page.evaluate(() => window.__neoWfCanvases.at(-1).graph._nodes
                .filter((n) => n.type.startsWith("LoraLoader"))
                .map((n) => n.widgets.map((w) => w.value)));
            assert.ok(slots.length >= loraSkill.loras.length,
                `画布 LoRA 节点应覆盖 config.loras：${slots.length} vs ${loraSkill.loras.length}`);
            loraSkill.loras.forEach((entry, i) => {
                const [name, strength] = slots[i] || [];
                assert.equal(name, entry.name, `第 ${i + 1} 个 LoRA 槽位应显示 config 里的路径`);
                assert.equal(Number(strength), Number(entry.strength ?? 1), `第 ${i + 1} 个 LoRA 强度应等于 config`);
            });
        }

        const bar = await page.locator(".rs-wf-editor-bar").evaluateAll((els) => els.map((e) => e.textContent.trim()));
        assert.ok(bar.some((x) => x.includes("适配视图")), "应有适配视图按钮");
        assert.ok(bar.some((x) => x.includes("重新载入")), "应有重新载入按钮");
        const saveBtn = page.locator(".rs-wf-editor-bar button", { hasText: "保存工作流" });
        assert.notEqual(await saveBtn.evaluate((el) => getComputedStyle(el).display), "none", "应显示保存工作流按钮");
        if (loraSkill && loraSkill.source === "presets") {
            assert.ok((await saveBtn.evaluate((el) => el.title)).includes("自动复制为自定义技能"),
                "预设保存按钮应说明结构变更自动复制");
        }

        // 适配视图 + 窗口缩放后跟随
        await page.locator(".rs-wf-editor-bar button", { hasText: "适配视图" }).click();
        await page.screenshot({ path: "tmp/skill-wf-editor.png" });
        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForTimeout(400);
        const resized = await page.evaluate(() => {
            const b = document.querySelector(".rs-wf-editor-canvas-box").getBoundingClientRect();
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            return { boxW: Math.round(b.width), boxH: Math.round(b.height), cw: Math.round(c.width / devicePixelRatio), ch: Math.round(c.height / devicePixelRatio) };
        });
        assert.ok(Math.abs(resized.cw - resized.boxW) <= 4 && Math.abs(resized.ch - resized.boxH) <= 4,
            `窗口缩放后 canvas 应跟随盒子尺寸：${resized.cw}x${resized.ch} vs ${resized.boxW}x${resized.boxH}`);

        // ⛶ 放大：盒子尺寸变化不触发 window resize，画布应靠 ResizeObserver 跟随
        await page.locator(".rs-skill-manager-maximize").click();
        await page.waitForTimeout(400);
        const maxed = await page.evaluate(() => {
            const b = document.querySelector(".rs-wf-editor-canvas-box").getBoundingClientRect();
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            return { boxW: Math.round(b.width), boxH: Math.round(b.height), cw: Math.round(c.width / devicePixelRatio), ch: Math.round(c.height / devicePixelRatio) };
        });
        assert.ok(maxed.boxW > resized.boxW + 8, `放大后盒子应更宽：${resized.boxW} → ${maxed.boxW}`);
        assert.ok(Math.abs(maxed.cw - maxed.boxW) <= 4 && Math.abs(maxed.ch - maxed.boxH) <= 4,
            `⛶ 放大后 canvas 应跟随盒子尺寸：${maxed.cw}x${maxed.ch} vs ${maxed.boxW}x${maxed.boxH}`);
        await page.locator(".rs-skill-manager-maximize").click();   // 还原
        await page.waitForTimeout(400);

        // 折叠工作流区 → 画布卸载；再展开 → 重挂内嵌画布
        await page.click(".rs-skill-workflow-head .rs-form-label");
        assert.equal(await page.locator("canvas.rs-wf-editor-canvas").count(), 0, "折叠应卸载画布");
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.waitForSelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas", { timeout: 20000 });
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

test("内嵌工作流编辑：combo 下拉浮在技能弹窗之上并可点选（125% 缩放）", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage(1.25);
    const hasLiteGraph = await page.evaluate(() => !!window.LGraph && !!window.LGraphCanvas);
    if (!hasLiteGraph) { await page.close(); t.skip("前端未暴露 window.LGraph / LGraphCanvas，编辑模式按设计隐藏"); return; }
    try {
        await page.locator(".rs-skill-manager .rs-skill-picker-item").first().click();
        await page.waitForSelector(".rs-skill-workflow", { timeout: 20000 });
        await page.click(".rs-skill-workflow-head .rs-form-label");   // 默认折叠：展开才挂画布
        await page.waitForSelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas", { timeout: 20000 });
        await page.waitForTimeout(1200);

        const target = await page.evaluate(() => {
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            const inst = c.data;
            const cr = c.getBoundingClientRect();
            for (const n of inst.graph._nodes) {
                for (const w of n.widgets || []) {
                    if (w.type !== "combo") continue;
                    const x = (n.pos[0] + 60 + inst.ds.offset[0]) * inst.ds.scale + cr.left;
                    const y = (n.pos[1] + (w.y ?? w.last_y) + inst.ds.offset[1]) * inst.ds.scale + cr.top;
                    if (x < cr.left + 8 || x > cr.right - 8 || y < cr.top + 8 || y > cr.bottom - 8) continue;
                    return { name: w.name, x, y };
                }
            }
            return null;
        });
        assert.ok(target, "画布上应有可视的 combo widget");

        await page.mouse.click(target.x, target.y);
        await page.waitForSelector(".litecontextmenu", { timeout: 5000 });
        const menu = await page.evaluate(() => {
            const el = document.querySelector(".litecontextmenu");
            const r = el.getBoundingClientRect();
            const overlay = document.querySelector(".rs-skill-manager-overlay");
            const top = document.elementFromPoint(r.x + Math.min(40, r.width / 2), r.y + Math.min(16, r.height / 2));
            return {
                z: Number(getComputedStyle(el).zIndex),
                overlayZ: Number(getComputedStyle(overlay).zIndex),
                items: el.querySelectorAll(".litemenu-entry").length,
                inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
                hitInMenu: !!top && el.contains(top),
                hit: top ? top.tagName + "." + (top.className || "") : null,
            };
        });
        assert.ok(menu.items > 0, "combo 下拉应有条目");
        assert.ok(menu.inViewport, `下拉应完整落在视口内，实际 ${JSON.stringify(menu)}`);
        assert.ok(menu.z > menu.overlayZ, `LiteGraph 弹层应高于技能弹窗：${menu.z} vs ${menu.overlayZ}`);
        assert.ok(menu.hitInMenu, `落点应命中下拉自身而非技能弹窗，实际 ${menu.hit}`);
        await page.screenshot({ path: "tmp/skill-wf-combo-menu.png" });
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});


test("内嵌工作流编辑：双击空白开搜索框，中文输入 + IME 指针离开后搜索框保持打开，Enter 落进内嵌子图，Esc 关闭", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage();
    const hasLiteGraph = await page.evaluate(() => !!window.LGraph && !!window.LGraphCanvas);
    if (!hasLiteGraph) { await page.close(); t.skip("前端未暴露 window.LGraph / LGraphCanvas，编辑模式按设计隐藏"); return; }
    try {
        await page.locator(".rs-skill-manager .rs-skill-picker-item").first().click();
        await page.waitForSelector(".rs-skill-workflow", { timeout: 20000 });
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.waitForSelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas", { timeout: 20000 });
        await page.waitForTimeout(1200);

        const spot = await page.evaluate(() => {
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            const inst = c.data;
            const cr = c.getBoundingClientRect();
            const taken = inst.graph._nodes.map((n) => ({
                x: (n.pos[0] + n.size[0] + inst.ds.offset[0]) * inst.ds.scale + cr.left,
                y: (n.pos[1] + n.size[1] + inst.ds.offset[1]) * inst.ds.scale + cr.top,
            }));
            for (let y = cr.top + 20; y < cr.bottom - 20; y += 20) {
                for (let x = cr.left + 20; x < cr.right - 20; x += 20) {
                    if (document.elementFromPoint(x, y) === c && !taken.some((p) => x < p.x + 4 && y < p.y + 4)) return { x, y };
                }
            }
            return null;
        });
        assert.ok(spot, "内嵌画布应有可双击的空白处");
        const before = await page.evaluate(() => document.querySelector("canvas.rs-wf-editor-canvas").data.graph._nodes.length);

        await page.mouse.move(spot.x, spot.y);
        await page.mouse.click(spot.x, spot.y);
        await page.mouse.dblclick(spot.x, spot.y);
        await page.waitForSelector(".litegraph.litesearchbox", { timeout: 5000 });

        // 中文 IME 候选窗是原生浮层：聚焦搜索框后输入中文，再模拟候选窗造成的指针离开（原行为 500ms 后自动关闭）
        await page.keyboard.type("K采样器");
        await page.evaluate(() => document.querySelector(".litegraph.litesearchbox")
            .dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })));
        await page.waitForTimeout(600);

        const box = await page.evaluate(() => {
            const el = document.querySelector(".litegraph.litesearchbox");
            return {
                open: !!el,
                value: el ? el.querySelector("input[type=text]").value : null,
                results: el ? el.querySelectorAll(".litegraph.lite-search-item").length : 0,
            };
        });
        assert.ok(box.open, "中文输入 + 指针离开后搜索框应保持打开");
        assert.equal(box.value, "K采样器", "搜索框应收到中文输入");
        assert.ok(box.results > 0, `中文搜索应有候选结果，实际 ${box.results}`);

        await page.keyboard.press("Enter");
        const after = await page.evaluate(() => document.querySelector("canvas.rs-wf-editor-canvas").data.graph._nodes.length);
        assert.equal(after, before + 1, "新增节点应落进内嵌子图而非主画布");

        await page.keyboard.press("Escape");
        await page.waitForSelector(".litegraph.litesearchbox", { state: "detached", timeout: 5000 });
        await page.screenshot({ path: "tmp/skill-wf-searchbox.png" });
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

