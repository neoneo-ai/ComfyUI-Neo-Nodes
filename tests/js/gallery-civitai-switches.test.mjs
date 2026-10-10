// Neo Gallery Civitai 开关：关闭后首页不再出现「C站收藏」卡，Lora 板块随总开关消失。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog } from "./setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

// 设置是服务端状态：保存即改写，重读即取回，和真实后端一致。
function setup({ lora = true, bookmark = true, dirs = [] } = {}) {
    const state = { lora, bookmark };
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({
        custom_directories: [],
        civitai_lora_enabled: state.lora,
        civitai_bookmark_enabled: state.bookmark,
    }));
    mockRoute("/neo_gallery/save_settings", (body) => {
        if (body?.action === "save_civitai") {
            if ("enabled" in body) state.lora = !!body.enabled;
            if ("bookmark_enabled" in body) state.bookmark = !!body.bookmark_enabled;
        }
        return jsonResponse({ success: true });
    });
    mockRoute("/neo_gallery/list", () => jsonResponse({ directories: dirs, total: 0 }));
    mockRoute("/neo_bookmark/local", () => jsonResponse({ items: [] }));
    mockRoute("/neo_bookmark/civitai/list", () => jsonResponse({ success: false, disabled: true }));
    return state;
}

async function makeGallery() {
    await loadNeoGallery();
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    await gallery.loadGallerySettings();
    return gallery;
}

function homeCards() {
    return {
        local: document.querySelector(".neo-gallery-local-home") !== null,
        civitai: document.querySelector(".neo-gallery-civitai-home") !== null,
    };
}

function loraToggle() {
    return document.querySelectorAll(".neo-gallery-civitai-toggle input")[0];
}

function bookmarkToggle() {
    return document.querySelectorAll(".neo-gallery-civitai-toggle input")[1];
}

function civitaiSaves() {
    return fetchLog.filter((c) => c.path === "/neo_gallery/save_settings"
        && c.body?.action === "save_civitai");
}

test("开关开启：首页有「本地收藏」与「C站收藏」两张卡", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();

    const cards = homeCards();
    assert.ok(cards.local, "本地收藏卡应存在");
    assert.ok(cards.civitai, "C站收藏卡应存在");
});

test("关闭 C 站收藏：首页不渲染 C站收藏卡，本地收藏不受影响", async () => {
    setup({ bookmark: false });
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();

    assert.ok(homeCards().local, "本地收藏卡仍在");
    assert.equal(homeCards().civitai, false, "关闭后不应出现 C站收藏卡");
});

test("弹窗里关掉 C 站收藏：保存后首页立即重绘并移除该卡", async () => {
    const state = setup({ bookmark: true });
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();
    assert.ok(homeCards().civitai, "初始有卡");

    await gallery.settings.buildDirModal(gallery);
    const input = bookmarkToggle();
    assert.equal(input.checked, true, "开关初始为开启");
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    await flush();

    const saves = civitaiSaves();
    assert.equal(saves.length, 1, "应保存开关状态");
    assert.equal(saves[0].body.bookmark_enabled, false);
    assert.equal(state.bookmark, false, "服务端状态已关闭");
    assert.equal(gallery.civitaiBookmarkEnabled, false, "重读设置后前端同步");
    assert.equal(homeCards().civitai, false, "首页卡已移除");
});

test("弹窗里关掉 C 站 LORA：保存开关并停掉 Lora 轮询", async () => {
    const state = setup({ lora: true });
    const gallery = await makeGallery();
    gallery._loraRefreshTimer = 1;   // 模拟正在轮询
    gallery.stopLoraRefresh = function () { this._loraRefreshTimer = null; };

    await gallery.settings.buildDirModal(gallery);
    const input = loraToggle();
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    await flush();

    const saves = civitaiSaves();
    assert.equal(saves.length, 1, "应保存开关状态");
    assert.equal(saves[0].body.enabled, false);
    assert.equal(state.lora, false, "服务端状态已关闭");
    assert.equal(gallery.civitaiLoraEnabled, false, "重读设置后前端同步");
    assert.equal(gallery._loraRefreshTimer, null, "刷新轮询应停止");
});

test("后端关闭 Lora 总开关时不返回 Lora 目录卡", async () => {
    const loraDir = { name: "Lora", path: "Lora", read_only: true, subdirs: { krea2: { image_count: 1, path: "krea2" } }, root_count: 0 };
    const state = setup({ lora: true, dirs: [loraDir] });
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();
    assert.ok(document.querySelector(".neo-gallery-category-card"), "开启时首页有 Lora 目录卡");

    // 关闭后后端列表里不再有 Lora 板块
    state.lora = false;
    const dirs = [{ name: "Output", path: "Output", subdirs: { a: { image_count: 1 } }, root_count: 0 }];
    mockRoute("/neo_gallery/list", () => jsonResponse({ directories: dirs, total: 0 }));
    await gallery.loadGallery();
    await gallery.list.sortAndDisplayImages();
    const names = gallery.allDirectories.map((d) => d.name);
    assert.deepEqual(names, ["Output"], "首页目录列表不含 Lora");
});
