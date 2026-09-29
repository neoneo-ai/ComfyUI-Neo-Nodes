// Neo Studio 的 `scripts/ui.js` 替身：$el(tag, options, children)。
// 语义与 ComfyUI 前端 $el 对齐（className/id/textContent/innerHTML/style 对象/dataset/
// onXxx 事件/其余走 setAttribute），web/ 模块无需改动即可加载。
export function $el(tag, options = null, children = null) {
    const parts = Array.isArray(tag) ? tag : [tag];
    const el = document.createElement(parts[0]);
    if (parts.length > 1) el.classList.add(...parts.slice(1));

    if (options && typeof options === "object") {
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined || value === null) continue;
            if (key === "class" || key === "className") {
                el.className = value;
            } else if (key === "id") {
                el.id = value;
            } else if (key === "textContent") {
                el.textContent = value;
            } else if (key === "innerHTML" || key === "html") {
                el.innerHTML = value;
            } else if (key === "style") {
                Object.assign(el.style, value);
            } else if (key === "dataset" && typeof value === "object") {
                Object.assign(el.dataset, value);
            } else if (typeof value === "function") {
                el.addEventListener(key.startsWith("on") ? key.slice(2) : key, value);
            } else if (key === "value") {
                el.value = value;
            } else {
                el.setAttribute(key, value);
            }
        }
    }

    const kids = children == null ? [] : Array.isArray(children) ? children : [children];
    for (const kid of kids) {
        if (kid == null) continue;
        el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return el;
}
