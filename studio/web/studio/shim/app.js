// Neo Studio 的 `scripts/app.js` 替身：只实现 web/ 模块真正用到的成员。
// - registerExtension / initExtensions：收集扩展并在页面就绪后统一 setup
// - extensionManager：sidebarTab（记录用）、toast（接 toast.js 的 actionToast）、renderMarkdownToHtml
// - ui.settings：localStorage 版设置存储（ComfyUI 主前端的设置系统不在 Studio 里加载）
// - canvas / graph：空画布替身。Studio 没有 LiteGraph 画布，「发送到节点」类功能
//   走这些空结构自然降级为 toast 提示，web/ 模块无需感知差异。
import { api } from "./api.js";
import { actionToast } from "../../toast.js";

const extensions = [];
const sidebarTabs = new Map();

const SETTINGS_KEY = "neo_studio_settings";
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
const settingsStore = loadSettings();
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsStore)); }
const settings = {
    addSetting(def) {
        if (!(def.id in settingsStore)) settingsStore[def.id] = def.defaultValue;
        saveSettings();
    },
    getValue: (id) => settingsStore[id],
    setValue(id, value) { settingsStore[id] = value; saveSettings(); },
};

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SEVERITY = { info: "info", warn: "warning", warning: "warning", success: "success", error: "error" };

export const app = {
    registerExtension(nameOrExt, maybeExt) {
        const ext = typeof nameOrExt === "string" ? maybeExt : nameOrExt;
        extensions.push(ext);
        return ext;
    },
    extensionManager: {
        sidebarTab: { activeSidebarTabId: null },
        registerSidebarTab(tab) { sidebarTabs.set(tab.id, tab); },
        toast: {
            add(t) {
                actionToast({
                    severity: SEVERITY[t.severity] || "info",
                    summary: t.summary,
                    detail: t.detail,
                    actionLabel: t.actionLabel,
                    onAction: t.onAction,
                });
            },
        },
        renderMarkdownToHtml: (text) => escapeHtml(text).replace(/\n/g, "<br>"),
    },
    ui: { settings },
    canvas: { selected_nodes: {} },
    graph: {
        _nodes: [], links: [], name: "",
        getNodeById: () => null, setDirtyCanvas() {}, add() {},
        serialize: () => ({ nodes: [] }),
    },
    api,
};

export function getSidebarTab(id) {
    return sidebarTabs.get(id) || null;
}

/** 依次执行所有已注册扩展的 setup（ComfyUI 里由 app 在画布就绪后做，这里由 Studio 页面触发）。 */
export async function initExtensions() {
    for (const ext of extensions) {
        try {
            await ext.setup?.();
        } catch (e) {
            console.error(`[Neo Studio] extension ${ext?.name} setup failed:`, e);
        }
    }
}
