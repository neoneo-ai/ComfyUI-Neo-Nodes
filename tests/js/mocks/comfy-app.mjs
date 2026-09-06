// ComfyUI `app` 单体的测试替身。只实现 Neo-Nodes 前端真正用到的成员：
// graph / nodeOutputs / graphToPrompt / loadGraphData / loadApiJson / extensionManager(toast, renderMarkdownToHtml)
export const appState = {
    extensions: [],
    graph: null,
    nodeOutputs: {},
    toasts: [],
    loaded: [],
    promptGraph: null, // graphToPrompt() 的返回值
};

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// renderMarkdownToHtml 的回退实现与 skill.js 的最后兜底一致（转义 + <br>），保证 golden 稳定
export function mockRenderMarkdown(text) {
    return escapeHtml(text).replace(/\n/g, "<br>");
}

export const app = {
    registerExtension(nameOrExt, maybeExt) {
        const ext = typeof nameOrExt === "string" ? maybeExt : nameOrExt;
        appState.extensions.push(ext);
        return ext;
    },
    get graph() {
        return appState.graph;
    },
    get nodeOutputs() {
        return appState.nodeOutputs;
    },
    async graphToPrompt() {
        return appState.promptGraph ?? { output: {}, workflow: null };
    },
    async loadGraphData(data, ...rest) {
        appState.loaded.push({ kind: "graph", data, rest });
        return data;
    },
    async loadApiJson(data, name) {
        appState.loaded.push({ kind: "api", data, name });
        return data;
    },
    extensionManager: {
        toast: {
            add(t) {
                appState.toasts.push(t);
            },
        },
        renderMarkdownToHtml: mockRenderMarkdown,
    },
};

export function getExtension(name) {
    return appState.extensions.find((e) => e?.name === name) ?? null;
}

export function resetAppState() {
    appState.extensions.length = 0;
    appState.graph = null;
    appState.nodeOutputs = {};
    appState.toasts.length = 0;
    appState.loaded.length = 0;
    appState.promptGraph = null;
}
