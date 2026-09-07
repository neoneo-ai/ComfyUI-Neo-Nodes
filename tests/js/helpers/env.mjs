// jsdom 环境装配：全局拷贝、确定性随机/UUID、无 canvas 依赖的图片桩、观察者桩、可预测的矩形。
const COPY_GLOBALS = [
    "document", "navigator", "location", "history", "localStorage", "sessionStorage",
    "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "InputEvent", "ClipboardEvent",
    "DragEvent", "File", "FileList", "Blob", "FileReader", "FormData", "XMLHttpRequest",
    "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
    "HTMLCanvasElement", "MutationObserver", "DOMParser", "XMLSerializer", "AbortController",
];

export function installGlobals(win) {
    for (const key of COPY_GLOBALS) {
        if (win[key] === undefined) continue;
        Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    // 插件里 instanceof 用到的 HTML*/SVG* 接口类同样是裸引用，按需全量拷贝。
    for (const key of Object.getOwnPropertyNames(win)) {
        if (!/^(?:HTML|SVG)\w*Element$/.test(key) && !["DocumentFragment", "NodeList", "Text", "Comment", "ShadowRoot"].includes(key)) continue;
        if (win[key] === undefined || globalThis[key] !== undefined) continue;
        Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    for (const fn of ["requestAnimationFrame", "cancelAnimationFrame"]) {
        if (typeof win[fn] === "function") {
            Object.defineProperty(globalThis, fn, { value: win[fn].bind(win), configurable: true, writable: true });
        }
    }
    // 不启用 pretendToBeVisual：jsdom 的动画帧循环会挂住 Node 进程。用定时器实现同等的单帧调度。
    if (typeof globalThis.requestAnimationFrame !== "function") {
        Object.defineProperty(globalThis, "requestAnimationFrame", {
            value: (callback) => setTimeout(() => callback(Date.now()), 16),
            configurable: true,
            writable: true,
        });
        Object.defineProperty(globalThis, "cancelAnimationFrame", {
            value: (handle) => clearTimeout(handle),
            configurable: true,
            writable: true,
        });
    }
    Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
    // marked/purify 是 UMD：在 Node ESM 里挂到 globalThis 而不是 jsdom window，
    // 而插件按浏览器习惯读 window.marked / window.DOMPurify，用惰性取值对齐两边。
    for (const key of ["marked", "DOMPurify"]) {
        Object.defineProperty(win, key, { get: () => globalThis[key], configurable: true });
    }
    const gcs = win.getComputedStyle.bind(win);
    Object.defineProperty(globalThis, "getComputedStyle", { value: gcs, configurable: true, writable: true });
}

const DEFAULT_SEED = 20260808;
let lcgState = DEFAULT_SEED;
let uidCounter = 0;

export function resetDeterminism() {
    lcgState = DEFAULT_SEED;
    uidCounter = 0;
}

export function installDeterminism(win) {
    const random = () => {
        lcgState = (lcgState * 1664525 + 1013904223) >>> 0;
        return lcgState / 4294967296;
    };
    Math.random = random;
    win.Math.random = random;
    const fakeCrypto = {
        randomUUID: () => `uid-${String(++uidCounter).padStart(3, "0")}`,
        getRandomValues: (arr) => {
            for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(random() * 256);
            return arr;
        },
    };
    Object.defineProperty(globalThis, "crypto", { value: fakeCrypto, configurable: true });
    try {
        Object.defineProperty(win, "crypto", { value: fakeCrypto, configurable: true });
    } catch {
        // jsdom 的 crypto 可能不可重定义，插件只用裸 crypto，忽略
    }
}

// jsdom 没有 canvas 后端：图片解码与 toDataURL 用固定桩替代，保证 chip/缩略图流程可测且输出稳定。
export function installMediaStub(win) {
    class FakeImage {
        constructor() {
            this.width = 0;
            this.height = 0;
            this.complete = false;
            this.naturalWidth = 0;
            this.naturalHeight = 0;
            this.onload = null;
            this.onerror = null;
            this._src = "";
        }
        get src() {
            return this._src;
        }
        set src(value) {
            this._src = value;
            queueMicrotask(() => {
                this.width = 8;
                this.height = 6;
                this.naturalWidth = 8;
                this.naturalHeight = 6;
                this.complete = true;
                if (this.onload) this.onload(new globalThis.Event("load"));
            });
        }
        async decode() {
            return undefined;
        }
    }
    Object.defineProperty(win, "Image", { value: FakeImage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "Image", { value: FakeImage, configurable: true, writable: true });

    const proto = win.HTMLCanvasElement.prototype;
    Object.defineProperty(proto, "getContext", {
        value: () => ({ drawImage() {}, fillRect() {}, clearRect() {} }),
        configurable: true,
        writable: true,
    });
    Object.defineProperty(proto, "toDataURL", {
        value: () => "data:image/png;base64/STUB",
        configurable: true,
        writable: true,
    });
}

export function installObserverStub(win) {
    class NoopObserver {
        constructor(cb) {
            this.cb = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    for (const name of ["ResizeObserver", "IntersectionObserver"]) {
        Object.defineProperty(win, name, { value: NoopObserver, configurable: true, writable: true });
        Object.defineProperty(globalThis, name, { value: NoopObserver, configurable: true, writable: true });
    }
}

// jsdom 无布局：矩形全为 0 会让定位代码写出 "NaNpx"。给出固定可预测的矩形，测试可用 el.__rect 覆盖。
export function installRectStub(win) {
    const proto = win.Element.prototype;
    Object.defineProperty(proto, "getBoundingClientRect", {
        value: function getBoundingClientRect() {
            const r = this.__rect;
            if (r) return { ...r, toJSON: () => ({ ...r }) };
            return { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24, toJSON: () => ({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24 }) };
        },
        configurable: true,
        writable: true,
    });
    Object.defineProperty(proto, "getClientRects", {
        value: function getClientRects() {
            return [this.getBoundingClientRect()];
        },
        configurable: true,
        writable: true,
    });
}
