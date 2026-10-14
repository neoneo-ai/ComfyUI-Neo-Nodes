// Neo Gallery 目录管理：内置板块与自定义目录在同一张顺序表里整行拖拽排序。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog } from "./setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

const DIRS = ["F:/data/stars", "F:/data/beauty", "F:/data/wuxia"];
const TOKENS = ["Output", "Input", "local_bookmarks", "civitai_bookmarks"];
const BUILTIN = ["Output", "Input", "本地收藏", "C站收藏"];
const EXPECTED = [...BUILTIN, ...DIRS, "Lora"];

async function makeGallery() {
    await loadNeoGallery();
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    gallery.loadGallery = async () => {};
    gallery.list.sortAndDisplayImages = () => {};
    return gallery;
}

function makeTransfer() {
    const store = {};
    return { setData: (t, v) => { store[t] = v; }, getData: (t) => store[t] ?? "", effectAllowed: "", dropEffect: "" };
}

function dragEvent(type, clientY, transfer) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    ev.clientY = clientY;
    Object.defineProperty(ev, "dataTransfer", { value: transfer });
    return ev;
}

async function openModal(gallery) {
    await gallery.settings.buildDirModal(gallery);
    return [...document.querySelectorAll(".neo-gallery-dir-item")];
}

function labelsInList() {
    return [...document.querySelectorAll(".neo-gallery-dir-item .neo-gallery-dir-path")].map((el) => el.textContent);
}

function reorderCalls() {
    return fetchLog.filter((c) => c.path === "/neo_gallery/save_settings" && c.body?.action === "reorder");
}

function setup() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({ custom_directories: DIRS, hidden_directories: [DIRS[1]] }));
    mockRoute("/neo_gallery/save_settings", () => jsonResponse({ success: true }));
}

test("内置板块与自定义目录同表排序：顺序为 Output/Input/收藏/Lora", async () => {
    setup();
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    assert.deepEqual(labelsInList(), EXPECTED);
    assert.equal(items.length, EXPECTED.length);
    for (const item of items) {
        assert.ok(item.querySelector(".neo-gallery-dir-drag-handle"), "每行应有拖拽手柄");
        assert.equal(item.getAttribute("draggable"), "true");
    }
    assert.equal(document.querySelectorAll(".neo-gallery-dir-ctl-btn").length, EXPECTED.length + 2,
        "每行一个隐藏按钮，Lora 与 C站收藏行各多一个设置按钮");
    assert.equal(document.querySelectorAll(".neo-gallery-dir-remove-btn").length, DIRS.length,
        "只有自定义目录行有删除按钮");
});

test("拖到末行下半区：落位线在下方，整表顺序提交", async () => {
    setup();
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    const transfer = makeTransfer();
    items[4].dispatchEvent(dragEvent("dragstart", 0, transfer));
    assert.ok(items[4].classList.contains("dragging"), "拖拽源行应标记 dragging");

    const last = items[EXPECTED.length - 1];
    last.dispatchEvent(dragEvent("dragover", 20, transfer));
    assert.ok(last.classList.contains("drop-below"), "落位线应在末行下方");

    last.dispatchEvent(dragEvent("drop", 20, transfer));
    await flush();
    const expected = [...TOKENS, DIRS[1], DIRS[2], "Lora", DIRS[0]];
    assert.deepEqual(labelsInList(), [...BUILTIN, DIRS[1], DIRS[2], "Lora", DIRS[0]]);
    assert.deepEqual(reorderCalls()[0].body.paths, expected);
});

test("拖到首行上半区：插到列表最前", async () => {
    setup();
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    const transfer = makeTransfer();
    items[6].dispatchEvent(dragEvent("dragstart", 0, transfer));
    items[0].dispatchEvent(dragEvent("dragover", 4, transfer));
    assert.ok(items[0].classList.contains("drop-above"), "落位线应在首行上方");
    items[0].dispatchEvent(dragEvent("drop", 4, transfer));
    await flush();
    const expected = [DIRS[2], ...TOKENS, DIRS[0], DIRS[1], "Lora"];
    assert.deepEqual(labelsInList(), [DIRS[2], ...BUILTIN, DIRS[0], DIRS[1], "Lora"]);
    assert.deepEqual(reorderCalls()[0].body.paths, expected);
});

test("拖回自己：不落位也不提交", async () => {
    setup();
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    const transfer = makeTransfer();
    items[5].dispatchEvent(dragEvent("dragstart", 0, transfer));
    items[5].dispatchEvent(dragEvent("dragover", 20, transfer));
    assert.ok(!items[5].classList.contains("drop-above") && !items[5].classList.contains("drop-below"));
    items[5].dispatchEvent(dragEvent("drop", 20, transfer));
    await flush();
    assert.deepEqual(labelsInList(), EXPECTED);
    assert.equal(reorderCalls().length, 0);
});

test("dragend 清掉拖拽状态与落位线", async () => {
    setup();
    const gallery = await makeGallery();
    const items = await openModal(gallery);
    const transfer = makeTransfer();
    items[4].dispatchEvent(dragEvent("dragstart", 0, transfer));
    items[7].dispatchEvent(dragEvent("dragover", 20, transfer));
    items[4].dispatchEvent(dragEvent("dragend", 0, transfer));
    assert.ok(!items[4].classList.contains("dragging"));
    assert.ok(!items[7].classList.contains("drop-below"));
    assert.equal(reorderCalls().length, 0);
});
