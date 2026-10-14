// Neo Gallery 目录/收藏封面瓦片：统一竖排网格（object-fit: cover）、音频专用瓦片、通用占位瓦片。
// 共享渲染器 renderCoverTiles（web/gallery-utils.js）是目录卡、子目录卡与收藏卡共用的唯一入口。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

let utils;
async function loadUtils() {
    if (!utils) utils = await import("../../web/gallery-utils.js");
    return utils;
}

function wrapper() {
    const el = document.createElement("div");
    el.className = "neo-gallery-card-cover-wrapper";
    return el;
}

test("getCoverTileKind：仅 kind=audio 走音频瓦片，其余（含无 kind 的旧条目）当图片", async () => {
    resetEnv();
    const { getCoverTileKind } = await loadUtils();
    assert.equal(getCoverTileKind({ kind: "audio" }), "audio");
    assert.equal(getCoverTileKind({ kind: "image" }), "media");
    assert.equal(getCoverTileKind({ kind: "video" }), "media");
    assert.equal(getCoverTileKind({ filename: "a.png" }), "media");
    assert.equal(getCoverTileKind(null), "media");
});

test("目录封面：两张图竖排成单个网格，无内联高度", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    renderCoverTiles(w, [
        { filename: "a.png", subfolder: "Grid/2026-09-24" },
        { filename: "b.jpg", subfolder: "Grid/2026-09-24" },
    ], "Grid");

    const grid = w.querySelector(".neo-gallery-card-cover-grid");
    assert.ok(grid, "应生成单个封面网格容器");
    const items = grid.querySelectorAll(".neo-gallery-card-cover-grid-item");
    assert.equal(items.length, 2, "两张图各占一行（竖排）");
    // 自然比例：渲染器不再写入任何内联高度
    assert.equal(grid.style.height, "", "网格不应有内联 height");
    for (const img of grid.querySelectorAll("img")) {
        assert.equal(img.style.height, "", "图片不应有内联 height");
        assert.match(img.src, /thumbnail/);
    }
    assert.match(items[0].querySelector("img").src, /filename=a\.png/);
});

test("封面方向：首图为竖图/方形时并排+顶部锚定，横图只留一张", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();

    function renderWith(naturalWidth, naturalHeight, count = 2) {
        const w = wrapper();
        document.body.appendChild(w);
        const covers = [];
        for (let i = 0; i < count; i++) covers.push({ filename: `${i}.png`, subfolder: "" });
        renderCoverTiles(w, covers, "");
        const grid = w.querySelector(".neo-gallery-card-cover-grid");
        const img = grid.querySelector("img");
        Object.defineProperty(img, "naturalWidth", { value: naturalWidth });
        Object.defineProperty(img, "naturalHeight", { value: naturalHeight });
        img.onload();
        return { w, grid };
    }

    // 两张竖图 → 并排 + 顶部锚定（减少切头）
    const p = renderWith(768, 1344);
    assert.ok(p.grid.classList.contains("neo-gallery-card-cover-grid--row"), "竖图切换为横向并排");
    assert.ok(p.grid.classList.contains("neo-gallery-card-cover-grid--portrait"), "竖图标记顶部锚定");

    // 单张竖图 → 同样标记顶部锚定（单图时并排无效果，靠锚定减少切头）
    const p1 = renderWith(768, 1344, 1);
    assert.ok(p1.grid.classList.contains("neo-gallery-card-cover-grid--portrait"), "单张竖图也标记顶部锚定");

    // 方形图 → 与竖图同处理（height >= width）
    const s = renderWith(1024, 1024);
    assert.ok(s.grid.classList.contains("neo-gallery-card-cover-grid--row"), "方形图切换为横向并排");
    assert.ok(s.grid.classList.contains("neo-gallery-card-cover-grid--portrait"), "方形图标记顶部锚定");

    // 横图 → 双图堆叠太高，只保留首图，无并排/锚定类
    const l = renderWith(1344, 768);
    assert.ok(!l.grid.classList.contains("neo-gallery-card-cover-grid--row"), "横图不并排");
    assert.ok(!l.grid.classList.contains("neo-gallery-card-cover-grid--portrait"), "横图不加顶部锚定");
    assert.equal(l.grid.querySelectorAll(".neo-gallery-card-cover-grid-item").length, 1, "横图只留一张");

    p.w.remove(); p1.w.remove(); s.w.remove(); l.w.remove();
});

