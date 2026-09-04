/**
 * combo-box.js
 * 可搜索下拉组件（combobox）：输入即过滤、↑↓+Enter 键盘选择、✕ 清空弹出全量列表。
 *
 * 用法：const { box, destroy } = attachComboBox(selectEl, { placeholder, emptyText });
 * 原生 <select> 被移到屏幕外保留为数据源与取值真相——外部代码对 select 的选项填充、
 * style 显隐切换、.value 读写、disabled 切换全部照旧生效，组件自动跟随同步。
 */

// 组件实例注册表：共享「点外关闭」「滚动/缩放重定位」监听，避免随实例数线性增长
const instances = new Set();
let sharedBound = false;
const onDocMouseDown = (e) => {
    instances.forEach((inst) => {
        if (!inst.wrap.contains(e.target) && !inst.listEl.contains(e.target)) inst.closeList();
    });
};
const onReposition = () => {
    instances.forEach((inst) => {
        if (inst.listEl.style.display !== "none") inst.placeList();
    });
};
function bindShared() {
    if (sharedBound) return;
    sharedBound = true;
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
}
function unbindSharedIfIdle() {
    if (instances.size || !sharedBound) return;
    sharedBound = false;
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("resize", onReposition);
    window.removeEventListener("scroll", onReposition, true);
}

function el(tag, className, cssText = "") {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (cssText) n.style.cssText = cssText;
    return n;
}

