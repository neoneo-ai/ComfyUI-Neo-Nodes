// Neo Studio 外壳：hash 路由（#/gallery #/director #/settings）+ 各视图挂载。
// 功能全部复用 web/ 现有模块（import-map 把 scripts/* 指到 shim）：
// - 素材：NeoGallery（gallery.js 注册的扩展，侧栏 tab 的 render 直接挂进主区）
// - 导演：配方面板（recipes.js）+ 整片生成面板（POST /neo_studio/director/generate）
// - 设置：生图/生视频设置表单 + LLM 设置弹窗
import { app, initExtensions, getSidebarTab } from "./shim/app.js";
import { api } from "./shim/api.js";
import { $el } from "./shim/ui.js";

import "../gallery.js";   // 注册 comfy.neo.gallery 扩展（NeoGallery + 侧栏 tab 定义）
import "../director.js";  // openDirectorEditor 等（配方面板内部使用）
import { createRecipesPanel } from "../recipes.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "../image-gen.js";
import { openLLMSettingsModal } from "../llm-setting.js";

const view = document.getElementById("ns-view");
let directorRecipes = [];   // /neo_studio/version 返回的导演配方名

// ====== 视图缓存：每个 tab 只挂载一次，切换时显隐（保留画廊滚动/编辑状态） ======
const views = new Map();

function ensureView(name, build) {
    if (views.has(name)) return views.get(name);
    const el = $el("div", { className: "ns-page ns-hidden" });
    view.appendChild(el);
    views.set(name, el);
    const p = build(el);
    if (p && typeof p.catch === "function") p.catch(e => console.error(`[Neo Studio] view ${name} build failed:`, e));
    return el;
}

function showView(name) {
    for (const [key, el] of views) el.classList.toggle("ns-hidden", key !== name);
    document.querySelectorAll(".ns-tabs a").forEach(a =>
        a.classList.toggle("active", a.dataset.tab === name));
}

// ====== 素材页：直接借用 Neo Gallery 侧栏 tab 的 render（内部会挂载并加载 gallery.element） ======
function buildGallery(el) {
    const host = $el("div", { className: "ns-gallery-host" });
    el.appendChild(host);
    const tab = getSidebarTab("neo.gallery");
    if (!tab) {
        host.textContent = "Neo Gallery 未加载";
        return;
    }
    tab.render(host).catch(e => {
        console.error("[Neo Studio] gallery render failed:", e);
        host.textContent = "Neo Gallery 加载失败";
    });
}

// ====== 导演页：整片生成面板 + 配方列表 ======
let genState = null;   // 当前整片任务 {task_id, statusEl, barEl, runBtn, cancelBtn}

function updateGenStatus(task) {
    if (!genState || task.task_id !== genState.task_id) return;
    const { statusEl, barEl, fillEl } = genState;
    if (task.status === "queued") {
        statusEl.textContent = `排队中…（${task.recipe}）`;
    } else if (task.status === "running") {
        const p = task.progress;
        statusEl.textContent = p ? `生成中… ${p.value}/${p.max}` : "生成中…";
        if (p) fillEl.style.width = `${Math.round(100 * p.value / p.max)}%`;
    } else if (task.status === "succeeded") {
        statusEl.textContent = `已完成：${task.filename}`;
        genState.resultRow.innerHTML = "";
        const a = $el("a", {
            href: `/view?filename=${encodeURIComponent(task.filename)}`
                + `&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`,
            textContent: `🎬 ${task.filename}（在浏览器中打开）`,
        });
        genState.resultRow.appendChild(a);
        refreshRecipesPanel();
    } else if (task.status === "failed") {
        statusEl.textContent = `失败：${task.error || "未知错误"}`;
    } else if (task.status === "cancelled") {
        statusEl.textContent = "已取消";
    }
    genState.runBtn.disabled = task.status === "queued" || task.status === "running";
    genState.cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
}

let recipesPanelEl = null;
async function refreshRecipesPanel() {
    if (!recipesPanelEl) return;
    const parent = recipesPanelEl.parentNode;
    recipesPanelEl.remove();
    recipesPanelEl = await createRecipesPanel();
    parent.appendChild(recipesPanelEl);
}


