/**
 * Neo Studio 桌面壳 E2E（pywebview + WebView2）：壳拉起 ComfyUI，经 WebView2 远程调试端口连 CDP，
 * 断言窗口里加载的是 Studio 页面（四视图渲染）与 localStorage 持久化。
 *
 * 会真的弹窗口，默认跳过；显式开启：NEO_STUDIO_APP=1 node tests/e2e/studio-app.e2e.mjs
 * 前置：整合包 python 已装 pywebview（可选依赖 desktop），WebView2 Runtime 已安装。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PLUGIN_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const APP_PY = join(PLUGIN_DIR, "neo_studio_app.py");
const GEOMETRY = join(PLUGIN_DIR, "configs", "studio_window.json");
const PORT = Number(process.env.NEO_STUDIO_PORT || 8188);
const CDP_PORT = Number(process.env.NEO_STUDIO_CDP || 9223);
const PYTHON = process.env.NEO_STUDIO_PYTHON || "F:/comfy/Comfyui-WF-2026.8.8/python/python.exe";

async function probe() {
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/neo_studio/version`);
        return res.ok;
    } catch {
        return false;
    }
}

async function cdpReady() {
    try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return res.ok;
    } catch {
        return false;
    }
}

async function waitFor(fn, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

test("桌面壳窗口加载 Neo Studio 四视图", async () => {
    if (process.env.NEO_STUDIO_APP !== "1") {
        console.log("跳过桌面壳 E2E（设 NEO_STUDIO_APP=1 启用，会弹真实窗口）");
        return;
    }
    if (!existsSync(APP_PY) || !existsSync(PYTHON)) {
        console.log(`跳过：缺 ${APP_PY} 或 ${PYTHON}`);
        return;
    }
    // 几何持久化：预置存档尺寸，窗口应按存档打开
    writeFileSync(GEOMETRY, JSON.stringify({ width: 1200, height: 800, x: 120, y: 60 }));
    const shell = spawn(PYTHON, [APP_PY, "--port", String(PORT), "--cdp", String(CDP_PORT)], { stdio: "inherit" });
    try {
        assert.ok(await waitFor(cdpReady, 120), "WebView2 远程调试端口未就绪");
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        const pages = browser.contexts().flatMap((c) => c.pages());
        const page = pages.find((p) => p.url().includes("/neo-studio"));
        assert.ok(page, `CDP 里找不到 Studio 页面（当前 ${pages.map((p) => p.url()).join(", ") || "无页面"}）`);

        await page.waitForSelector("#ns-version", { timeout: 20000 });
        assert.match(await page.evaluate(() => document.querySelector("#ns-version").textContent),
            /Neo-Nodes\s+\d+\.\d+\.\d+/, "窗口标题栏应显示插件版本");

        // 四视图渲染（与浏览器版 studio.e2e.mjs 同一组断言的桌面壳子集）
        await page.waitForSelector("#ns-view .neo-gallery-panel", { timeout: 15000 });
        assert.ok(await page.locator("#ns-view .neo-gallery-panel").count(), "素材视图应渲染");

        await page.evaluate(() => { location.hash = "#/director"; });
        await page.waitForSelector(".ns-director .neo-recipes-card", { timeout: 15000 });

        await page.evaluate(() => { location.hash = "#/skills"; });
        await page.waitForSelector(".ns-skills .rs-skill-manager", { timeout: 15000 });

        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-section", { timeout: 15000 });

        // 日志 tab：桌面壳里同样能读到 ComfyUI 控制台
        await page.click(".ns-settings-tab[data-key='log']");
        await page.waitForFunction(() => document.querySelector(".ns-log").textContent.trim().length > 0,
            null, { timeout: 15000 });

        // 手动往上翻看时，2 秒轮询不应把滚动条拉回底部
        await page.evaluate(() => { document.querySelector(".ns-log").scrollTop = 0; });
        await page.waitForTimeout(2500);
        assert.ok((await page.evaluate(() => document.querySelector(".ns-log").scrollTop)) < 40,
            "翻看时不应被轮询拉回底部");

        // localStorage 落在 tmp/studio_profile（private_mode=False）：重开页面后仍在
        await page.evaluate(() => localStorage.setItem("ns_e2e_shell", "ok"));
        // WebView2 下 page.reload 的导航事件不可靠（带 hash 的 URL 被判同文档导航，domcontentloaded 不触发）
        // 让页面自己 reload，再等首屏元素出现
        await page.evaluate(() => setTimeout(() => location.reload(), 0));
        await page.waitForTimeout(2000);
        await page.waitForSelector("#ns-version", { timeout: 20000 });
        assert.equal(await page.evaluate(() => localStorage.getItem("ns_e2e_shell")), "ok",
            "窗口重开后 localStorage 应保留");

        // 按存档尺寸打开（configs/studio_window.json → create_window）
        const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        assert.ok(Math.abs(size.w - 1200) <= 40 && Math.abs(size.h - 800) <= 40,
            `窗口应按存档 1200×800 打开（实际 ${size.w}×${size.h}）`);

        await browser.close();
    } finally {
        shell.kill();
    }
});
