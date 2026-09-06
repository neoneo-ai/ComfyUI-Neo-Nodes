// L0：导入冒烟 —— 插件模块在 jsdom + ComfyUI 替身下能求值，导出面稳定。
import test from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const EXPECTED_EXPORTS = {
    "prompt-manager.js": ["createPromptManagerUI"],
    "dom-utils.js": ["mkEl"],
    "node-behavior.js": ["NodeBehaviors"],
    "skill.js": ["listSkills", "renderMarkdown", "populateSkillOptions", "createSkillDropdown"],
    "llm-setting.js": ["createModelConfigForm"],
    "prompt-service.js": ["savePrompt", "loadPrompt", "listPrompts", "randomPrompt", "fileToBase64", "imagesFromClipboard"],
    "recipes.js": ["collectWorkflowAssets", "saveRecipe", "listRecipes", "deleteRecipe", "applyRecipeToWorkflow", "RECIPE_ICON_SVG"],
    "combo-box.js": ["attachComboBox"],
    "workflow-context.js": ["collectWorkflowContext"],
};

const modules = {};

test("插件模块可在 jsdom + ComfyUI 替身下导入", async () => {
    for (const [name, expected] of Object.entries(EXPECTED_EXPORTS)) {
        modules[name] = await import(`../../web/${name}`);
        const missing = expected.filter((key) => modules[name][key] === undefined);
        assert.deepEqual(missing, [], `${name} 缺少导出: ${missing.join(", ")}`);
    }
});

test("prompts.js 注册两个节点扩展", async () => {
    await import("../../web/prompts.js");
    assertGolden(
        "extensions.registered",
        appState.extensions.map((e) => e?.name).sort().join("\n"),
    );
});
