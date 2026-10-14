// 命令终端式 ↑/↓ 历史：召回之前用过的输入，localStorage 持久化（去重、最新在前、上限 cap）。
// 「生成素材」弹窗快捷输入 / output 框与 NeoPromptAgent / NeoPromptEncoder 节点快捷输入共用。
export function createQuickInputHistory(quickInput, { storageKey, cap = 20 }) {
    let history = [];
    try { history = JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { history = []; }
    if (!Array.isArray(history)) history = [];

    const save = () => {
        try { localStorage.setItem(storageKey, JSON.stringify(history)); } catch {}
    };

    // 记录一条：去重、最新在前、上限 cap 条
    const record = (text) => {
        const t = String(text ?? "").trim();
        if (!t) return;
        history = [t, ...history.filter((x) => x !== t)].slice(0, cap);
        save();
    };

    let histIndex = -1;   // -1 = 未导航（当前草稿）；0..n-1 = 历史下标
    let histDraft = "";
    const resetHistNav = () => { if (histIndex !== -1) { histIndex = -1; histDraft = quickInput.value; } };
    quickInput.addEventListener("input", resetHistNav);   // 粘贴 / IME 等无按键字符的编辑同样退出导航态
    quickInput.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") { resetHistNav(); return; }
        const val = quickInput.value;
        const onFirstLine = val.slice(0, quickInput.selectionStart).indexOf("\n") === -1;
        const onLastLine = val.slice(quickInput.selectionEnd).lastIndexOf("\n") === -1;
        if (e.key === "ArrowUp" && onFirstLine && history.length > 0) {
            if (histIndex === -1) { histDraft = val; histIndex = 0; }
            else if (histIndex < history.length - 1) histIndex += 1;
            quickInput.value = history[histIndex];
        } else if (e.key === "ArrowDown" && onLastLine && histIndex !== -1) {
            histIndex -= 1;
            quickInput.value = histIndex === -1 ? histDraft : history[histIndex];
        } else return;
        quickInput.setSelectionRange(quickInput.value.length, quickInput.value.length);
        e.preventDefault();
    });

    return { record };
}