test("目录卡封面比例随首图方向：竖图双拼合成，横图单张（与单图素材卡不同）", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();

    // 比例只写在 .neo-gallery-category-card 的 cover wrapper 上，测试需挂真实卡片父级
    function renderWith(sizes) {
        const card = document.createElement("div");
        card.className = "neo-gallery-category-card";
        const w = wrapper();
        card.appendChild(w);
        document.body.appendChild(card);
        const covers = sizes.map((_, i) => ({ filename: `${i}.png`, subfolder: "" }));
        renderCoverTiles(w, covers, "");
        const imgs = [...w.querySelectorAll("img")];
        sizes.forEach(([nw, nh], i) => {
            Object.defineProperty(imgs[i], "naturalWidth", { value: nw });
            Object.defineProperty(imgs[i], "naturalHeight", { value: nh });
        });
        return { card, w, imgs };
    }

    // jsdom 把 aspect-ratio: 1.5 序列化成 "1.5 / 1"，断言前去掉分母
    const ratioOf = (el) => el.style.aspectRatio.replace(" / 1", "");

    // 两张竖图并排 → 合成 3:2 宽卡（每张瓦片恰好 3:4，不裁切）
    const p = renderWith([[768, 1344], [768, 1344]]);
    p.imgs[0].onload();
    assert.equal(ratioOf(p.w), "1.5", "首图加载即按双竖图合成 3:2");
    p.imgs[1].onload();
    assert.equal(ratioOf(p.w), "1.5", "第二张确认后保持 3:2");

    // 首图为横图 → 双图堆叠太高，只留单张自身 3:2
    const l = renderWith([[1344, 768], [1344, 768]]);
    l.imgs[0].onload();
    assert.equal(ratioOf(l.w), "1.5", "横图只留单张，比例即自身 3:2");
    assert.equal(l.w.querySelectorAll(".neo-gallery-card-cover-grid-item").length, 1, "第二张被移除");

    // 横 + 竖混合 → 首图为横图时第二张同样移除
    const lm = renderWith([[1344, 768], [768, 1344]]);
    lm.imgs[0].onload();
    assert.equal(ratioOf(lm.w), "1.5", "横图首图时保持单张");
    assert.equal(lm.w.querySelectorAll(".neo-gallery-card-cover-grid-item").length, 1, "混合朝向也移除第二张");

    // 单张竖图 → 自身 3:4，与素材卡一致
    const s = renderWith([[768, 1344]]);
    s.imgs[0].onload();
    assert.equal(ratioOf(s.w), "0.75", "单图保持自身比例");

    // 竖 + 横混合 → 首图加载时第二张未知（按同朝向计 1.5），确认后并排合成 0.75 + 1.5 = 2.25
    const m = renderWith([[768, 1344], [1344, 768]]);
    m.imgs[0].onload();
    assert.equal(ratioOf(m.w), "1.5", "第二张未知时按同朝向合成");
    m.imgs[1].onload();
    assert.equal(ratioOf(m.w), "2.25", "混合朝向确认后按并排合成");

    // 第二张加载失败 → 占位瓦片按方形计：0.75 + 1 = 1.75
    const f = renderWith([[768, 1344], [768, 1344]]);
    f.imgs[0].onload();
    f.imgs[1].onerror();
    assert.equal(ratioOf(f.w), "1.75", "失败瓦片按方形参与合成");
    assert.ok(f.w.querySelector(".neo-gallery-card-placeholder"), "失败瓦片变占位");

    for (const r of [p, l, lm, s, m, f]) r.card.remove();
});