async function buildDirector(el) {
    const page = $el("div", { className: "ns-director" });
    el.appendChild(page);

    // --- 整片生成面板 ---
    const recipeSel = $el("select", {}, []);
    const seedInput = $el("input", { type: "number", value: "-1", title: "-1 = 用配方里的种子" });
    const widthInput = $el("input", { type: "number", value: "-1", title: "-1 = 用配方分辨率" });
    const heightInput = $el("input", { type: "number", value: "-1", title: "-1 = 用配方分辨率" });
    const continuityChk = $el("input", { type: "checkbox" });
    continuityChk.checked = true;
    const ctxInput = $el("input", { type: "number", value: "22" });
    const stepsInput = $el("input", { type: "number", value: "-1", title: "-1 = 用技能默认步数" });
    const runBtn = $el("button", { className: "rs-btn ns-gen-run", type: "button", textContent: "🎬 生成整片" });
    const cancelBtn = $el("button", { className: "rs-btn", type: "button", textContent: "取消", style: { display: "none" } });
    const statusEl = $el("div", { className: "ns-gen-status" });
    const barEl = $el("div", { className: "ns-gen-progress" }, [$el("div")]);
    const resultRow = $el("div", { className: "ns-gen-result" });

    function fillRecipeOptions() {
        recipeSel.innerHTML = "";
        for (const name of directorRecipes) {
            recipeSel.appendChild($el("option", { value: name, textContent: name }));
        }
        if (!directorRecipes.length) {
            recipeSel.appendChild($el("option", { value: "", textContent: "（暂无导演配方）" }));
        }
    }

    function stopPolling() {
        if (genState && genState.pollTimer) clearInterval(genState.pollTimer);
        api.removeEventListener("rs.director.status", onStatusEvent);
    }

    function onStatusEvent({ detail }) {
        if (!detail || !detail.task_id) return;
        updateGenStatus(detail);
        if (["succeeded", "failed", "cancelled"].includes(detail.status)) stopPolling();
    }

    runBtn.addEventListener("click", async () => {
        const recipe = recipeSel.value;
        if (!recipe) { statusEl.textContent = "请先新建导演配方"; return; }
        // 空输入归一为 -1（用配方默认），避免 Number("") === 0 被后端当成显式 0
        const num = (input, fallback) => input.value.trim() === "" ? fallback : Number(input.value);
        const body = {
            recipe,
            seed: num(seedInput, -1),
            width: num(widthInput, -1),
            height: num(heightInput, -1),
            continuity: continuityChk.checked,
            context_frames: num(ctxInput, 22),
            steps: num(stepsInput, -1),
        };

        stopPolling();
        runBtn.disabled = true;
        statusEl.textContent = "提交中…";
        barEl.style.display = "none";
        resultRow.innerHTML = "";
        let resp;
        try {
            resp = await api.fetchApi("/neo_studio/director/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (e) {
            runBtn.disabled = false;
            statusEl.textContent = `提交失败：${e.message}`;
            return;
        }
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.success) {
            runBtn.disabled = false;
            statusEl.textContent = `提交失败：${data?.error || resp.status}`;
            return;
        }
        genState = {
            task_id: data.task_id, statusEl, barEl, fillEl: barEl.firstElementChild,
            runBtn, cancelBtn, resultRow, pollTimer: null,
        };
        api.addEventListener("rs.director.status", onStatusEvent);
        updateGenStatus(data);
        // WS 事件为主，轮询兜底（页面晚于任务打开 / 断线重连窗口）
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_studio/director/${data.task_id}`);
                const t = await r.json();
                if (t?.success) updateGenStatus(t);
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        genState.pollTimer = setInterval(poll, 2000);
    });

    cancelBtn.addEventListener("click", async () => {
        if (!genState) return;
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_studio/director/${genState.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) statusEl.textContent = `取消失败：${data?.error || r.status}`;
        } catch (e) {
            statusEl.textContent = `取消失败：${e.message}`;
        }
        cancelBtn.disabled = false;
    });

    page.appendChild($el("div", { className: "ns-gen-panel" }, [
        $el("div", { className: "ns-gen-row" }, [
            $el("label", { textContent: "配方" }), recipeSel,
            $el("label", { textContent: "种子" }), seedInput,
            $el("label", { textContent: "宽×高" }), widthInput, heightInput,
        ]),
        $el("div", { className: "ns-gen-row" }, [
            $el("label", { textContent: "连续性" }), continuityChk,
            $el("label", { textContent: "上下文帧" }), ctxInput,
            $el("label", { textContent: "步数" }), stepsInput,
            cancelBtn, runBtn,
        ]),
        barEl, statusEl, resultRow,
    ]));

    // --- 配方面板（卡片自带「编辑」→ openDirectorEditor 浮层） ---
    recipesPanelEl = await createRecipesPanel();
    page.appendChild(recipesPanelEl);
    fillRecipeOptions();
}




// ====== 设置页 ======
function buildSettings(el) {
    const llmBtn = $el("button", { className: "rs-btn", type: "button", textContent: "LLM 设置…" });
    llmBtn.addEventListener("click", () => openLLMSettingsModal());
    // 两个表单工厂返回 { el, load, save, isDirty }，挂 .el、后台 load（💾 保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    el.appendChild($el("div", { className: "ns-settings" }, [
        $el("div", { className: "ns-settings-section" }, [
            $el("h3", { textContent: "生图设置" }), genForm.el,
        ]),
        $el("div", { className: "ns-settings-section" }, [
            $el("h3", { textContent: "生视频设置" }), videoForm.el,
        ]),
        $el("div", { className: "ns-settings-section" }, [llmBtn]),
    ]));
    Promise.all([genForm.load(), videoForm.load()])
        .catch(e => console.error("[Neo Studio] settings load failed:", e));
}

// ====== 启动：版本信息 + 扩展初始化 + 路由 ======
async function loadVersion() {
    const verEl = document.getElementById("ns-version");
    try {
        const r = await api.fetchApi("/neo_studio/version");
        const data = await r.json();
        if (data?.success) {
            verEl.textContent = `Neo-Nodes ${data.plugin_version} · ComfyUI ${data.comfyui_version}`;
            directorRecipes = data.recipes || [];
            const sel = document.querySelector(".ns-gen-panel select");
            if (sel && !sel.options.length) {
                for (const name of directorRecipes) sel.appendChild($el("option", { value: name, textContent: name }));
            }
        }
    } catch { /* ComfyUI 未就绪时保持空白 */ }
}

function route() {
    const name = (location.hash || "#/gallery").replace(/^#\//, "").split("?")[0] || "gallery";
    if (name === "director") ensureView("director", buildDirector);
    else if (name === "settings") ensureView("settings", buildSettings);
    else ensureView("gallery", buildGallery);
    showView(name);
}

window.addEventListener("hashchange", route);
initExtensions().then(() => {
    loadVersion();
    route();
});
