// ComfyUI `app` 单体的测试替身。只实现 Neo Studio 前端真正用到的成员：
// graph / nodeOutputs / canvas / graphToPrompt / loadGraphData / loadApiJson / extensionManager(toast, renderMarkdownToHtml)
export const appState = {
    extensions: [],
    sidebarTabs: [],
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

const SETTINGS_KEY = "neo_studio_settings";
function loadSettingsStore() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
const settingsStore = loadSettingsStore();
function saveSettingsStore() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsStore)); }

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
    // ui.settings：ComfyUI 设置存储替身，localStorage 版（与 studio 替身 shim/app.js 同形）。
    // gallery.js 的 setup 用它注册缩略图尺寸等设置，更要紧的是 savePluginData / loadPluginData
    // 的往返——getValue 不回读存进去的值，宿主目录记忆这类持久化行为在测试里就全被吞掉。
    ui: {
        settings: {
            addSetting(def) {
                if (!(def.id in settingsStore)) settingsStore[def.id] = def.defaultValue;
                saveSettingsStore();
            },
            getValue: (id) => settingsStore[id],
            setValue(id, value) { settingsStore[id] = value; saveSettingsStore(); },
        },
    },
    extensionManager: {
        toast: {
            add(t) {
                appState.toasts.push(t);
            },
        },
        // 侧栏 tab 注册表：gallery.js 的 setup 靠它挂 neo.gallery / neo.recipes，
        // Studio 宿主用例要把真 tab 定义（带真 NeoGallery 实例的 render）交给替身侧栏
        registerSidebarTab(tab) {
            appState.sidebarTabs.push(tab);
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
    appState.sidebarTabs.length = 0;
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
