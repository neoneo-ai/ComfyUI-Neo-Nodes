// ComfyUI `api` 单体的测试替身：事件按注册顺序同步派发，并记录监听器数量用于泄漏检查。
const listeners = new Map();

export const apiEventLog = [];

export const api = {
    addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    },
    async fetchApi(path, init = {}) {
        return globalThis.fetch(path, init);
    },
};

export function dispatchApiEvent(type, detail) {
    const arr = listeners.get(type) ?? [];
    apiEventLog.push(`${type} x${arr.length}`);
    for (const fn of [...arr]) fn({ type, detail });
    return arr.length;
}

export function listenerCount(type) {
    return (listeners.get(type) ?? []).length;
}

export function listenerInventory() {
    return [...listeners.entries()]
        .map(([type, arr]) => `${type} x${arr.length}`)
        .sort()
        .join("\n");
}

export function resetApiState() {
    listeners.clear();
    apiEventLog.length = 0;
}
