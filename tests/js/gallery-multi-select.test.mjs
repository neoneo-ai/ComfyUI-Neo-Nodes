// Neo Gallery 多选删除：左上角勾选框选中集合、批量删除只删选中项、只读源过滤。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, fetchLog, flush } from "./setup.mjs";

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

test("toggleSelection 增删选中项并同步底部操作条", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();

    assert.equal(document.querySelector(".neo-gallery-selection-bar"), null);
    gallery.toggleSelection("a.png", "Output");
    assert.equal(gallery._selectedItems.size, 1);
    const bar = document.querySelector(".neo-gallery-selection-bar");
    assert.ok(bar, "选中后应出现操作条");
    assert.match(bar.textContent, /已选 1 项/);

    gallery.toggleSelection("b.png", "Output");
    assert.equal(gallery._selectedItems.size, 2);
    assert.match(document.querySelector(".neo-gallery-selection-bar").textContent, /已选 2 项/);

    // 再点一次取消选中
    gallery.toggleSelection("a.png", "Output");
    assert.equal(gallery._selectedItems.size, 1);
    assert.ok(!gallery._selectedItems.has(gallery._selectionKey("a.png", "Output")));

    gallery.clearSelection();
    assert.equal(gallery._selectedItems.size, 0);
    assert.equal(document.querySelector(".neo-gallery-selection-bar"), null);
});

test("deleteSelected 只删除选中项（POST /neo_gallery/delete 逐项）", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    mockRoute("/neo_gallery/delete", (body) => ({ success: true, deleted: body.filename }));

    gallery.toggleSelection("a.png", "Output");
    gallery.toggleSelection("b.png", "Output");
    // 未选中的 c.png 不应被删除
    await gallery.deleteSelected();
    await flush();

    const deletes = fetchLog.filter((c) => c.path === "/neo_gallery/delete" && c.method === "POST");
    assert.deepEqual(
        deletes.map((c) => [c.body.filename, c.body.subfolder]),
        [["a.png", "Output"], ["b.png", "Output"]]
    );
    assert.equal(gallery._selectedItems.size, 0, "删除后选中集合清空");
    assert.equal(document.querySelector(".neo-gallery-selection-bar"), null);
});

test("deleteSelected 跳过只读源（presets/lora/oss）只删可删除项", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    mockRoute("/neo_gallery/delete", (body) => ({ success: true }));

    assert.equal(gallery.isDeletableItem("x.png", "Output"), true);
    assert.equal(gallery.isDeletableItem("x.png", "presets/风格"), false);
    assert.equal(gallery.isDeletableItem("x.png", "lora/detail"), false);
    assert.equal(gallery.isDeletableItem("x.png", "civitai_bookmarks/m1"), false);
    assert.equal(gallery.isDeletableItem("x.png", "", "oss"), false);
    assert.equal(gallery.isDeletableItem("x.png", "", "local", "presets"), false, "目录名为 presets 时只读");

    // 模拟选择集里混入只读项（如旧状态残留），批量删除也应跳过
    gallery._selectedItems.add(gallery._selectionKey("ok.png", "Output"));
    gallery._selectedItems.add(gallery._selectionKey("ro.png", "presets/风格"));
    await gallery.deleteSelected();
    await flush();

    const deletes = fetchLog.filter((c) => c.path === "/neo_gallery/delete");
    assert.deepEqual(deletes.map((c) => c.body.filename), ["ok.png"], "只读项不应发起删除请求");
});

test("selectAllVisible 只选中当前视图内可删除素材", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    gallery.allDirectories = [
        { name: "Output", source: "local", items: [{ name: "a.png", subfolder: "" }, { name: "b.mp4", subfolder: "" }] },
        { name: "presets", source: "local", items: [{ name: "p.png", subfolder: "" }] },
    ];

    gallery.selectAllVisible();
    assert.deepEqual(
        [...gallery._selectedItems].sort(),
        [gallery._selectionKey("a.png", ""), gallery._selectionKey("b.mp4", "")].sort()
    );
    assert.match(document.querySelector(".neo-gallery-selection-bar").textContent, /已选 2 项/);
});

