// 配方列表卡片：多段导演配方点缩略图直接进编辑器（跳过详情）；普通配方仍打开详情。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

test("配方列表：多段导演配方点缩略图直接打开编辑器，普通配方仍打开详情", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [] },
        { name: "normal-recipe", source: "custom", prompt: "hello", assets: [{ kind: "image", file: "a.png" }], samples: [] },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    const covers = Array.from(panel.querySelectorAll(".neo-recipes-card-cover"));
    assert.equal(covers.length, 2, "两个配方卡片");

    // 多段导演配方（第一个）：点缩略图 → 打开编辑器浮层，不打开详情
    covers[0].click();
    await sleep(80);
    assert.ok(document.querySelector(".neo-director-overlay"), "导演配方点缩略图打开编辑器");
    assert.equal(document.querySelector(".neo-recipes-detail"), null, "未打开详情浮层");

    // 关闭编辑器，再测普通配方
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);

    // 普通配方（第二个）：点缩略图 → 打开详情浮层，不打开编辑器
    covers[1].click();
    await sleep(30);
    assert.ok(document.querySelector(".neo-recipes-detail"), "普通配方点缩略图打开详情");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "未打开编辑器");
});
