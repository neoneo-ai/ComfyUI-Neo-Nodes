// Neo Gallery 缩略图懒加载：进入视口才请求、并发上限、卡片移除后作废、按服务端 w/h 预排版。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, flush } from "./setup.mjs";

let utils;
async function loadUtils() {
    if (!utils) utils = await import("../../web/gallery-utils.js");
    return utils;
}

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

// 共享模块里的 IntersectionObserver 只在首次注册缩略图时创建一次，
// 所以「视口内立即触发」的桩必须在本文件第一个用例里装好。
function installViewportNowObserver() {
    globalThis.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; }
        observe(el) { this.cb([{ target: el, isIntersecting: true }], this); }
        unobserve() {}
        disconnect() {}
    };
}

test("素材卡用列表下发的 w/h 立即定比例，缩略图到位前保持占位图", async () => {
    resetEnv();
    clearRoutes();
    installViewportNowObserver();
    await loadNeoGallery();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = makeGallery();
    const el = new GalleryCard({}).createImageElement(gallery, { name: "p", filename: "p.png", w: 768, h: 1344 }, "Output", "Output");
    document.body.appendChild(el);

    const wrapper = el.querySelector(".neo-gallery-thumb-img-wrapper");
    const img = wrapper.querySelector("img");
    assert.match(wrapper.style.aspectRatio, /^0\.75/, "竖图卡片先按 3:4 占位，不等缩略图");
    assert.equal(img.src, gallery.placeholderImageUrl, "缩略图请求发出前保持占位图");

    await flush(30);
    assert.match(img.src, /neo_gallery\/thumbnail/, "进入视口后取真实缩略图");
});

test("无 w/h 时：缩略图到位后按真实方向回填比例", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = makeGallery();
    const el = new GalleryCard({}).createImageElement(gallery, { name: "v", filename: "v.png" }, "Output", "Output");
    document.body.appendChild(el);

    const wrapper = el.querySelector(".neo-gallery-thumb-img-wrapper");
    assert.equal(wrapper.style.aspectRatio, "", "没有尺寸数据时不预设比例");

    await flush(30);
    // 桩图片 8x6 → 横图 3:2
    assert.match(wrapper.style.aspectRatio, /^1\.5/, "缩略图到位后回填方向比例");
});

test("缩略图队列并发上限 6：超出的排队，前一批完成才继续", async () => {
    resetEnv();
    const { enqueueThumbnail } = await loadUtils();
    const imgs = [];
    for (let i = 0; i < 12; i++) {
        const el = document.createElement("img");
        document.body.appendChild(el);
        imgs.push(el);
        enqueueThumbnail(el, `/neo_gallery/thumbnail?filename=${i}.png`);
    }

    assert.equal(imgs.filter((el) => el._thumbLoader).length, 6, "同时最多 6 个在途请求，其余排队");
    assert.equal(imgs.filter((el) => el.src).length, 0, "排队阶段不发请求");

    await flush();
    assert.equal(imgs.filter((el) => el.src).length, 12, "前一批完成后队列继续排空");
});

test("卡片移除后任务作废：不给游离元素赋值", async () => {
    resetEnv();
    const { enqueueThumbnail } = await loadUtils();
    const el = document.createElement("img");
    document.body.appendChild(el);
    enqueueThumbnail(el, "/neo_gallery/thumbnail?filename=gone.png");
    el.remove();

    await flush(30);
    assert.equal(el.src, "", "已移除的卡片不应被写入缩略图");
});

test("releaseLazyThumbnails 释放容器内排队任务（列表刷新时不堆积）", async () => {
    resetEnv();
    const { enqueueThumbnail, releaseLazyThumbnails } = await loadUtils();
    const box = document.createElement("div");
    document.body.appendChild(box);
    const imgs = [];
    for (let i = 0; i < 10; i++) {
        const el = document.createElement("img");
        el.dataset.thumbnailSrc = `/neo_gallery/thumbnail?filename=${i}.png`;
        box.appendChild(el);
        imgs.push(el);
        enqueueThumbnail(el, el.dataset.thumbnailSrc);
    }

    releaseLazyThumbnails(box);
    box.innerHTML = "";
    await flush(60);
    assert.equal(imgs.filter((el) => el.src).length, 0, "释放后排队与在途任务全部作废");
});
