// Neo Gallery 目录管理：云端预设目录逐卡隐藏，标题栏手动刷新云端索引。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog, click } from "./setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

const BASE = ["Output", "Input", "local_bookmarks", "civitai_bookmarks", "Lora"];
const BASE_LABELS = ["Output", "Input", "本地收藏", "C站收藏", "Lora"];

async function makeGallery() {
    await loadNeoGallery();
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    gallery.loadGallery = async () => {};
    gallery.list.sortAndDisplayImages = () => {};
    return gallery;
}

function rows() {
    return [...document.querySelectorAll(".neo-gallery-dir-item")];
}

function labels() {
    return [...document.querySelectorAll(".neo-gallery-dir-item .neo-gallery-dir-path")].map((el) => el.textContent);
}

function calls(path, action) {
    return fetchLog.filter((c) => c.path === path && (action === undefined || c.body?.action === action));
}

async function openModal(gallery) {
    await gallery.settings.buildDirModal(gallery);
    return rows();
}

function setup(order) {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({
        custom_directories: [], home_order: order, hidden_directories: [],
    }));
    mockRoute("/neo_gallery/save_settings", () => jsonResponse({ success: true }));
}

test("云端预设目录成行：☁ 标签、有隐藏按钮、没有移除按钮", async () => {
    setup([...BASE, "Cloud Presets/仙侠玄幻人物", "Cloud Presets/26-06-25"]);
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    assert.deepEqual(labels(), [...BASE_LABELS, "☁ 仙侠玄幻人物", "☁ 26-06-25"]);
    for (const row of items.slice(BASE.length)) {
        assert.ok(row.querySelector(".neo-gallery-dir-ctl-btn"), "云端目录行应有隐藏按钮");
        assert.equal(row.querySelector(".neo-gallery-dir-remove-btn"), null, "云端目录行不应有移除按钮");
    }
});

test("隐藏云端目录：按卡片路径提交 set_hidden", async () => {
    setup([...BASE, "Cloud Presets/仙侠玄幻人物"]);
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    click(items[BASE.length].querySelector(".neo-gallery-dir-ctl-btn:not(.neo-gallery-dir-char-btn)"));
    await flush();
    assert.deepEqual(calls("/neo_gallery/save_settings", "set_hidden")[0].body,
        { action: "set_hidden", path: "Cloud Presets/仙侠玄幻人物", hidden: true });
    assert.ok(rows()[BASE.length].classList.contains("is-hidden"), "隐藏后该行应标记 is-hidden");
});

test("刷新索引按钮：POST sync_oss 后新云端目录立刻成行", async () => {
    const order = [...BASE, "Cloud Presets/仙侠玄幻人物"];
    setup(order);
    mockRoute("/neo_gallery/sync_oss", () => {
        order.push("Cloud Presets/26-06-25");
        return jsonResponse({ success: true, directories: 2, items: 85 });
    });
    const gallery = await makeGallery();
    await openModal(gallery);
    const btn = document.querySelector(".neo-gallery-dir-modal-refresh");
    assert.ok(btn, "标题栏应有刷新索引按钮");
    click(btn);
    await flush();
    assert.equal(calls("/neo_gallery/sync_oss").length, 1);
    assert.equal(calls("/neo_gallery/sync_oss")[0].method, "POST");
    assert.deepEqual(labels(), [...BASE_LABELS, "☁ 仙侠玄幻人物", "☁ 26-06-25"]);
    assert.equal(gallery.app.extensionManager.toast.added.length, 1, "刷新成功应弹 toast");
});

test("刷新索引失败：报后端原因，列表不动", async () => {
    setup([...BASE, "Cloud Presets/仙侠玄幻人物"]);
    mockRoute("/neo_gallery/sync_oss", () => jsonResponse({ success: false, error: "OSS not configured" }));
    const gallery = await makeGallery();
    await openModal(gallery);
    click(document.querySelector(".neo-gallery-dir-modal-refresh"));
    await flush();
    assert.equal(calls("/neo_gallery/sync_oss").length, 1);
    assert.deepEqual(labels(), [...BASE_LABELS, "☁ 仙侠玄幻人物"]);
    const toast = gallery.app.extensionManager.toast.added[0];
    assert.equal(toast.severity, "error");
    assert.equal(toast.detail, "OSS not configured");
});
