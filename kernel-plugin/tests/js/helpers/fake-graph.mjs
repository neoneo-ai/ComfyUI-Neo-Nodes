// LiteGraph 节点/图的测试替身：只实现 Neo-Nodes 前端读到的字段与方法。
let nextLinkId = 1;

export function resetLinkIds() {
    nextLinkId = 1;
}

export function makeWidget(name, value = "", extra = {}) {
    return {
        name,
        value,
        type: typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "INT" : "STRING",
        options: {},
        ...extra,
    };
}

export function slot(name, type = "STRING") {
    return { name, type, link: null };
}

export function outSlot(name, type = "STRING") {
    return { name, type, links: [] };
}

export function makeGraph() {
    const graph = {
        _nodes: [],
        links: {},
        dirtyCalls: 0,
        setDirtyCanvas() {
            graph.dirtyCalls += 1;
        },
        add(node) {
            node.graph = graph;
            graph._nodes.push(node);
            return node;
        },
        getNodeById(id) {
            return graph._nodes.find((n) => String(n.id) === String(id)) ?? null;
        },
    };
    return graph;
}

export function makeNode({
    id = 1,
    type = "NeoPromptAgent",
    title = "",
    widgets = [],
    inputs = [],
    outputs = [],
    properties = {},
    graph = null,
} = {}) {
    const node = {
        id,
        type,
        title,
        properties,
        widgets: [...widgets],
        inputs,
        outputs,
        size: [400, 300],
        minWidth: 0,
        minHeight: 0,
        graph,
        domWidgets: [],
        addDOMWidget(name, widgetType, el) {
            const w = { name, type: widgetType, el };
            node.widgets.push(w);
            node.domWidgets.push(w);
            return w;
        },
        setSize(size) {
            node.size = [...size];
        },
    };
    if (graph) addNode(graph, node);
    return node;
}

export function addNode(graph, node) {
    node.graph = graph;
    graph._nodes.push(node);
    return node;
}

export function connect(graph, from, to, { fromSlot = 0, toSlot = 0, type = "STRING" } = {}) {
    const id = nextLinkId++;
    const link = {
        id,
        origin_id: from.id,
        target_id: to.id,
        origin_slot: fromSlot,
        target_slot: toSlot,
        type,
    };
    graph.links[id] = link;
    if (from.outputs[fromSlot]) {
        const src = from.outputs[fromSlot];
        src.links = Array.isArray(src.links) ? src.links : [];
        src.links.push(id);
    }
    if (to.inputs[toSlot]) to.inputs[toSlot].link = id;
    return link;
}

// prompts.py INPUT_TYPES 的镜像：NeoPromptAgent / NeoPromptGenerator
export function agentWidgets(values = {}) {
    return [
        makeWidget("prompt", values.prompt ?? ""),
        makeWidget("disable_text_input", values.disable_text_input ?? false),
        makeWidget("auto_generate", values.auto_generate ?? false),
        makeWidget("quick_input", values.quick_input ?? ""),
        makeWidget("skill_id", values.skill_id ?? ""),
        makeWidget("quick_input_used", values.quick_input_used ?? false),
        makeWidget("random_enabled", values.random_enabled ?? false),
        makeWidget("random_count", values.random_count ?? 1),
        makeWidget("instance_uid", values.instance_uid ?? ""),
    ];
}

// prompts.py INPUT_TYPES 的镜像：NeoPrompts（文本 widget 名为 text）
export function encoderWidgets(values = {}) {
    return [
        makeWidget("text", values.text ?? ""),
        makeWidget("disable_text_input", values.disable_text_input ?? false),
        makeWidget("auto_generate", values.auto_generate ?? false),
        makeWidget("quick_input", values.quick_input ?? ""),
        makeWidget("skill_id", values.skill_id ?? ""),
        makeWidget("quick_input_used", values.quick_input_used ?? false),
        makeWidget("random_enabled", values.random_enabled ?? false),
        makeWidget("random_count", values.random_count ?? 1),
        makeWidget("instance_uid", values.instance_uid ?? ""),
    ];
}
