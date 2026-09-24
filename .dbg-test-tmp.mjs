import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, fetchLog, flush } from "./tests/js/setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("./web/gallery.js"));
    return NeoGallery;
}

function makeGallery() {
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    return gallery;
}

function makeDirViewGallery() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/delete", (body) => ({ success: true, deleted: body.filename }));
    const gallery = makeGallery();
    let refreshCount = 0;
    gallery.list = { sortAndDisplayImages: async () => { refreshCount += 1; } };
    gallery.currentView = { mode: "directory", source: "Output", categoryPath: [] };
    gallery._currentDirStructure = {
        subdirs: {},
        items: [
            { name: "a", filename: "a.png", subfolder: "Output" },
            { name: "b", filename: "b.png", subfolder: "Output" },
        ],
    };
    gallery._currentDirImages = [...gallery._currentDirStructure.items];
    return { gallery, get refreshCount() { return refreshCount; } };
}

test("目录视图批量删除后同步 _currentDirStructure 缓存并刷新列表", async () => {
    await loadNeoGallery();
    const { gallery, refreshCount } = makeDirViewGallery();

    gallery.toggleSelection("a", "Output");
    const origDeleteItem = gallery.deleteItem.bind(gallery);
    let deleteItemRan = false;
    gallery.deleteItem = async (...args) => { deleteItemRan = true; return origDeleteItem(...args); };
    try {
        await gallery.deleteSelected();
    } catch (e) {
        console.log("DELETESELECTED THREW:", e && e.message, e && e.stack);
    }
    await flush();
    console.log("deleteItemRan:", deleteItemRan, "currentView:", JSON.stringify(gallery.currentView), "structure:", !!gallery._currentDirStructure, "list:", typeof gallery.list?.sortAndDisplayImages);
    assert.deepEqual(
        gallery._currentDirStructure.items.map((i) => i.name),
        ["b"],
        "被删项应从目录结构缓存移除，重绘不再显示旧卡片"
    );
    assert.equal(refreshCount, 1, "删除后应触发一次列表重绘");
});
