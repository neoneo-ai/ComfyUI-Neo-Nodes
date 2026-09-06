// DOM 结构快照 + golden 比对 + 交互事件驱动。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "golden");
const UPDATE = process.env.NEO_UPDATE_GOLDENS === "1";

const ATTR_KEYS = ["type", "placeholder", "title", "label", "alt", "src", "href", "accept"];

function oneLine(text) {
    return String(text).replace(/\s+/g, " ").trim();
}

function describe(el) {
    let out = el.tagName.toLowerCase();
    if (el.id) out += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    for (const c of cls) out += "." + c;

    const bits = [];
    for (const key of ATTR_KEYS) {
        const value = el.getAttribute?.(key);
        if (value != null && value !== "") bits.push(`${key}=${oneLine(value)}`);
    }
    if (["INPUT", "TEXTAREA"].includes(el.tagName) && typeof el.value === "string" && el.value !== "") {
        bits.push(`val="${oneLine(el.value)}"`);
    }
    if (el.checked) bits.push("checked");
    if (el.disabled) bits.push("disabled");
    if (el.tagName === "OPTION") {
        const v = el.getAttribute("value");
        if (v != null) bits.push(`value=${oneLine(v)}`);
        if (el.selected) bits.push("selected");
    }
    const display = el.style?.display;
    if (display) bits.push(`display=${display}`);
    if (bits.length) out += " <" + bits.join(" ") + ">";
    return out;
}

export function serializeDom(root, depth = 0) {
    const lines = [`${"  ".repeat(depth)}${describe(root)}`];
    const kids = Array.from(root.children ?? []);
    if (!kids.length) {
        const text = oneLine(root.textContent ?? "");
        if (text) lines[0] += ` "${text}"`;
        return lines.join("\n");
    }
    for (const kid of kids) lines.push(serializeDom(kid, depth + 1));
    return lines.join("\n");
}

function diffLines(expected, actual) {
    const a = expected.split("\n");
    const b = actual.split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    const removed = a.slice(i, i + 20).map((l) => `- ${l}`);
    const added = b.slice(i, i + 20).map((l) => `+ ${l}`);
    return [`首个差异在第 ${i + 1} 行（期望 ${a.length} 行，实际 ${b.length} 行）:`, ...removed, ...added].join("\n");
}

export function assertGolden(name, actual) {
    const file = join(GOLDEN_DIR, `${name}.txt`);
    const text = String(actual).replace(/\r\n/g, "\n");
    if (UPDATE || !existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        return;
    }
    const expected = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (expected !== text) assert.fail(`golden 差异 [${name}]\n${diffLines(expected, text)}`);
}

export function domSnapshot(name, root) {
    assertGolden(name, serializeDom(root));
}

// ---- 交互驱动 ----
const win = () => globalThis.window;

export function fire(el, type, init = {}) {
    el.dispatchEvent(new (win().Event)(type, { bubbles: true, ...init }));
}

export function click(el) {
    el.dispatchEvent(new (win().MouseEvent)("click", { bubbles: true, cancelable: true }));
}

export function keydown(el, key, init = {}) {
    el.dispatchEvent(new (win().KeyboardEvent)("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

export function inputText(el, value) {
    el.value = value;
    const len = value.length;
    el.setSelectionRange?.(len, len);
    fire(el, "input");
}

export function changeValue(el, value) {
    el.value = value;
    fire(el, "change");
}

export function makeFile(name, type = "image/png", content = "stub-bytes") {
    return new (win().File)([content], name, { type });
}

export function pasteClipboard(el, files) {
    const ev = new (win().Event)("paste", { bubbles: true });
    const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
    Object.defineProperty(ev, "clipboardData", { value: { items, files }, configurable: true });
    el.dispatchEvent(ev);
}

export function dropFiles(el, files) {
    const ev = new (win().Event)("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
        value: { files, items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })) },
        configurable: true,
    });
    el.dispatchEvent(ev);
}

export function clearBody() {
    document.body.innerHTML = "";
}

export async function flush(times = 12) {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
