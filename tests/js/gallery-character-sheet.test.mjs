// Neo Gallery 卡片「生成角色图（多视图）」：固定 Qwen Image 2.1 + 单参考图请求体。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, click, flush } from "./setup.mjs";

test("buildCharacterSheetRequest 固定走 qwen_image_21 且不带全局 LoRA", async () => {
    resetEnv();
    clearRoutes();
    const { buildCharacterSheetRequest } = await import("../../web/gallery-card.js");
    const body = buildCharacterSheetRequest("NeoAgent/portrait.png");
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.width, 1920);
    assert.equal(body.height, 1080);
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/portrait.png" }]);
    assert.deepEqual(body.loras, []);
    assert.equal(body.skip_enhance, true);
    assert.equal(body.output_prefix, "CharacterSheet");
    assert.match(body.prompt, /多视图/);
    assert.match(body.prompt, /大头特写/);
    assert.match(body.prompt, /正面全身/);
    assert.match(body.prompt, /侧面全身/);
    assert.match(body.prompt, /背面全身/);
});

test("⋯ 菜单「直达角色输出目录」打开 Output/CharacterSheet", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const card = new GalleryCard({});
    const calls = [];
    const gallery = {
        app: {},
        currentView: { mode: "directory", source: "Output", categoryPath: ["CharacterSheet"] },
        showDirectoryStructure(source, path) { calls.push([source, path]); return Promise.resolve(); },
        deleteItem() {},
    };
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "2026-09-24_00001_", filename: "2026-09-24_00001_.png" }, "CharacterSheet", "Output", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("直达角色输出目录"));
    assert.equal(item?.textContent, "\uD83D\uDCC2 直达角色输出目录");

    click(item);
    await flush();
    assert.deepEqual(calls, [["Output", ["CharacterSheet"]]]);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null);
});
