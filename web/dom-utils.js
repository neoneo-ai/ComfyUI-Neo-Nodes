/**
 * dom-utils.js
 * 前端共享 DOM 工具（零依赖，供 prompt-manager / skill / llm-setting / prompts 复用）
 */

export function mkEl(tag, className, styles = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (styles) el.style.cssText = styles;
    return el;
}
