// Neo Gallery LoRA 卡「⋯」扩展菜单：展示 safetensors header 元数据徽章（base_model / dtype）
// 与触发词，逐词点击复制 + 全量复制。缺元数据 / 空触发词时优雅省略。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, clearRoutes, click } from "./setup.mjs";

let copied;
beforeEach(() => {
    resetEnv();
    clearRoutes();
    copied = [];
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
        configurable: true,
        writable: true,
    });
});

function makeGallery() {
    return {
        app: { extensionManager: { toast: { add: () => {} } } },
        maxThumbnailSize: 320,
        displayLabels: true,
        deleteItem() {},
        cleanText(t) { return t; },
        currentView: { source: "Lora", categoryPath: ["SDXL", "mylora"] },
        _selectedItems: new Set(),
    };
}

async function openMenu(image) {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = makeGallery();
    const card = new GalleryCard(gallery);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, image, "Lora/SDXL/mylora", "local", anchor);
    return { card, gallery };
}

test("LoRA 卡菜单：显示 base_model / dtype 徽章与触发词 chip", async () => {
    await openMenu({
        name: "example_01", filename: "example_01.jpg",
        lora_path: "SDXL/mylora.safetensors",
        base_model: "SDXL 1.0", dtype: "F16",
        trigger_words: ["gxt", "cinematic"],
    });
    const badges = [...document.querySelectorAll(".neo-gallery-collect-lora-badge")].map((e) => e.textContent);
    assert.deepEqual(badges, ["SDXL 1.0", "F16"], "应显示 base_model 与 dtype 徽章");
    const chips = [...document.querySelectorAll(".neo-gallery-collect-trigger-chip")].map((e) => e.textContent);
    assert.deepEqual(chips, ["gxt", "cinematic"], "应逐词渲染触发词 chip");
    assert.match(document.querySelector(".neo-gallery-collect-triggers-label").textContent, /触发词（2）/);
});

test("逐词复制：点击 chip 写入该词", async () => {
    await openMenu({
        name: "example_01", filename: "example_01.jpg",
        lora_path: "SDXL/mylora.safetensors",
        trigger_words: ["gxt", "cinematic"],
    });
    const chip = [...document.querySelectorAll(".neo-gallery-collect-trigger-chip")]
        .find((e) => e.textContent === "cinematic");
    click(chip);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, ["cinematic"], "应只复制被点击的触发词");
});

test("全量复制：点「复制全部」写入逗号连接的触发词", async () => {
    await openMenu({
        name: "example_01", filename: "example_01.jpg",
        lora_path: "SDXL/mylora.safetensors",
        trigger_words: ["gxt", "cinematic"],
    });
    click(document.querySelector(".neo-gallery-collect-triggers-copyall"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, ["gxt, cinematic"], "应复制全部触发词");
});

test("缺元数据 / 空触发词：不渲染徽章与触发词区，仅保留发送 Lora 与路径", async () => {
    await openMenu({
        name: "example_01", filename: "example_01.jpg",
        lora_path: "SDXL/mylora.safetensors",
        base_model: "", dtype: "", trigger_words: [],
    });
    assert.equal(document.querySelector(".neo-gallery-collect-lora-badge"), null, "无元数据不显示徽章");
    assert.equal(document.querySelector(".neo-gallery-collect-triggers"), null, "空触发词不显示触发词区");
    assert.ok(document.querySelector(".neo-gallery-collect-lora-path"), "仍显示 lora 路径");
});

test("非 LoRA 卡：不渲染任何 LoRA 元数据块", async () => {
    await openMenu({ name: "photo", filename: "photo.png" });
    assert.equal(document.querySelector(".neo-gallery-collect-lora-badges"), null);
    assert.equal(document.querySelector(".neo-gallery-collect-triggers"), null);
});
