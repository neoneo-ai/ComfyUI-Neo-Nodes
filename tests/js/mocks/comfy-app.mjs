// ComfyUI `app` 单体的测试替身。只实现 Neo-Nodes 前端真正用到的成员：
// graph / nodeOutputs / canvas / graphToPrompt / loadGraphData / loadApiJson / extensionManager(toast, renderMarkdownToHtml)
export const appState = {
    extensions: [],
    graph: null,
    nodeOutputs: {},
    toasts: [],
    loaded: [],
    promptGraph: null, // graphToPrompt() 的返回值
    promptGraphArg: null, // graphToPrompt(graph) 收到的子图（内嵌工作流编辑器保存路径）
    nodeDefs: {}, // /object_info 缓存：{ type: def }
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
    canvas: null, // 画布（LGraphCanvas）替身：测试里按需挂 fitViewToSelectionAnimated 等成员
    async graphToPrompt(graph) {
        appState.promptGraphArg = graph ?? null;
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
    getNodeDef(type) {
        return appState.nodeDefs[type] ?? null;
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

// extensionManager.workflow：工作流 tab store 替身（activeWorkflow + $subscribe → unsubscribe）
export function installWorkflowStore(activeWorkflow) {
    const listeners = new Set();
    const store = {
        activeWorkflow,
        $subscribe(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
    };
    app.extensionManager.workflow = store;
    return {
        store,
        setActive(wf) {
            store.activeWorkflow = wf;
            for (const cb of Array.from(listeners)) cb();
        },
        listenerCount: () => listeners.size,
    };
}
export function clearWorkflowStore() {
    app.extensionManager.workflow = null;
}

export function getExtension(name) {
    return appState.extensions.find((e) => e?.name === name) ?? null;
}

export function resetAppState() {
    appState.extensions.length = 0;
    appState.graph = null;
    appState.nodeOutputs = {};
    app.canvas = null;
    appState.toasts.length = 0;
    appState.loaded.length = 0;
    appState.promptGraph = null;
    appState.promptGraphArg = null;
    appState._sidebarTab = null;
    appState.nodeDefs = {};
    app.extensionManager.workflow = null;
}
