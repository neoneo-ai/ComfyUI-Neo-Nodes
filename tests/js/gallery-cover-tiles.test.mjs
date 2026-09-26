// Neo Gallery 目录/收藏封面瓦片：自然比例图片（竖图并排、横图竖排）、音频专用瓦片、通用占位瓦片。
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

test("目录封面：两张图竖排成单个网格，无内联高度（自然比例）", async () => {
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

test("封面方向：多张图首张加载后方形/竖图切横向并排，横图保持竖排", async () => {
    resetEnv();
    const { renderCoverTiles } = await loadUtils();

    // 两张方形图 → 切 row
    const w = wrapper();
    document.body.appendChild(w);
    renderCoverTiles(w, [
        { filename: "a.png", subfolder: "" },
        { filename: "b.jpg", subfolder: "" },
    ], "");
    const grid = w.querySelector(".neo-gallery-card-cover-grid");
    assert.ok(!grid.classList.contains("neo-gallery-card-cover-grid-row"), "加载前默认竖排");

    const square = grid.querySelectorAll("img")[0];
    Object.defineProperty(square, "naturalWidth", { value: 512 });
    Object.defineProperty(square, "naturalHeight", { value: 512 });
    square.onload();
    assert.ok(grid.classList.contains("neo-gallery-card-cover-grid-row"), "方形图应切换为横向并排");

    // 两张竖图 → 切 row
    const w3 = wrapper();
    document.body.appendChild(w3);
    renderCoverTiles(w3, [
        { filename: "d.png", subfolder: "" },
        { filename: "e.jpg", subfolder: "" },
    ], "");
    const grid3 = w3.querySelector(".neo-gallery-card-cover-grid");
    const portrait = grid3.querySelectorAll("img")[0];
    Object.defineProperty(portrait, "naturalWidth", { value: 832 });
    Object.defineProperty(portrait, "naturalHeight", { value: 1248 });
    portrait.onload();
    assert.ok(grid3.classList.contains("neo-gallery-card-cover-grid-row"), "竖图应切换为横向并排");

    // 两张横图 → 保持竖排
    const w2 = wrapper();
    document.body.appendChild(w2);
    renderCoverTiles(w2, [
        { filename: "c.png", subfolder: "" },
        { filename: "f.jpg", subfolder: "" },
    ], "");
    const grid2 = w2.querySelector(".neo-gallery-card-cover-grid");
    const landscape = grid2.querySelectorAll("img")[0];
    Object.defineProperty(landscape, "naturalWidth", { value: 1248 });
    Object.defineProperty(landscape, "naturalHeight", { value: 700 });
    landscape.onload();
    assert.ok(!grid2.classList.contains("neo-gallery-card-cover-grid-row"), "横图保持竖排");

    // 单张图不检测方向（无 onload），始终竖排
    const w4 = wrapper();
    document.body.appendChild(w4);
    renderCoverTiles(w4, [{ filename: "g.png", subfolder: "" }], "");
    const grid4 = w4.querySelector(".neo-gallery-card-cover-grid");
    const single = grid4.querySelector("img");
    assert.equal(single.onload, null, "单张图不设置 onload 方向检测");
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