test("封面只取前 MAX_COVER_IMAGES 张，多余忽略", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    renderCoverTiles(w, [
        { filename: "a.png", subfolder: "" },
        { filename: "b.png", subfolder: "" },
        { filename: "c.png", subfolder: "" },
    ], "");
    assert.equal(w.querySelectorAll(".neo-gallery-card-cover-grid-item").length, 2);
});

test("音频封面（kind=audio）渲染音频瓦片，而不是 <img>", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    renderCoverTiles(w, [
        { filename: "voice.mp3", subfolder: "Voice", kind: "audio" },
        { filename: "voice2.mp3", subfolder: "Voice", kind: "audio" },
    ], "Voice");

    assert.equal(w.querySelector("img"), null, "音频封面不应出现 <img>（避免坏图）");
    const tile = w.querySelector(".neo-gallery-cover-audio-tile");
    assert.ok(tile, "应渲染音频瓦片");
    assert.ok(tile.querySelector(".neo-gallery-cover-audio-badge"), "音频瓦片带 ♪ 徽章");
    assert.ok(tile.querySelector("canvas.neo-gallery-cover-audio-waveform"), "音频瓦片带波形 canvas");
});

test("图 + 音频混合：优先展示图片，不出现音频瓦片", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    renderCoverTiles(w, [
        { filename: "pic.png", subfolder: "", kind: "image" },
        { filename: "song.mp3", subfolder: "", kind: "audio" },
    ], "");
    assert.ok(w.querySelector("img"), "应展示图片");
    assert.equal(w.querySelector(".neo-gallery-cover-audio-tile"), null, "有图时不渲染音频瓦片");
});

test("空封面：渲染单个全区域通用占位瓦片", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    renderCoverTiles(w, [], "");
    assert.equal(w.querySelector("img"), null);
    assert.ok(w.querySelector(".neo-gallery-card-placeholder"), "应出现通用占位瓦片");
    assert.ok(w.querySelector(".neo-gallery-card-placeholder-icon"), "占位瓦片带图标");
});

test("图片加载失败：该行替换为占位瓦片，而不是 emoji 塌缩", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();
    const w = wrapper();
    document.body.appendChild(w); // 卡片在真实场景始终挂在文档里，onerror 时 isConnected 为真
    renderCoverTiles(w, [
        { filename: "bad.png", subfolder: "" },
        { filename: "good.png", subfolder: "" },
    ], "");
    const firstImg = w.querySelectorAll(".neo-gallery-card-cover-grid-item img")[0];
    firstImg.onerror(); // 模拟加载失败
    assert.ok(w.querySelector(".neo-gallery-card-placeholder"), "失败行应变成占位瓦片");
    assert.equal(w.querySelectorAll(".neo-gallery-card-cover-grid-item").length, 1, "其余行保留");
});

test("buildAudioTile / buildPlaceholderTile 独立可用", async () => {
    resetEnv();
    const { buildAudioTile, buildPlaceholderTile } = await loadUtils();
    const host = document.createElement("div");
    host.appendChild(buildAudioTile("seed.mp3"));
    assert.ok(host.querySelector(".neo-gallery-cover-audio-tile canvas"));
    host.appendChild(buildPlaceholderTile());
    assert.ok(host.querySelector(".neo-gallery-card-placeholder .neo-gallery-card-placeholder-icon"));
});

test("收藏/Civitai 封面走同一共享结构（远程 url）", async () => {
    resetEnv();
    const { NeoGallery } = await import("../../web/gallery.js");
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);

    const w = wrapper();
    gallery._applyBookmarkCovers(w, [{ url: "http://test.local/cover.png" }], { name: "Some Work" });

    const grid = w.querySelector(".neo-gallery-card-cover-grid");
    assert.ok(grid, "收藏封面复用同一网格结构");
    const img = grid.querySelector("img");
    assert.ok(img, "远程封面渲染为 <img>");
    assert.equal(img.src, "http://test.local/cover.png");
});

