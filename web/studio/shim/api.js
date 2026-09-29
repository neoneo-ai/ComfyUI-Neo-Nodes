// Neo Studio 的 `scripts/api.js` 替身：fetchApi（返回 Response）+ WebSocket 事件桥。
// ComfyUI 前端把 WS 消息按 type 派发为同名事件（rs.image_gen.status / rs.prompt.update …），
// 断线重连后补发 "reconnected"；这里照同一契约实现，web/ 模块无需改动。
const clientId = crypto.randomUUID();
const listeners = new Map();

function dispatch(type, detail) {
    const arr = listeners.get(type);
    if (!arr || !arr.length) return;
    for (const fn of [...arr]) {
        try {
            fn({ type, detail });
        } catch (e) {
            console.error(`[Neo Studio] api event ${type}:`, e);
        }
    }
}

let ws = null;
function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${clientId}`);
    ws.onopen = () => dispatch("reconnected");
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg && typeof msg.type === "string") dispatch(msg.type, msg.data);
        } catch { /* 非 JSON 消息忽略 */ }
    };
    ws.onclose = () => setTimeout(connect, 2000);
}

export const api = {
    fetchApi: (path, init) => fetch(path, init),
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
};

connect();
