// fetch 拦截器：按 URL pathname 路由到 fixture，记录全部调用供 golden 断言。
const routes = new Map();

export const fetchLog = [];
export const missingRoutes = [];

export function mockRoute(path, responder) {
    routes.set(path, responder);
}

export function clearRoutes() {
    routes.clear();
}

export function resetFetchLog() {
    fetchLog.length = 0;
    missingRoutes.length = 0;
}

export function jsonResponse(body, status = 200) {
    return { __spec: true, status, body };
}

export function sseResponse(lines) {
    return { __spec: true, status: 200, sse: Array.isArray(lines) ? lines : [lines] };
}

const encoder = new TextEncoder();

function makeReader(chunks) {
    let i = 0;
    return {
        async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
        },
        releaseLock() {},
    };
}

function makeResponse({ status, bodyText, sseLines }) {
    const ok = status >= 200 && status < 300;
    return {
        ok,
        status,
        async json() {
            return JSON.parse(bodyText);
        },
        async text() {
            return bodyText;
        },
        body: sseLines ? { getReader: () => makeReader(sseLines) } : null,
    };
}

function normalize(spec) {
    const resolved = spec && typeof spec === "object" && !spec.__spec ? jsonResponse(spec) : spec;
    if (!resolved) return { status: 204, bodyText: "" };
    const status = resolved.status ?? 200;
    if (resolved.sse) {
        const chunks = resolved.sse.map((line) => (line.endsWith("\n") ? line : line + "\n"));
        return { status, bodyText: chunks.join(""), sseLines: chunks };
    }
    const body = resolved.body;
    return { status, bodyText: typeof body === "string" ? body : JSON.stringify(body ?? null) };
}

export async function handleFetch(input, init = {}) {
    const raw = typeof input === "string" ? input : String(input?.url ?? input);
    const url = new URL(raw, "http://test.local/");
    const method = String(init.method || "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            /* 保留原始字符串 */
        }
    } else if (body) {
        body = "[non-json]";
    }
    const call = { path: url.pathname, method, body };
    fetchLog.push(call);

    const responder = routes.get(url.pathname);
    if (!responder) {
        missingRoutes.push(`${method} ${url.pathname}`);
        return makeResponse({ status: 501, bodyText: JSON.stringify({ error: `no mock for ${url.pathname}` }) });
    }
    const spec = typeof responder === "function" ? await responder(body, call) : responder;
    const { status, bodyText, sseLines } = normalize(spec);
    return makeResponse({ status, bodyText, sseLines });
}

export function installFetch() {
    globalThis.fetch = (input, init) => handleFetch(input, init);
}
