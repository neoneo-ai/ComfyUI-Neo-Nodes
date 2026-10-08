// E2E：技能管理独立窗口（Director 风格控件）+ 内嵌 litegraph 工作流编辑（需 ComfyUI 运行中）。
// 用法：npm run e2e   或   node --test --test-force-exit --test-timeout=180000 tests/e2e/skill-manager.e2e.mjs
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行且已加载 Neo-Nodes 插件。
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
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForSelector("#graph-canvas, .litegraph-canvas", { timeout: 30000 });
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

const closeWithEsc = async (page) => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".rs-skill-manager", { state: "detached", timeout: 5000 });
};

test("技能管理窗口：透明穿透 overlay、⛶ 放大还原、标题栏双击放大、点窗口外不关闭、Esc 关闭", async (t) => {
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

        await closeWithEsc(page);
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

test("技能管理窗口：标题栏拖动移动窗口、右下角把手拉伸尺寸", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage();
    try {
        const before = await rect(page, ".rs-skill-manager");
        const head = await page.locator(".rs-skill-manager-head").boundingBox();
        // 往左上拖：窗口保持完整在视口内，右下角把手才可点
        await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
        await page.mouse.down();
        await page.mouse.move(head.x + head.width / 2 - 20, head.y + head.height / 2 - 20, { steps: 6 });
        await page.mouse.up();
        const moved = await rect(page, ".rs-skill-manager");
        assert.ok(moved.x < before.x - 10 && moved.y < before.y - 10,
            `标题栏拖动应移动窗口：${before.x},${before.y} → ${moved.x},${moved.y}`);

        const preSize = await rect(page, ".rs-skill-manager");
        const grip = await page.locator(".rs-skill-manager-resize").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 - 160, grip.y + grip.height / 2 - 140, { steps: 6 });
        await page.mouse.up();
        const shrunk = await rect(page, ".rs-skill-manager");
        assert.ok(shrunk.w < preSize.w - 100 && shrunk.h < preSize.h - 100,
            `把手向内拖拽应缩小窗口：${preSize.w}x${preSize.h} → ${shrunk.w}x${shrunk.h}`);

        const grip2 = await page.locator(".rs-skill-manager-resize").boundingBox();
        await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip2.x + grip2.width / 2 + 120, grip2.y + grip2.height / 2 + 100, { steps: 6 });
        await page.mouse.up();
        const grown = await rect(page, ".rs-skill-manager");
        assert.ok(grown.w > shrunk.w + 80 && grown.h > shrunk.h + 80,
            `把手向外拖拽应放大窗口：${shrunk.w}x${shrunk.h} → ${grown.w}x${grown.h}`);

        await closeWithEsc(page);
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

// 浏览器取消拖拽手势（pointercancel，无 pointerup）时，拖拽监听器必须失效：
// 否则松手后窗口继续跟随鼠标（右下角把手 / 标题栏同一缺陷）
test("技能管理窗口：拖拽手势被取消后不再跟随鼠标", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage();
    try {
        const cancel = (sel) => page.locator(sel).evaluate((el) => {
            el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true, cancelable: true }));
        });

        const grip = await page.locator(".rs-skill-manager-resize").boundingBox();
        const gx = grip.x + grip.width / 2, gy = grip.y + grip.height / 2;
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        await page.mouse.move(gx - 120, gy - 100, { steps: 6 });
        const dragged = await rect(page, ".rs-skill-manager");
        await cancel(".rs-skill-manager-resize");
        await page.mouse.move(gx - 300, gy - 260, { steps: 8 });
        await page.mouse.move(gx - 320, gy - 280, { steps: 4 });
        assert.deepEqual(await rect(page, ".rs-skill-manager"), dragged, "把手手势取消后尺寸应冻结");
        await page.mouse.up();

        const head = await page.locator(".rs-skill-manager-head").boundingBox();
        const hx = head.x + head.width / 2, hy = head.y + head.height / 2;
        await page.mouse.move(hx, hy);
        await page.mouse.down();
        await page.mouse.move(hx - 60, hy - 40, { steps: 6 });
        const moved = await rect(page, ".rs-skill-manager");
        await cancel(".rs-skill-manager-head");
        await page.mouse.move(hx - 200, hy - 150, { steps: 8 });
        assert.deepEqual(await rect(page, ".rs-skill-manager"), moved, "标题栏手势取消后位置应冻结");
        await page.mouse.up();

        await closeWithEsc(page);
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});