export function attachComboBox(selectEl, opts = {}) {
    const placeholder = opts.placeholder || "🔍 输入过滤或点击选择...";
    const emptyText = opts.emptyText || "无匹配模型";

    const box = el("div", "rs-model-select-box", "display:none;");

    // 原生 select 移出可视区（外部代码仍会切换它的 display，组件只读不写，避免循环）
    selectEl.style.setProperty("position", "absolute", "");
    selectEl.style.setProperty("left", "-9999px", "");
    selectEl.style.setProperty("top", "0", "");
    selectEl.style.setProperty("width", "10px", "");
    selectEl.style.setProperty("opacity", "0", "");

    const wrap = el("div", "", "position:relative;");
    const inputEl = el("input", "rs-form-input rs-combo-input");
    inputEl.type = "text";
    inputEl.autocomplete = "off";
    inputEl.placeholder = placeholder;
    inputEl.style.paddingRight = "30px";

    // 列表挂在 body 上用 fixed 定位：不被弹窗 overflow 裁剪，下方空间不足时自动向上翻
    const listEl = el("div", "rs-combo-list", "position:fixed;display:none;max-height:220px;overflow-y:auto;background:#222;border:1px solid #555;border-radius:4px;z-index:100000;box-shadow:0 4px 12px rgba(0,0,0,.5);");
    document.body.appendChild(listEl);

    const clearBtn = el("button", "rs-combo-clear", "position:absolute;right:2px;top:50%;transform:translateY(-50%);width:22px;height:22px;line-height:20px;text-align:center;background:none;border:none;color:#888;font-size:13px;cursor:pointer;padding:0;display:none;z-index:1;");
    clearBtn.type = "button";
    clearBtn.textContent = "✕";
    clearBtn.title = "清除输入，显示全部";
    clearBtn.addEventListener("mouseenter", () => { clearBtn.style.color = "#fff"; });
    clearBtn.addEventListener("mouseleave", () => { clearBtn.style.color = "#888"; });

    const items = () => Array.from(listEl.querySelectorAll("[data-value]"));
    let highlight = -1;
    const closeList = () => { listEl.style.display = "none"; highlight = -1; };

    const syncClear = () => {
        clearBtn.style.display = inputEl.value ? "block" : "none";
    };
    const syncInputFromSelect = () => {
        const sel = selectEl.selectedOptions && selectEl.selectedOptions[0];
        inputEl.value = sel ? sel.textContent : "";
        syncClear();
    };

    const placeList = () => {
        const r = inputEl.getBoundingClientRect();
        const vh = window.innerHeight;
        listEl.style.left = r.left + "px";
        listEl.style.width = r.width + "px";
        const need = Math.min(220, listEl.scrollHeight || 220);
        if (vh - r.bottom < Math.max(need, 80) && r.top > vh - r.bottom) {
            listEl.style.top = "";
            listEl.style.bottom = (vh - r.top + 2) + "px";
        } else {
            listEl.style.bottom = "";
            listEl.style.top = (r.bottom + 2) + "px";
        }
    };

    const setHighlight = (idx) => {
        const els = items();
        if (!els.length) return;
        highlight = ((idx % els.length) + els.length) % els.length;
        els.forEach((n, i) => { n.style.background = i === highlight ? "#3a5a8c" : ""; });
        els[highlight].scrollIntoView({ block: "nearest" });
    };

    const renderList = (query) => {
        const q = (query || "").trim().toLowerCase();
        listEl.innerHTML = "";
        highlight = -1;
        Array.from(selectEl.options).forEach((o) => {
            if (q && !o.textContent.toLowerCase().includes(q)) return;
            const item = document.createElement("div");
            item.textContent = o.textContent;
            item.dataset.value = o.value;
            item.style.cssText = "padding:6px 8px;font-size:12px;color:#ccc;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
                (o.value === selectEl.value ? "background:#3a5a8c;" : "");
            if (o.value === selectEl.value) highlight = items().length;
            item.addEventListener("mousedown", (e) => {
                e.preventDefault(); // 避免 input 先失焦把列表关掉
                pickValue(o.value);
            });
            item.addEventListener("mouseenter", () => setHighlight(items().indexOf(item)));
            listEl.appendChild(item);
        });
        if (!listEl.children.length) {
            const empty = el("div", "", "padding:6px 8px;font-size:12px;color:#777;cursor:default;");
            empty.textContent = emptyText;
            listEl.appendChild(empty);
        }
    };

    const openList = () => {
        if (selectEl.disabled) return;
        renderList(inputEl.value);
        listEl.style.display = "block";
        placeList();
    };

    const pickValue = (value) => {
        if (selectEl.value !== value) {
            selectEl.value = value;
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncInputFromSelect();
        closeList();
        inputEl.blur();
    };


    inputEl.addEventListener("focus", () => {
        // 空输入聚焦 → 直接弹出全量列表；有文字时不打扰（等用户输入过滤）
        if (!inputEl.value.trim()) openList();
    });
    inputEl.addEventListener("input", () => {
        syncClear();
        renderList(inputEl.value);
        if (!selectEl.disabled) { listEl.style.display = "block"; placeList(); }
        highlight = -1;
    });
    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (listEl.style.display === "none") openList();
            setHighlight(highlight + 1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(highlight - 1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const els = items();
            const target = els[highlight >= 0 ? highlight : 0];
            if (target) pickValue(target.dataset.value);
        } else if (e.key === "Escape") {
            closeList();
            syncInputFromSelect();
        }
    });
    inputEl.addEventListener("blur", () => setTimeout(closeList, 120));

    // ✕ 清空输入并弹出完整未过滤列表。宿主弹窗可能存在冒泡阶段的事件拦截，
    // 故挂 window 捕获阶段处理（最先于一切祖先拦截器），保证点击必定生效。
    const activateClear = () => {
        inputEl.value = "";
        syncClear();
        renderList("");
        listEl.style.display = "block";
        placeList();
        inputEl.focus();
    };
    const winMouseDown = (e) => {
        if (e.target === clearBtn) { e.preventDefault(); activateClear(); }
    };
    const winClick = (e) => {
        if (e.target === clearBtn) e.stopPropagation();
    };
    window.addEventListener("mousedown", winMouseDown, true);
    window.addEventListener("click", winClick, true);

    // select 的显隐/disabled/选项变化 → 同步盒子可见性、输入框文本和列表内容
    const syncFromSelect = () => {
        box.style.display = selectEl.style.display === "none" ? "none" : "";
        inputEl.disabled = !!selectEl.disabled;
        syncInputFromSelect();
        renderList(inputEl.value);
        if (selectEl.disabled || box.style.display === "none") closeList();
    };
    const observer = new MutationObserver(syncFromSelect);
    observer.observe(selectEl, {
        attributes: true, attributeFilter: ["style", "disabled"], childList: true,
    });

    wrap.appendChild(inputEl);
    wrap.appendChild(clearBtn);
    box.appendChild(wrap);
    box.appendChild(selectEl);

    const inst = { wrap, listEl, closeList, placeList };
    instances.add(inst);
    bindShared();

    return {
        box,
        destroy() {
            observer.disconnect();
            window.removeEventListener("mousedown", winMouseDown, true);
            window.removeEventListener("click", winClick, true);
            listEl.remove();
            instances.delete(inst);
            unbindSharedIfIdle();
        },
    };
}