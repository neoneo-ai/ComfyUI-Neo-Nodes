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

// sidebarTab：模拟 ComfyUI 左侧栏 tab 切换（记录 activeSidebarTabId 赋值历史）
export function resetSidebarTab() {
    appState._sidebarTab = { activeSidebarTabId: null, history: [] };
    let cur = null;
    Object.defineProperty(appState._sidebarTab, "activeSidebarTabId", {
        configurable: true,
        get() { return cur; },
        set(v) { cur = v; appState._sidebarTab.history.push(v); },
    });
}
Object.defineProperty(app.extensionManager, "sidebarTab", {
    configurable: true,
    get() { return appState._sidebarTab ?? null; },
    set(v) { appState._sidebarTab = v; },
});

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
    appState._sidebarTab = null;
}
