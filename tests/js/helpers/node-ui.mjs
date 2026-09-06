// 通过真实扩展注册路径创建节点：beforeRegisterNodeDef -> onNodeCreated。
import { getExtension } from "../mocks/comfy-app.mjs";
import { makeGraph, makeNode, agentWidgets, encoderWidgets, slot, outSlot } from "./fake-graph.mjs";

// /rs_prompts/skills 的测试数据：覆盖 preset/custom、vision/非 vision、多轮/单轮
export const SKILLS = [
    { id: "reverse_prompt", name: "反推提示词", category: "vision", source: "preset", needs_image: true, multi_turn: false },
    { id: "minimax_h3_ref", name: "全参考", category: "vision", source: "preset", needs_image: true, multi_turn: true },
    { id: "story_expand", name: "故事扩写", category: "task", source: "custom", needs_image: false, multi_turn: true },
    { id: "anime_style", name: "动漫风格", category: "style", source: "preset", needs_image: false, multi_turn: false },
];

export async function createNodeViaExtension(extensionName, widgets, nodeId) {
    const ext = getExtension(extensionName);
    if (!ext) throw new Error(`未找到扩展 ${extensionName}，请先 import prompts.js`);
    const nodeTypeDef = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeTypeDef, { name: extensionName }, null);
    if (typeof nodeTypeDef.prototype.onNodeCreated !== "function") {
        throw new Error(`${extensionName} 未挂上 onNodeCreated`);
    }

    const graph = makeGraph();
    const node = makeNode({
        id: nodeId,
        type: extensionName,
        widgets,
        inputs: [slot("text_input", "STRING"), slot("image", "IMAGE")],
        outputs: [outSlot("PROMPT", "STRING")],
        graph,
    });
    nodeTypeDef.prototype.onNodeCreated.call(node);
    return node;
}

export function createAgentNode(id = 7) {
    return createNodeViaExtension("NeoPromptAgent", agentWidgets(), id);
}

export function createEncoderNode(id = 8) {
    return createNodeViaExtension("NeoPromptEncoder", encoderWidgets(), id);
}

export function uiRoot(node) {
    return node.domWidgets[0].el;
}

export function widgetValue(node, name) {
    const w = node.widgets.find((x) => x.name === name);
    return w ? w.value : undefined;
}
