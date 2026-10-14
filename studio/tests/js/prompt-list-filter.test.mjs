// L2：预设列表的过滤便签（图像 / 视频 / 配方）——分类归属、默认档与选择持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { SKILLS, createAgentNode, uiRoot } from "./helpers/node-ui.mjs";

// 图像提示词（presets/custom 根与普通子目录）、视频提示词（presets/video/…）、多行集合
const PROMPTS = [
    { name: "古风礼服", tags: [], source: "presets", _mtime: 3 },
    { name: "精美图像提示词/女孩窗边正面", tags: [], source: "presets", _mtime: 2 },
    { name: "video/couple/地铁通勤", tags: [], source: "presets", _mtime: 4 },
    { name: "video/minimax/K-pop", tags: [], source: "presets", _mtime: 1 },
    { name: "collections/portraits-1", tags: [], source: "presets", _mtime: 5 },
];

const RECIPES = [
    { name: "r-image", source: "custom", prompt: "img prompt", assets: [], samples: [], cover: null },
    { name: "r-video", source: "custom", prompt: "vid prompt", assets: [], samples: [], cover: null },
];

const FILTER_KEY = "rs.preset_filter";

beforeEach(() => {
    resetEnv();
    clearRoutes();
    localStorage.removeItem(FILTER_KEY);
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(PROMPTS));
    mockRoute("/rs_recipes/list", () => jsonResponse(RECIPES));
});

async function openList(id) {
    await import("../../web/prompts.js");
    const node = await createAgentNode(id);
    await sleep(250);
    click(uiRoot(node).querySelector(".rs-list-btn"));
    await sleep(120);
    return document.querySelector(".rs-preset-list-overlay");
}

function rowNames(overlay) {
    return Array.from(overlay.querySelectorAll(".rs-preset-item")).map(r => r.dataset.name).sort();
}

function activeTab(overlay) {
    return overlay.querySelector(".rs-preset-tab-active")?.dataset.key;
}

function clickTab(overlay, key) {
    click(Array.from(overlay.querySelectorAll(".rs-preset-tab")).find(t => t.dataset.key === key));
}

test("便签默认选中「图像」，只列非 video 目录的提示词（不含配方）", async () => {
    const overlay = await openList(41);

    assert.equal(activeTab(overlay), "image", "默认落在图像");
    assert.deepEqual(rowNames(overlay), ["collections/portraits-1", "古风礼服", "精美图像提示词/女孩窗边正面"].sort());
});

test("切到「视频」只列 presets/video 下的提示词，并记入 localStorage", async () => {
    const overlay = await openList(42);

    clickTab(overlay, "video");
    await sleep(120);

    assert.equal(activeTab(overlay), "video");
    assert.deepEqual(rowNames(overlay), ["video/couple/地铁通勤", "video/minimax/K-pop"]);
    assert.equal(localStorage.getItem(FILTER_KEY), "video", "选择写入 localStorage 供下次沿用");
});

test("切到「配方」只列配方条目", async () => {
    const overlay = await openList(43);

    clickTab(overlay, "recipe");
    await sleep(120);

    assert.equal(activeTab(overlay), "recipe");
    assert.deepEqual(rowNames(overlay), ["r-image", "r-video"]);
    assert.equal(localStorage.getItem(FILTER_KEY), "recipe");
});

test("重新打开节点沿用上次选择的便签", async () => {
    localStorage.setItem(FILTER_KEY, "recipe");

    const overlay = await openList(44);

    assert.equal(activeTab(overlay), "recipe", "恢复上次选择而非回到默认图像");
    assert.deepEqual(rowNames(overlay), ["r-image", "r-video"]);
});