// E2E：Neo Studio 独立页面（需 ComfyUI 运行中）。
// 用法：npm run e2e
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行且已加载 Neo-Nodes 插件。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const STUDIO_URL = `${BASE}/neo-studio`;

let browser;
let skipReason;

test.before(async () => {
    try {
        const resp = await fetch(`${BASE}/neo_studio/version`, { signal: AbortSignal.timeout(3000) });
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

function guard(t) {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return false; }
    return true;
}

test("Studio 页面：四视图加载、版本信息、导演生成面板", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });

        // 顶栏版本信息（插件 + ComfyUI）
        const version = await page.textContent("#ns-version");
        assert.match(version, /Neo-Nodes .+ · ComfyUI .+/);

        // 默认视图 = 素材：NeoGallery 挂载
        await page.waitForSelector("#ns-view .neo-gallery-panel", { timeout: 15000 });

        // 导演视图：整片生成面板 + 配方面板
        await page.evaluate(() => { location.hash = "#/director"; });
        await page.waitForSelector(".ns-gen-panel .rs-btn.ns-gen-run", { timeout: 15000 });
        await page.waitForSelector(".neo-recipes-panel", { timeout: 15000 });
        // 只读时间轴挂进生成面板（与画布节点内嵌同款组件）
        await page.waitForSelector(".ns-gen-timeline .neo-dtl-canvas", { timeout: 5000 });
        // .rs-btn 基础样式 flex:1；满幅主区里不应拉伸成长条
        const runFlex = await page.evaluate(() =>
            getComputedStyle(document.querySelector(".ns-gen-panel .rs-btn.ns-gen-run")).flexGrow);
        assert.equal(runFlex, "0", "生成整片按钮不应被 flex 拉伸");
        // 控制行属于配方列（配方区 = 控制行 + 时间轴；结果区 = 预览/成片），行尾按钮右端应与时间轴右端对齐
        const edges = await page.evaluate(() => {
            const right = (sel) => document.querySelector(sel).getBoundingClientRect().right;
            return { btn: right(".ns-gen-panel .ns-gen-run-group"), tl: right(".ns-gen-timeline") };
        });
        assert.ok(Math.abs(edges.btn - edges.tl) <= 1, `生成按钮右端应与时间轴右端对齐（差 ${Math.round(edges.btn - edges.tl)}px）`);
        // 满幅主区里配方列表应像素材一样多列排布
        const listDisplay = await page.evaluate(() =>
            getComputedStyle(document.querySelector(".ns-director .neo-recipes-list")).display);
        assert.equal(listDisplay, "grid", "配方列表应为 grid 多列布局");

        // 首个配方自动选中：对应卡片高亮，且 分辨率/步数 按 director_spec 默认值填充（与画布节点同源）
        const spec = await page.evaluate(async () => {
            const v = await (await fetch("/neo_studio/version")).json();
            const name = (v.recipes || [])[0];
            if (!name) return null;
            const s = await (await fetch(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`)).json();
            return { name, defaults: s.defaults };
        });
        if (spec) {
            const selectedName = await page.evaluate(() =>
                document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent);
            assert.equal(selectedName, spec.name, "首个配方应被自动选中");
            // 分辨率两种形态都算回填成功：预设比例 → W×H 回显；自定义/旧配方 → 手输 W/H 精确值
            await page.waitForFunction((d) => {
                const panel = document.querySelector(".ns-gen-panel");
                const out = (panel.querySelector(".ns-gen-res-out")?.textContent || "").replace(/\s/g, "");
                const cw = panel.querySelector(".ns-gen-cw"), ch = panel.querySelector(".ns-gen-ch");
                const custom = cw.style.display !== "none" && Number(cw.value) === d.width && Number(ch.value) === d.height;
                return Number(panel.querySelector(".ns-gen-steps").value) === d.steps
                    && (out === `${d.width}×${d.height}` || custom);
            }, spec.defaults, { timeout: 5000 });

            // 点另一张卡片 → 高亮切换（选中直接喂生成区，不再用顶部下拉）
            const cardCount = await page.locator(".neo-recipes-card").count();
            if (cardCount >= 2) {
                await page.evaluate(() => {
                    const cards = [...document.querySelectorAll(".neo-recipes-card")];
                    cards.find(c => !c.classList.contains("neo-recipes-card-selected")).click();
                });
                await page.waitForFunction((first) => {
                    const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
                    return sel && sel.textContent !== first;
                }, spec.name, { timeout: 5000 });
            }
        }

        // 技能视图：统一技能管理直接挂满主区（无弹窗外壳，无 ✕ / 无「从画布」）
        await page.evaluate(() => { location.hash = "#/skills"; });
        await page.waitForSelector(".ns-skills .rs-skill-manager", { timeout: 15000 });
        await page.waitForSelector(".ns-skills .rs-skill-picker-item", { timeout: 15000 });
        assert.equal(await page.locator(".ns-skills .rs-skill-manager-head .rs-skill-modal-close").count(), 0, "技能页不应有 ✕");
        const footerBtns = await page.locator(".ns-skills .rs-skill-footer-btn").allTextContents();
        assert.ok(!footerBtns.some((t) => t.includes("从画布")), "技能页不应有「从画布」按钮");

        // 设置视图：生图/生视频表单（.rs-gen-settings）+ LLM 入口，且无对象串渲染
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-section .rs-btn, .ns-settings-section button", { timeout: 15000 });
        const sections = await page.locator(".ns-settings-section").count();
        assert.equal(sections, 3);
        await page.waitForSelector(".ns-settings .rs-gen-settings", { timeout: 15000 });
        assert.equal(await page.locator(".ns-settings .rs-gen-settings").count(), 2);
        assert.ok(!((await page.locator(".ns-settings").textContent()) || "").includes("[object Object]"));

        // 切回素材：视图缓存保留
        await page.evaluate(() => { location.hash = "#/gallery"; });
        await page.waitForTimeout(300);
        assert.ok(await page.locator("#ns-view .neo-gallery-panel").count(), "切回后 gallery 应保留");
    } finally {
        await page.close();
    }
});
