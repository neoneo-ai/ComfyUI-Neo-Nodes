// Neo Gallery「新建导演配方」（卡片菜单 + 多选操作条）：子文件夹里的图必须先经 copy_to_input
// 落到 input/ 根目录再建配方——导演编辑器的帧一律按 /view?subfolder=（空）解析。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, fetchLog, flush, sleep, click, jsonResponse } from "./setup.mjs";

function toastApp() {
    return { extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } };
}

async function loadModules() {
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    const [{ GalleryCard }, { NeoGallery }] = await Promise.all([
        import("../../web/gallery-card.js"),
        import("../../web/gallery.js"),
    ]);
    return { GalleryCard, NeoGallery };
}

function ffImgs() {
    // 只取时间轴各段行的首帧槽位（统一设置区有同构镜像槽位，不算）
    return [...document.querySelectorAll(".neo-director-segs .neo-director-seg")]
        .map((row) => row.querySelector(".neo-director-setup-seg-thumb img")?.getAttribute("src"))
        .filter(Boolean);
}

test("卡片菜单「新建导演配方」：子文件夹图先经 copy_to_input 落盘，编辑器首帧用落盘后文件名", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await loadModules();
    const copies = [];
    mockRoute("/neo_gallery/copy_to_input", (body, call) => {
        copies.push({ filename: call.query.get("filename"), subfolder: call.query.get("subfolder") });
        return jsonResponse({ success: true, filename: "photo_in.png" });
    });

    const card = new GalleryCard({});
    const gallery = { app: toastApp(), deleteItem() {}, cleanText(t) { return t; } };
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "photo", filename: "photo_2026-09-09_00-43-40.jpg" }, "2026-09-09", "local", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("新建导演配方"));
    assert.ok(item, "图片卡片应显示「新建导演配方」菜单项");
    click(item);
    await flush();
    await sleep(60);

    assert.deepEqual(copies, [{ filename: "photo_2026-09-09_00-43-40.jpg", subfolder: "2026-09-09" }], "应带 filename+subfolder 先拷贝到 input/");
    assert.deepEqual(ffImgs(), ["/view?filename=photo_in.png&subfolder=&type=input"], "首帧缩略图应指向落盘后的文件名（subfolder 为空）");
});

test("卡片菜单「新建导演配方」：input 根目录图不拷贝，直接用原文件名", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await loadModules();

    const card = new GalleryCard({});
    const gallery = { app: toastApp(), deleteItem() {}, cleanText(t) { return t; } };
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "root", filename: "root.jpg" }, "", "local", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("新建导演配方"));
    click(item);
    await flush();
    await sleep(60);

    assert.equal(fetchLog.filter((c) => c.path === "/neo_gallery/copy_to_input").length, 0, "根目录图无需拷贝");
    assert.deepEqual(ffImgs(), ["/view?filename=root.jpg&subfolder=&type=input"]);
});

test("多选操作条「新建导演配方」：仅子文件夹图被拷贝，各段首帧按落盘名建配方并清空选中", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();
    const copies = [];
    mockRoute("/neo_gallery/copy_to_input", (body, call) => {
        copies.push({ filename: call.query.get("filename"), subfolder: call.query.get("subfolder") });
        return jsonResponse({ success: true, filename: "a_in.png" });
    });

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.toggleSelection("a.png", "2026-09-09");
    gallery.toggleSelection("b.png", "");

    await gallery.createDirectorFromSelection();
    await flush();
    await sleep(60);

    assert.deepEqual(copies, [{ filename: "a.png", subfolder: "2026-09-09" }], "只拷贝子文件夹里的图");
    assert.deepEqual(ffImgs(), [
        "/view?filename=a_in.png&subfolder=&type=input",
        "/view?filename=b.png&subfolder=&type=input",
    ]);
    assert.equal(gallery._selectedItems.size, 0, "建配方后选中集合清空");
});

test("多选操作条「新建导演配方」：拷贝失败时报错且不打开编辑器", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: false, error: "Image not found" }, 404));

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.toggleSelection("a.png", "2026-09-09");

    await gallery.createDirectorFromSelection();
    await flush();

    assert.equal(document.querySelector(".neo-director-segs"), null, "拷贝失败不应打开编辑器");
    const toasts = gallery.app.extensionManager.toast.added;
    assert.ok(toasts.some((t) => t.severity === "error" && /无法读取 a\.png/.test(t.detail)), "应提示读取失败");
});