test("内嵌工作流编辑：只读流程图 ⇄ 编辑画布（预设技能隐藏保存）", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage(1.25);
    const hasLiteGraph = await page.evaluate(() => !!window.LGraph && !!window.LGraphCanvas);
    if (!hasLiteGraph) { await page.close(); t.skip("前端未暴露 window.LGraph / LGraphCanvas，编辑模式按设计隐藏"); return; }
    try {
        await page.locator(".rs-skill-manager .rs-skill-picker-item").first().click();
        await page.waitForSelector(".rs-skill-workflow .rs-content-mode-btn", { timeout: 20000 });

        const modeTexts = await page.locator(".rs-skill-workflow .rs-content-mode-btn").evaluateAll((els) => els.map((e) => e.textContent.trim()));
        assert.ok(modeTexts.some((x) => x.includes("流程图")), "应有只读流程图模式按钮");
        const editBtn = page.locator(".rs-skill-workflow .rs-content-mode-btn", { hasText: "编辑" });
        assert.notEqual(await editBtn.evaluate((el) => getComputedStyle(el).display), "none", "前端有 LiteGraph 时「编辑」应可见");

        // 展开折叠的工作流区 → 只读流程图渲染
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.waitForSelector(".rs-skill-workflow .rs-wf-body", { state: "visible", timeout: 20000 });
        await page.waitForFunction(() => document.querySelectorAll(".rs-skill-workflow .rs-wf-body svg.rs-wf-svg").length > 0, null, { timeout: 20000 });

        // 切编辑：内嵌画布获得真实尺寸
        await editBtn.click();
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

        const bar = await page.locator(".rs-wf-editor-bar").evaluateAll((els) => els.map((e) => e.textContent.trim()));
        assert.ok(bar.some((x) => x.includes("适配视图")), "应有适配视图按钮");
        assert.ok(bar.some((x) => x.includes("重新载入")), "应有重新载入按钮");
        const saveBtn = page.locator(".rs-wf-editor-bar button", { hasText: "保存工作流" });
        assert.notEqual(await saveBtn.evaluate((el) => getComputedStyle(el).display), "none", "预设技能应显示保存按钮（结构变更自动复制为自定义技能）");
        assert.ok((await saveBtn.evaluate((el) => el.title)).includes("自动复制为自定义技能"),
            "预设保存按钮应说明结构变更自动复制");

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

        // 切回只读 → 画布卸载
        await page.locator(".rs-skill-workflow .rs-content-mode-btn", { hasText: "流程图" }).click();
        assert.equal(await page.locator("canvas.rs-wf-editor-canvas").count(), 0, "切回只读应卸载画布");
        assert.equal(errors.length, 0, `页面不应报错：${errors.join(" / ")}`);
    } finally {
        await page.close();
    }
});

test("内嵌工作流编辑：widget 数值弹窗贴着鼠标落点（125% 缩放，画布偏移在窗口内）", async (t) => {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return; }
    const { page, errors } = await openManagerPage(1.25);
    const hasLiteGraph = await page.evaluate(() => !!window.LGraph && !!window.LGraphCanvas);
    if (!hasLiteGraph) { await page.close(); t.skip("前端未暴露 window.LGraph / LGraphCanvas，编辑模式按设计隐藏"); return; }
    try {
        await page.locator(".rs-skill-manager .rs-skill-picker-item").first().click();
        await page.waitForSelector(".rs-skill-workflow .rs-content-mode-btn", { timeout: 20000 });
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.locator(".rs-skill-workflow .rs-content-mode-btn", { hasText: "编辑" }).click();
        await page.waitForSelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas", { timeout: 20000 });
        await page.waitForTimeout(400);

        // 首个可视数值 widget 的视口坐标（graph 坐标 → ds 变换 → canvas 矩形）
        // 取行中心：litegraph 的 widget 命中区不含行左右边缘（贴边点会被当成节点空白）
        const target = await page.evaluate(() => {
            const c = document.querySelector("canvas.rs-wf-editor-canvas");
            const inst = c.data;
            const cr = c.getBoundingClientRect();
            for (const n of inst.graph._nodes) {
                for (const w of n.widgets || []) {
                    if (w.type !== "number" && w.type !== "slider") continue;
                    const x = (n.pos[0] + (w.width || 200) / 2 + inst.ds.offset[0]) * inst.ds.scale + cr.left;
                    const y = (n.pos[1] + (w.last_y || 0) + (w.height || 20) / 2 + inst.ds.offset[1]) * inst.ds.scale + cr.top;
                    if (x < cr.left + 8 || x > cr.right - 8 || y < cr.top + 8 || y > cr.bottom - 8) continue;
                    return { name: w.name, x, y, canvasTop: cr.top, canvasLeft: cr.left };
                }
            }
            return null;
        });
        assert.ok(target, "画布上应有可视的数值 widget");

        await page.mouse.click(target.x, target.y);
        await page.waitForSelector(".graphdialog", { timeout: 5000 });
        const dlg = await page.evaluate(() => {
            const d = document.querySelector(".graphdialog");
            const r = d.getBoundingClientRect();
            return { left: r.left, top: r.top, pos: getComputedStyle(d).position };
        });
        assert.equal(dlg.pos, "fixed", "弹窗在前端 CSS 里是 fixed，落点即视口坐标");
        assert.ok(Math.abs(dlg.left - (target.x - 20)) <= 2,
            `弹窗应贴着鼠标：left=${dlg.left.toFixed(1)} 期望≈${(target.x - 20).toFixed(1)}（画布左上角 ${target.canvasLeft.toFixed(0)},${target.canvasTop.toFixed(0)}）`);
        assert.ok(Math.abs(dlg.top - (target.y - 20)) <= 2,
            `弹窗应贴着鼠标：top=${dlg.top.toFixed(1)} 期望≈${(target.y - 20).toFixed(1)}`);
        await page.screenshot({ path: "tmp/skill-wf-prompt.png" });
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
        await page.waitForSelector(".rs-skill-workflow .rs-content-mode-btn", { timeout: 20000 });
        await page.click(".rs-skill-workflow-head .rs-form-label");
        await page.locator(".rs-skill-workflow .rs-content-mode-btn", { hasText: "编辑" }).click();
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

