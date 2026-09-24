// 临时用：量一下九宫格小窗里参考图预览的实际渲染尺寸（对照卡片图片），验证后即删。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8188";
const GALLERY = process.env.GALLERY || "Output:CharacterSheet";
const FILENAME = process.env.FILENAME || "";
const OUT = process.env.OUT || "neo-story-size-tmp.png";
// 侧边栏页签没打开时画廊元素不在文档里，手动挂到宿主容器里量真实布局
const HOST_CSS = "position:fixed;top:0;left:0;width:420px;height:900px;z-index:5;background:#111;overflow:auto";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(`${BASE}/?gallery=gallery_v2:${GALLERY}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.app?.neoGallery, null, { timeout: 120000 });
await page.waitForTimeout(2500);

await page.evaluate((css) => {
    const g = window.app.neoGallery;
    const host = document.createElement("div");
    host.id = "neo-tmp-host";
    host.style.cssText = css;
    document.body.appendChild(host);
    host.appendChild(g.element);
    g.isVisible = true;
}, HOST_CSS);
await page.waitForTimeout(2500);

const cardInfo = await page.evaluate((filename) => {
    const img = [...document.querySelectorAll(".neo-gallery-thumb-container")]
        .find((c) => c.querySelector(".neo-gallery-thumb-img")?.naturalWidth > 0 && (!filename || c.dataset.filename === filename))
        ?.querySelector(".neo-gallery-thumb-img");
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const c = img.closest(".neo-gallery-thumb-container").getBoundingClientRect();
    const g = window.app.neoGallery;
    return {
        card: { w: Math.round(c.width), h: Math.round(c.height) },
        img: { w: Math.round(r.width), h: Math.round(r.height), natural: `${img.naturalWidth}x${img.naturalHeight}` },
        settings: `${g.maxThumbnailSize}/${g.displayLabels}`,
    };
}, FILENAME);
console.log("card:", JSON.stringify(cardInfo));

await page.evaluate((filename) => {
    const card = [...document.querySelectorAll(".neo-gallery-thumb-container")]
        .find((c) => c.querySelector(".neo-gallery-thumb-img")?.naturalWidth > 0 && (!filename || c.dataset.filename === filename));
    card.querySelector(".neo-gallery-thumb-bookmark-btn").click();
}, FILENAME);

await page.waitForSelector(".neo-gallery-collect-menu");
await page.evaluate(() => {
    [...document.querySelectorAll(".neo-gallery-collect-item")].find((i) => i.textContent.includes("生成九宫格分镜图")).click();
});
await page.waitForSelector(".neo-gallery-story-ref-img");
await page.waitForTimeout(1500);

const dialog = await page.evaluate(() => {
    const modal = document.querySelector(".neo-gallery-story-modal");
    const ref = document.querySelector(".neo-gallery-story-ref-img");
    const info = document.querySelector(".neo-gallery-story-ref-info");
    const mr = modal.getBoundingClientRect();
    const rr = ref.getBoundingClientRect();
    return {
        modal: { w: Math.round(mr.width), h: Math.round(mr.height), bottom: Math.round(mr.bottom) },
        preview: { w: Math.round(rr.width), h: Math.round(rr.height), natural: `${ref.naturalWidth}x${ref.naturalHeight}`, inlineHeight: ref.style.height },
        previewBottom: Math.round(rr.bottom),
        infoTop: Math.round(info.getBoundingClientRect().top),
        viewportH: window.innerHeight,
        xOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
});
console.log("dialog:", JSON.stringify(dialog));

await page.screenshot({ path: OUT });
await browser.close();
