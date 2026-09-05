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

// 共享镜像 span 测量文本宽度：canvas measureText 对 emoji/CJK 的宽度估算与
// 输入框实际渲染不一致（会偏小导致 ✕ 压字），同排版引擎的 span 才是精确值
let _mirrorSpan = null;
function measureTextWidth(text, refEl) {
    if (!_mirrorSpan) {
        _mirrorSpan = document.createElement("span");
        _mirrorSpan.style.cssText = "position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:pre;";
        document.body.appendChild(_mirrorSpan);
    }
    const cs = getComputedStyle(refEl);
    _mirrorSpan.style.font = cs.font;
    _mirrorSpan.style.letterSpacing = cs.letterSpacing;
    _mirrorSpan.textContent = text;
    return _mirrorSpan.offsetWidth;
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

    // 列表挂在 body 上用 fixed 定位：不被弹窗 overflow 裁剪，下方空间不足时自动向上翻。
    // opts.footerEl 存在时改为 flex 列布局（滚动区 itemsHost + 固定底部工具栏），否则保持原样
    // （整个 listEl 自身滚动）——模型下拉等未传 footer 的既有行为完全不变。
    const hasFooter = !!opts.footerEl;
    const listOpenDisplay = hasFooter ? "flex" : "block";
    const listEl = el("div", "rs-combo-list", hasFooter
        ? "position:fixed;display:none;max-height:260px;overflow:hidden;background:#222;border:1px solid #555;border-radius:4px;z-index:120000;box-shadow:0 4px 12px rgba(0,0,0,.5);flex-direction:column;"
        : "position:fixed;display:none;max-height:220px;overflow-y:auto;background:#222;border:1px solid #555;border-radius:4px;z-index:120000;box-shadow:0 4px 12px rgba(0,0,0,.5);");
    document.body.appendChild(listEl);

    // 行容器：有 footer 时为内部滚动区，无 footer 时即 listEl 自身（保持既有行为）
    let itemsHost = listEl;
    if (hasFooter) {
        const itemsWrap = el("div", "rs-combo-items", "flex:1 1 auto;overflow-y:auto;min-height:0;padding:2px;");
        listEl.appendChild(itemsWrap);
        listEl.appendChild(opts.footerEl);
        itemsHost = itemsWrap;
    }

    const clearBtn = el("button", "rs-combo-clear", "position:absolute;width:16px;height:16px;line-height:16px;text-align:center;background:none;border:none;color:#888;font-size:10px;cursor:pointer;padding:0;display:none;z-index:1;");
    clearBtn.type = "button";
    clearBtn.textContent = "✕";
    clearBtn.title = "清除输入，显示全部";
    clearBtn.addEventListener("mouseenter", () => { clearBtn.style.color = "#fff"; });
    clearBtn.addEventListener("mouseleave", () => { clearBtn.style.color = "#888"; });

    const items = () => Array.from(listEl.querySelectorAll("[data-value]"));
    let highlight = -1;
    const closeList = () => { listEl.style.display = "none"; highlight = -1; };

    const syncClear = () => {
        if (!inputEl.value) { clearBtn.style.display = "none"; return; }
        clearBtn.style.display = "block";
        // ✕ 紧跟文字末尾；文本超出可见区时钳回右缘（与旧行为一致）
        const cs = getComputedStyle(inputEl);
        const tw = measureTextWidth(inputEl.value, inputEl);
        const left = (parseFloat(cs.paddingLeft) || 0) + tw + 2;
        clearBtn.style.right = "auto";
        clearBtn.style.left = Math.min(left, Math.max(2, inputEl.clientWidth - clearBtn.offsetWidth - 2)) + "px";
        // 底部对齐输入框内容区下缘（用户反馈居中仍偏上）
        clearBtn.style.top = (inputEl.offsetTop + (parseFloat(cs.borderTopWidth) || 0) + inputEl.clientHeight - clearBtn.offsetHeight) + "px";
    };
    const syncInputFromSelect = () => {
        const sel = selectEl.selectedOptions && selectEl.selectedOptions[0];
        inputEl.value = sel ? sel.textContent : "";
        // 输入框较窄时长名会被截断，悬停用 title 显示完整选中名
        inputEl.title = sel ? sel.textContent : "";
        syncClear();
    };

    // 原生 select 的 .value 是取值真相，但程序化赋值（如回填已保存模型）不会触发
    // MutationObserver，输入框文本会停在自动选中的首项。包一层 setter：任何 .value
    // 写入都同步输入框，兑现「外部对 select 的 .value 读写组件自动跟随」的约定。
    const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(selectEl, "value", {
        get: () => nativeValueDesc.get.call(selectEl),
        set: (v) => {
            nativeValueDesc.set.call(selectEl, v);
            syncInputFromSelect();
        },
        configurable: true,
    });

    const placeList = () => {
        const r = inputEl.getBoundingClientRect();
        const vh = window.innerHeight;
        listEl.style.left = r.left + "px";
        // opts.listMinWidth：管理型下拉可大幅宽于输入框（右向钳制在视口内）；不传则维持与输入框同宽
        listEl.style.width = Math.max(r.width, Math.min(opts.listMinWidth || 0, window.innerWidth - r.left - 6)) + "px";
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
        itemsHost.innerHTML = "";
        highlight = -1;
        Array.from(selectEl.options).forEach((o) => {
            if (q && !o.textContent.toLowerCase().includes(q)) return;
            const item = document.createElement("div");
            item.dataset.value = o.value;
            if (opts.renderItemExtra) {
                // 管理型下拉：行内右侧留白给操作按钮，标签占满剩余宽度并省略
                item.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;color:#ccc;cursor:pointer;" +
                    (o.value === selectEl.value ? "background:#3a5a8c;" : "");
                const label = document.createElement("span");
                label.textContent = o.textContent;
                label.style.cssText = "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                item.appendChild(label);
            } else {
                item.textContent = o.textContent;
                item.style.cssText = "padding:6px 8px;font-size:12px;color:#ccc;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
                    (o.value === selectEl.value ? "background:#3a5a8c;" : "");
            }
            if (o.value === selectEl.value) highlight = items().length;
            item.addEventListener("mousedown", (e) => {
                e.preventDefault(); // 避免 input 先失焦把列表关掉
                pickValue(o.value);
            });
            item.addEventListener("mouseenter", () => setHighlight(items().indexOf(item)));
            if (opts.renderItemExtra) opts.renderItemExtra(item, o.value, o);
            itemsHost.appendChild(item);
        });
        if (!itemsHost.children.length) {
            const empty = el("div", "", "padding:6px 8px;font-size:12px;color:#777;cursor:default;");
            empty.textContent = emptyText;
            itemsHost.appendChild(empty);
        }
    };

    const openList = () => {
        if (selectEl.disabled) return;
        renderList(inputEl.value);
        listEl.style.display = listOpenDisplay;
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
        if (!selectEl.disabled) { listEl.style.display = listOpenDisplay; placeList(); }
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
        listEl.style.display = listOpenDisplay;
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

    // 初始化时输入框可能尚未布局（节点未渲染/display:none），首次 syncClear 的
    // left/top 会基于全 0 度量算错；尺寸真正就绪/变化时重排 ✕
    const clearRO = new ResizeObserver(() => { if (inputEl.value) syncClear(); });
    clearRO.observe(inputEl);

    const inst = { wrap, listEl, closeList, placeList };
    instances.add(inst);
    bindShared();

    return {
        box,
        // 供行内操作按钮在打开详情弹窗前关闭下拉（避免与弹窗叠加）
        close: () => closeList(),
        destroy() {
            observer.disconnect();
            clearRO.disconnect();
            window.removeEventListener("mousedown", winMouseDown, true);
            window.removeEventListener("click", winClick, true);
            listEl.remove();
            instances.delete(inst);
            unbindSharedIfIdle();
        },
    };
}