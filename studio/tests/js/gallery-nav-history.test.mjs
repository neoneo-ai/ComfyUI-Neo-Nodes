// Neo Gallery 顶部前进/后退按钮：导航历史栈、按钮禁用态、新导航截断前进分支。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, flush } from "./setup.mjs";

// gallery.js 必须在 setup（模块钩子）装好后动态导入，scripts/* shim 才能生效
let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

function makeGallery() {
    const gallery = new NeoGallery({});
    // 渲染走真实 GalleryList（面包屑等），仅跳过重绘与滚动持久化
    gallery.list.sortAndDisplayImages = async () => {};
    gallery.list._saveCurrentScrollPosition = async () => {};
    mockRoute("/neo_gallery/list", { directories: [{ subdirs: {}, root_count: 0 }], covers: {} });
    return gallery;
}

test("导航历史：后退/前进按钮切换视图并更新禁用态", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const backBtn = gallery.navBackBtn;
    const fwdBtn = gallery.navForwardBtn;
    assert.ok(backBtn && fwdBtn, "头部应包含后退/前进按钮");

    await gallery.showCategoryCards();
    assert.equal(backBtn.disabled, true, "首页无历史，后退禁用");
    assert.equal(fwdBtn.disabled, true, "首页无历史，前进禁用");

    await gallery.showDirectoryStructure("Output", ["a"]);
    assert.deepEqual(gallery.currentView, { mode: "directory", source: "Output", categoryPath: ["a"] });
    assert.equal(backBtn.disabled, false);
    assert.equal(fwdBtn.disabled, true);

    const ok = await gallery.navigateHistory(-1);
    assert.equal(ok, true);
    assert.equal(gallery.currentView.mode, "categories");
    assert.equal(backBtn.disabled, true);
    assert.equal(fwdBtn.disabled, false);

    const ok2 = await gallery.navigateHistory(1);
    assert.equal(ok2, true);
    assert.deepEqual(gallery.currentView, { mode: "directory", source: "Output", categoryPath: ["a"] });
    assert.equal(backBtn.disabled, false);
    assert.equal(fwdBtn.disabled, true);

    // 越界返回 false，视图不变
    assert.equal(await gallery.navigateHistory(1), false);
    assert.equal(gallery.currentView.mode, "directory");
});

test("导航历史：新导航截断前进分支", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    await gallery.showCategoryCards();
    await gallery.showDirectoryStructure("Output", ["a"]);
    await gallery.navigateHistory(-1); // 回到首页，前进分支存在
    assert.equal(gallery.navForwardBtn.disabled, false);

    await gallery.showDirectoryStructure("Output", ["b"]);
    assert.deepEqual(gallery._navStack.map((v) => v.categoryPath), [[], ["b"]]);
    assert.equal(gallery.navForwardBtn.disabled, true, "新导航后前进分支被截断");
});

test("头部渲染两个导航按钮，禁用态下点击不触发", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const btns = [...document.querySelectorAll(".neo-gallery-nav-btn")];
    assert.equal(btns.length, 2);
    assert.equal(btns[0].title, "后退 (Back)");
    assert.equal(btns[1].title, "前进 (Forward)");

    let called = 0;
    gallery.navigateHistory = async () => { called += 1; return false; };
    btns[0].disabled = true;
    btns[0].click();
    await flush();
    assert.equal(called, 0, "禁用按钮点击不应触发导航");
});
