/**
 * slash-picker.js
 * 输入框 / 技能快捷菜单：在快捷输入框输入 / 唤起，随输入实时过滤 skill 列表（按 name/id/tags，含中文拼音），
 * ↑/↓/Home/End 移动高亮、Enter/Tab 提交当前高亮项（写入 skill 下拉并清除 /xxx）、Esc 关闭。
 * 只过滤不自动提交：始终需要按一次键确认，不会边打边跳。
 */

import { mkEl } from "./dom-utils.js";
import { CATEGORY_LABELS } from "./skill.js";

function createSlashSkillPicker({ quickInput, skillSelector, listSkills }) {
    let pickerEl = null; // 已打开的弹层句柄：防止重复叠加，关闭时置空

    async function openSlashSkillPicker() {
        if (pickerEl) return;
        // / 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入
        const sel = quickInput.selectionStart || 0;
        const slashIndex = sel - 1;
        if (slashIndex < 0 || quickInput.value[slashIndex] !== "/") return;

        const skills = await listSkills();
        // await 期间用户可能改动了输入：/ 不在原位置则放弃
        if (quickInput.value[slashIndex] !== "/") return;

        let activeIndex = 0;
        let currentItems = [];

        // 提交当前选中 skill：写入下拉（仅当 option 存在，避免清空已有选择）、清除 /query、关闭弹层
        const commitSkill = (skill) => {
            closePicker();
            if (!skill || quickInput.value[slashIndex] !== "/") return;
            if ([...skillSelector.options].some(o => o.value === skill.id)) {
                skillSelector.value = skill.id;
                skillSelector.dispatchEvent(new Event("change", { bubbles: true }));
            }
            // 保留 / 之前的内容与光标之后的内容，删除中间的 /query
            const caret = quickInput.selectionStart || 0;
            const before = quickInput.value.slice(0, slashIndex);
            const after = quickInput.value.slice(caret);
            quickInput.value = before + after;
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(before.length, before.length);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
        };

        // 按 query 过滤：name / id / tags（含后端追加的中文拼音标签）任一包含（忽略大小写）；空 query 返回全量并按分类 order 稳定排序
        const filterSkills = (query) => {
            const q = (query || "").trim().toLowerCase();
            const matched = skills.filter(s => {
                if (!q) return true;
                if ((s.name || "").toLowerCase().includes(q)) return true;
                if ((s.id || "").toLowerCase().includes(q)) return true;
                for (const t of (s.tags || [])) {
                    if (t && String(t).toLowerCase().includes(q)) return true;
                }
                return false;
            });
            if (!q) {
                matched.sort((a, b) =>
                    ((CATEGORY_LABELS[a.category]?.order ?? 99) - (CATEGORY_LABELS[b.category]?.order ?? 99)) ||
                    String(a.name || a.id).localeCompare(String(b.name || b.id))
                );
            }
            return matched;
        };

        const picker = mkEl("div", "rs-slash-picker");
        const list = mkEl("div", "rs-slash-picker-list");
        picker.append(list);
        pickerEl = picker;
        document.body.appendChild(picker); // 挂 body + fixed：quickInputWrapper 的 overflow 会裁剪内部弹层

        const rowEls = () => Array.from(list.querySelectorAll(".rs-slash-picker-row"));
        const syncActive = () => {
            rowEls().forEach((r, i) => r.classList.toggle("rs-picker-row-active", i === activeIndex));
            const rows = rowEls();
            const activeEl = rows[activeIndex];
            // 只滚动列表内部，避免 scrollIntoView 连带滚动祖先导致弹层整体偏离
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) list.scrollTop = rowTop;
                else if (rowBottom > listBottom) list.scrollTop = rowBottom - list.clientHeight;
            }
        };
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls().length - 1, idx));
            syncActive();
        };

        // 重建行：渲染当前过滤结果，高亮索引钳制到范围内
        const render = (query) => {
            list.innerHTML = "";
            currentItems = filterSkills(query);
            if (!currentItems.length) {
                const empty = mkEl("div", "rs-slash-picker-empty");
                empty.textContent = "无匹配 skill";
                list.appendChild(empty);
                activeIndex = 0;
                return;
            }
            currentItems.forEach((s, idx) => {
                const row = mkEl("div", "rs-slash-picker-row rs-picker-row");
                const name = mkEl("span", "rs-slash-picker-name");
                name.textContent = (s.needs_image ? "📷 " : "") + (s.name || s.id);
                const meta = mkEl("span", "rs-slash-picker-meta");
                const cat = CATEGORY_LABELS[s.category] ? s.category : "image_enhance";
                meta.textContent = CATEGORY_LABELS[cat].label;
                row.append(name, meta);
                row.addEventListener("click", () => commitSkill(s));
                row.addEventListener("mousemove", () => setActiveRow(idx));
                list.appendChild(row);
            });
            activeIndex = Math.max(0, Math.min(activeIndex, currentItems.length - 1));
            syncActive();
        };

        let handleKey = null;
        let handleInputChange = null;
        const closePicker = () => {
            document.removeEventListener("mousedown", onOutside);
            if (handleKey) document.removeEventListener("keydown", handleKey, true);
            if (handleInputChange) quickInput.removeEventListener("input", handleInputChange);
            pickerEl = null;
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target)) closePicker();
        };
        setTimeout(() => document.addEventListener("mousedown", onOutside), 0);

        // 输入变化：/ 被删或 query 出现空白则关闭，否则重新过滤（不自动提交）。焦点留在 quickInput，继续打字即更新 value 触发这里。
        handleInputChange = () => {
            if (quickInput.value[slashIndex] !== "/") { closePicker(); return; }
            const caret = quickInput.selectionStart || 0;
            const query = quickInput.value.slice(slashIndex + 1, caret);
            if (/\s/.test(query)) { closePicker(); return; }
            render(query);
        };
        quickInput.addEventListener("input", handleInputChange);

        // 键盘：document 捕获阶段拦截，先于 llm-chat 的 quickInput Enter/发送处理。
        // 可打印字符放行（让 value 更新触发过滤）；↑/↓/Home/End 移动高亮、Enter/Tab 提交、Esc 关闭。
        handleKey = (e) => {
            switch (e.key) {
                case "ArrowDown": e.preventDefault(); e.stopPropagation(); setActiveRow(activeIndex + 1); break;
                case "ArrowUp": e.preventDefault(); e.stopPropagation(); setActiveRow(activeIndex - 1); break;
                case "Home": e.preventDefault(); e.stopPropagation(); setActiveRow(0); break;
                case "End": e.preventDefault(); e.stopPropagation(); setActiveRow(rowEls().length - 1); break;
                case "Enter":
                case "Tab": e.preventDefault(); e.stopPropagation(); commitSkill(currentItems[activeIndex]); break;
                case "Escape": e.preventDefault(); closePicker(); break;
            }
        };
        document.addEventListener("keydown", handleKey, true);

        // 焦点保留在 quickInput：继续打字即过滤，方向键/回车由上面的捕获监听接管
        render(quickInput.value.slice(slashIndex + 1, quickInput.selectionStart || 0));
        setTimeout(() => setActiveRow(0), 0);

        // 定位：锚定到输入框下方（fixed 覆盖层，getBoundingClientRect 已含画布缩放），超视口则上翻/靠边
        const r = quickInput.getBoundingClientRect();
        const width = 340;
        let left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - width));
        let top = r.bottom + 4;
        const estHeight = 220;
        if (top + estHeight > window.innerHeight - 8) top = Math.max(8, r.top - estHeight - 4);
        picker.style.left = left + "px";
        picker.style.top = top + "px";
        picker.style.width = width + "px";
    }

    return openSlashSkillPicker;
}

export { createSlashSkillPicker };