test("卡片左上角勾选框：可删除来源显示，只读来源不显示，点击切换选中", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const card = new GalleryCard({});
    const toggled = [];
    const gallery = {
        maxThumbnailSize: 200,
        displayLabels: false,
        placeholderImageUrl: "http://test.local/placeholder.png",
        toggleSelection(name, subfolder) { toggled.push([name, subfolder]); },
    };

    const writable = card.createImageElement(gallery, { name: "w.png", filename: "w.png" }, "Output", "Output");
    assert.ok(writable.querySelector(".neo-gallery-select-check"), "可删除来源应显示勾选框");

    const preset = card.createImageElement(gallery, { name: "p.png", filename: "p.png" }, "presets/风格", "presets");
    assert.equal(preset.querySelector(".neo-gallery-select-check"), null, "presets 只读不显示勾选框");

    const oss = card.createImageElement(gallery, { name: "o.png", filename: "o.png" }, "Output", "oss");
    assert.equal(oss.querySelector(".neo-gallery-select-check"), null, "oss 远程来源不显示勾选框");

    // 勾选触发 toggleSelection，且事件不冒泡到容器（不打开灯箱）
    const check = writable.querySelector(".neo-gallery-select-check");
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    await flush();
    assert.deepEqual(toggled, [["w.png", "Output"]]);
});

test("收藏菜单删除项：有勾选时文案变「删除已选素材」并触发批量删除", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const card = new GalleryCard({});
    const calls = [];
    const image = { name: "w.png", filename: "w.png" };

    function openMenu(selected) {
        const gallery = {
            _selectedItems: new Set(["k\u0000a"]),
            deleteItem(name, subfolder) { calls.push(["deleteItem", name, subfolder]); },
            async deleteSelected() { calls.push(["deleteSelected"]); },
            cleanText(t) { return t; },
        };
        if (!selected) gallery._selectedItems.clear();
        card._showCollectMenu(gallery, image, "Output", "local", null);
        const item = document.querySelector(".neo-gallery-collect-item-danger");
        assert.ok(item, "可删除来源应显示删除项");
        return item;
    }

    // 无勾选：原样单项删除
    let item = openMenu(false);
    assert.match(item.textContent, /删除$/);
    assert.ok(!item.textContent.includes("已选"), "未选中时不应出现「已选」文案");
    item.click();
    await flush();
    assert.deepEqual(calls, [["deleteItem", "w.png", "Output"]]);

    // 有勾选：文案变「删除已选素材（N）」，点击走批量删除
    calls.length = 0;
    item = openMenu(true);
    assert.match(item.textContent, /删除已选素材（1）/);
    item.click();
    await flush();
    assert.deepEqual(calls, [["deleteSelected"]]);
});

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
    const view = makeDirViewGallery();
    const { gallery } = view;

    gallery.toggleSelection("a", "Output");
    await gallery.deleteSelected();
    await flush();

    assert.deepEqual(
        gallery._currentDirStructure.items.map((i) => i.name),
        ["b"],
        "被删项应从目录结构缓存移除，重绘不再显示旧卡片"
    );
    assert.deepEqual(gallery._currentDirImages.map((i) => i.name), ["b"]);
    assert.equal(view.refreshCount, 1, "删除后应触发一次列表重绘");
});

test("删光整个目录也会刷新（不依赖 _currentDirImages 非空判断）", async () => {
    await loadNeoGallery();
    const view = makeDirViewGallery();
    const { gallery } = view;

    gallery.toggleSelection("a", "Output");
    gallery.toggleSelection("b", "Output");
    await gallery.deleteSelected();
    await flush();

    assert.equal(gallery._currentDirStructure.items.length, 0);
    assert.equal(gallery._currentDirImages.length, 0);
    assert.equal(view.refreshCount, 1, "删光目录时也必须重绘以显示空态");
});
