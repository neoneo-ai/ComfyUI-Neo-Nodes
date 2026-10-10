// Neo Gallery 目录管理：移除目录只改列表，弹窗必须保持打开（不重建）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, click, setConfirmAnswer, fetchLog } from "./setup.mjs";

const DIRS = ["F:/data/stars", "F:/data/beauty", "F:/data/wuxia"];
const BUILTIN = ["Output", "Input", "本地收藏", "C站收藏"];

let NeoGallery;
async function makeGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    gallery.loadGallery = async () => {};
    gallery.list.sortAndDisplayImages = () => {};
    return gallery;
}

function setup() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({ custom_directories: DIRS }));
    mockRoute("/neo_gallery/save_settings", () => jsonResponse({ success: true }));
    mockRoute("/neo_gallery/clear_thumbnails", () => jsonResponse({ success: true }));
}

function labels() {
    return [...document.querySelectorAll(".neo-gallery-dir-item .neo-gallery-dir-path")].map((el) => el.textContent);
}

function rowByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-dir-item")]
        .find((r) => r.querySelector(".neo-gallery-dir-path")?.textContent === label);
}

function removeCalls() {
    return fetchLog.filter((c) => c.path === "/neo_gallery/save_settings" && c.body?.action === "remove");
}

test("移除目录后弹窗保持打开，列表原地更新", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);
    const overlay = document.querySelector(".neo-gallery-dir-modal-overlay");

    click(rowByLabel(DIRS[1]).querySelector(".neo-gallery-dir-remove-btn"));
    await flush(40);

    assert.equal(document.querySelector(".neo-gallery-dir-modal-overlay"), overlay,
        "遮罩应是同一个元素：弹窗未被拆掉重建");
    assert.deepEqual(labels(), [...BUILTIN, DIRS[0], DIRS[2], "Lora"]);
    assert.equal(removeCalls()[0].body.path, DIRS[1]);
});

test("取消确认：不提交移除请求，行与弹窗都保留", async () => {
    setup();
    setConfirmAnswer(false);
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);
    const overlay = document.querySelector(".neo-gallery-dir-modal-overlay");

    click(rowByLabel(DIRS[0]).querySelector(".neo-gallery-dir-remove-btn"));
    await flush(40);

    assert.equal(removeCalls().length, 0, "取消确认不应发出 remove 请求");
    assert.ok(labels().includes(DIRS[0]), "被取消的目录行应留在列表里");
    assert.equal(document.querySelector(".neo-gallery-dir-modal-overlay"), overlay);
});
