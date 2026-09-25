// Neo Gallery 主目录（Grid / Character）：只读预设、素材库按钮导航。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush } from "./setup.mjs";
import { app, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

function makeGallery() {
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    return gallery;
}

test("只读判定：Grid / Character 下的 OSS 预设缓存不可删除", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();

    assert.equal(gallery.isDeletableItem("a.png", "Grid/2026-09-24"), true);
    assert.equal(gallery.isDeletableItem("a.png", "Character/2026-09-24"), true);
    assert.equal(gallery.isDeletableItem("a.png", "Grid/presets/风格"), false);
    assert.equal(gallery.isDeletableItem("a.png", "Character/presets/角色"), false);
    assert.equal(gallery.isDeletableItem("a.png", "Grid/presets"), false);
});

test("Cloud Presets 卡片按 path 导航到 Grid 的 presets 分支", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    const visits = [];
    gallery.showDirectoryStructure = (source, path) => { visits.push([source, path]); return Promise.resolve(); };

    gallery.currentView = { mode: "directory", source: "Grid", categoryPath: [] };
    gallery.accordion.innerHTML = "";
    const structure = { subdirs: { "Cloud Presets": { image_count: 2, path: "presets", read_only: true, source: "oss" } }, items: [] };
    // 与 renderDirectoryStructure 一致的子目录列表（带 path / source）
    const subdirs = [{ name: "Cloud Presets", path: "presets", image_count: 2, source: "oss", read_only: true }];
    await gallery.list.renderSubdirCards(structure, "Grid", [], subdirs);

    const card = document.querySelector(".neo-gallery-category-card");
    assert.ok(card, "应渲染 Cloud Presets 卡片");
    assert.equal(card.querySelector(".neo-gallery-card-name").textContent, "Cloud Presets");
    card.click();
    await flush();
    assert.deepEqual(visits, [["Grid", ["presets"]]], "点击走 path=presets，而不是显示名");
});

test("中间目录卡片：按「主目录/相对路径」取出封面缩略图", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    gallery.maxThumbnailSize = 240;
    // 后端 /neo_gallery/list 返回的 covers key 与卡片导航路径一致
    gallery._dirCovers = {
        "Character/2026-09-24": [{ filename: "sheet.png", subfolder: "Character/2026-09-24" }],
    };
    gallery.accordion.innerHTML = "";
    const structure = { subdirs: { "2026-09-24": { image_count: 1 } }, items: [] };
    await gallery.list.renderSubdirCards(structure, "Character", [], [{ name: "2026-09-24", image_count: 1 }]);

    const card = document.querySelector(".neo-gallery-category-card");
    assert.ok(card, "应渲染日期子目录卡片");
    const img = card.querySelector("img");
    assert.ok(img, "中间目录卡片应显示缩略图而不是空占位");
    assert.match(img.src, /filename=sheet\.png/);
    assert.match(img.src, /subfolder=Character%2F2026-09-24/);
    assert.equal(card.querySelector(".neo-gallery-card-placeholder"), null);
});

test("素材库按钮：带目标主目录时打开侧栏并导航", async () => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
    const { toggleGallerySidebar } = await import("../../web/media-transfer.js");

    const visits = [];
    app.neoGallery = { showDirectoryStructure: (source, path) => { visits.push([source, path]); } };

    toggleGallerySidebar("Character", []);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "打开素材面板");
    assert.deepEqual(visits, [["Character", []]], "导航到 Character 主目录");

    // 无目标：保持原有开/关切换
    toggleGallerySidebar();
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, null, "再次点击收起面板");

    delete app.neoGallery;
});
