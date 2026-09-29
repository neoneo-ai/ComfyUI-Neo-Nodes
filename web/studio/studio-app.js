// Neo Studio 外壳：hash 路由（#/gallery #/director #/settings）+ 各视图挂载。
// 功能全部复用 web/ 现有模块（import-map 把 scripts/* 指到 shim）：
// - 素材：NeoGallery（gallery.js 注册的扩展，侧栏 tab 的 render 直接挂进主区）
// - 导演：配方面板（recipes.js）+ 整片生成面板（POST /neo_studio/director/generate）
// - 设置：生图/生视频/LLM 设置表单（内嵌，无弹窗）
import { app, initExtensions, getSidebarTab } from "./shim/app.js";
import { api } from "./shim/api.js";
import { $el } from "./shim/ui.js";

import "../gallery.js";   // 注册 comfy.neo.gallery 扩展（NeoGallery + 侧栏 tab 定义）
import { openDirectorEditor, DIRECTOR_RECIPE_SAVED_EVENT } from "../director.js";
import { DirectorTimeline } from "../director-timeline.js";
import { createFramePlayer } from "../live-preview.js";
import { createRecipesPanel, listRecipes } from "../recipes.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "../image-gen.js";
import { createModelConfigForm } from "../llm-setting.js";

const view = document.getElementById("ns-view");
let directorRecipes = [];   // /neo_studio/version 返回的导演配方名
let onRecipesLoaded = null; // 导演页注册的回调：配方列表就绪后刷新下拉并填默认值（version 与视图构建有先后竞态）
const NS_LIVE_H = 360;       // 实时预览面板在 Studio 里的固定高度（px；与成片同高，节点上下文按画面比例加高，这里不需要）

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
    // 终态：定格预览 / 时间轴清掉段状态（停轮询在 WS / 轮询两条事件路径里做，闭包可见 stopPolling）
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
        genState.livePlayer?.pause();
        genState.onTerminal?.();
    }
    barEl.style.display = task.status === "running" ? "block" : "none";
    if (task.status === "queued") {
        statusEl.textContent = `排队中…（${task.recipe}）`;
    } else if (task.status === "running") {
        const p = task.progress;
        statusEl.textContent = p ? `生成中… ${p.value}/${p.max}` : "生成中…";
        if (p) fillEl.style.width = `${Math.round(100 * p.value / p.max)}%`;
    } else if (task.status === "succeeded" && !genState.done) {
        genState.done = true;   // 终态可能经 WS + 在途轮询重复到达：成片只替换一次
        statusEl.textContent = `已完成：${task.filename}`;
        const url = `/view?filename=${encodeURIComponent(task.filename)}`
            + `&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        // 成片就地替换实时预览（定格帧一并清掉）；也可在浏览器单独打开
        genState.mediaRight.replaceChildren(
            $el("video", { className: "ns-gen-preview ns-gen-final", controls: true, src: url }),
            $el("a", { className: "ns-gen-final", href: url, textContent: `🎬 ${task.filename}（在浏览器中打开）` })
        );
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
    recipesPanelEl = await createRecipesPanel({ directorOnly: true });   // 导演页只列多段导演配方
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

    // --- 只读时间轴：画出所选配方的分段（与画布节点内嵌同款组件）；运行中各段状态由 director_progress 轮询驱动 ---
    const tlBox = $el("div", { className: "ns-gen-timeline" });
    let tlSegments = [];
    let tlProgress = { active: false, segment_index: -1, total_segments: 0 };
    let timeline = null;
    try {
        timeline = new DirectorTimeline(tlBox, {
            height: 122,   // 默认 92 加高约 1/3，段块内容更宽裕
            readOnly: true,
            getSegments: () => tlSegments.map(s => ({
                // 内容派生身份：与节点内嵌时间轴同配色规则
                id: `${s.prompt || ''}|${Number(s.duration_sec) || 0}|${s.ref_input || ''}`,
                duration: Number(s.duration_sec) || 0,
                prompt: s.prompt || "",
                thumbUrl: s.ref_input ? `/view?filename=${encodeURIComponent(s.ref_input)}&subfolder=&type=input` : null,
            })),
            getProgress: () => tlProgress,
            // 点击分段块 → 打开配方编辑器并跳到该段（与画布节点内嵌时间轴同款交互）
            onSelect: (i) => openRecipeEditor(i),
        });
    } catch (e) {
        console.error("[Neo Studio] timeline init failed:", e);
    }

    // --- 实时预览：与节点内同款帧播放器；载荷按 task_id（后端 unique_id）过滤，Studio 里固定高度 ---
    const mediaRight = $el("div", { className: "ns-gen-media-right" });
    const liveBox = $el("div", { className: "ns-gen-live neo-dtl-live" });
    const livePlayer = createFramePlayer(liveBox, () => { liveBox.style.height = NS_LIVE_H + "px"; });
    mediaRight.appendChild(liveBox);

    function fillRecipeOptions() {
        recipeSel.innerHTML = "";
        for (const name of directorRecipes) {
            recipeSel.appendChild($el("option", { value: name, textContent: name }));
        }
        if (!directorRecipes.length) {
            recipeSel.appendChild($el("option", { value: "", textContent: "（暂无导演配方）" }));
        }
    }

    // 配方默认值：选中配方后从 director_spec 填 宽/高/步数（与画布节点 widget 填充同源；
    // 每个配方有自己的硬性要求，切换时一律重新初始化，不保留手改值）
    const specCache = new Map();
    async function applyRecipeDefaults(name) {
        name = String(name || "").trim();
        if (!name) return;
        let spec = specCache.get(name);
        if (!spec) {
            try {
                const r = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                const data = r.ok ? await r.json() : null;
                if (data?.success) spec = data;
            } catch { /* ComfyUI 未就绪时保持 -1 */ }
            if (spec) specCache.set(name, spec);
        }
        tlSegments = spec?.segments || [];
        timeline?.refresh();   // 只读时间轴同步到所选配方的分段
        const d = spec?.defaults;
        if (!d) return;
        for (const [input, val] of [[widthInput, d.width], [heightInput, d.height], [stepsInput, d.steps]]) {
            if (Number.isFinite(val)) input.value = val;
        }
    }
    recipeSel.addEventListener("change", () => applyRecipeDefaults(recipeSel.value));

    // 点时间轴分段块 → 打开导演编辑器并定位到该段（与画布节点 ✎ / 块点击同源）；
    // 保存后由 DIRECTOR_RECIPE_SAVED_EVENT 统一刷新下拉、默认值与时间轴分段
    async function openRecipeEditor(segIndex = -1) {
        const name = String(recipeSel.value || "").trim();
        if (!name) { statusEl.textContent = "请先选择配方"; return; }
        try {
            const metas = await listRecipes();
            const meta = (Array.isArray(metas) ? metas : []).find(r => r.name === name && r.type === "video_director");
            if (!meta) { statusEl.textContent = `未找到分段配方：${name}`; return; }
            await openDirectorEditor(meta, null, segIndex);
        } catch (e) {
            console.error("[Neo Studio] open director editor failed:", e);
            statusEl.textContent = `打开配方编辑器失败：${e.message || e}`;
        }
    }

    function stopPolling() {
        if (genState && genState.pollTimer) clearInterval(genState.pollTimer);
        api.removeEventListener("rs.director.status", onStatusEvent);
        if (genState?.previewListener) {
            api.removeEventListener("rs.h3.preview", genState.previewListener);
            genState.previewListener = null;
        }
    }

    function onStatusEvent({ detail }) {
        if (!detail || !detail.task_id) return;
        updateGenStatus(detail);
        // 终态即停轮询（WS 与下方轮询兜底两条路都覆盖，否则轮询拿到终态后会永远跑下去）
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
        mediaRight.querySelectorAll(".ns-gen-final").forEach(el => el.remove()); // 清掉上次的成片
        mediaRight.appendChild(liveBox);   // 恢复实时预览面板（成功后被成片替换掉了）
        livePlayer.reset();
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
            runBtn, cancelBtn, mediaRight, pollTimer: null, previewListener: null,
            done: false, lastPreviewStep: 0,   // done：成片只替换一次；lastPreviewStep：预览帧按步号单调推进（WS / 轮询同源）
            livePlayer,   // 终态时定格在最后一帧
            onTerminal: () => { tlProgress = { active: false, segment_index: -1, total_segments: 0 }; timeline?.refresh(); },
        };
        api.addEventListener("rs.director.status", onStatusEvent);
        // 预览帧只按步号向前推进：WS 为主、轮询 latest_preview 兜底，旧帧不得覆盖新帧
        const applyPreview = (p) => {
            if (!p || !Array.isArray(p.frames) || !p.frames.length) return;
            const st = Number(p.step);
            if (Number.isFinite(st) && st <= genState.lastPreviewStep) return;
            if (Number.isFinite(st)) genState.lastPreviewStep = st;
            livePlayer.apply(p);
        };
        // 实时预览载荷（后端广播，按 task_id 过滤到本次任务）
        const onPreviewEvent = ({ detail }) => {
            if (!detail || String(detail.node_id) !== data.task_id) return;
            applyPreview(detail);
        };
        api.addEventListener("rs.h3.preview", onPreviewEvent);
        genState.previewListener = onPreviewEvent;
        updateGenStatus(data);
        // WS 事件为主，轮询兜底（页面晚于任务打开 / 断线重连窗口）
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_studio/director/${data.task_id}`);
                const t = await r.json();
                if (t?.success) {
                    updateGenStatus(t);
                    if (["succeeded", "failed", "cancelled"].includes(t.status)) stopPolling();
                    applyPreview(t.latest_preview);   // 轮询兜底：WS 断档期间没有帧，取后端最新一帧
                }
                // 分段进度：与画布节点同源，驱动只读时间轴上各段状态
                const p = await api.fetchApi("/neo_video_gen/director_progress");
                const d = await p.json();
                if (d && typeof d.active === "boolean") { tlProgress = d; timeline?.refresh(); }
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

    // 整块面板两列：左 = 控制 + 时间轴，右 = 实时预览 / 成片（更大区域）
    const genLeft = $el("div", { className: "ns-gen-left" }, [
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
        tlBox,
    ]);
    page.appendChild($el("div", { className: "ns-gen-panel" }, [
        $el("div", { className: "ns-gen-body" }, [genLeft, mediaRight]),
        barEl, statusEl,
    ]));

    // --- 配方面板（卡片自带「编辑」→ openDirectorEditor 浮层；只列多段导演配方） ---
    recipesPanelEl = await createRecipesPanel({ directorOnly: true });
    page.appendChild(recipesPanelEl);
    onRecipesLoaded = () => { fillRecipeOptions(); applyRecipeDefaults(recipeSel.value); };
    onRecipesLoaded();
    // 编辑器保存后：刷新配方列表（新建的进下拉）、清 spec 缓存、同步默认值与时间轴分段
    window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, async () => {
        specCache.clear();
        try {
            const r = await api.fetchApi("/neo_studio/version");
            const data = await r.json();
            if (data?.success) directorRecipes = data.recipes || [];
        } catch { /* 网络抖动保持旧列表 */ }
        onRecipesLoaded();
    });
}




// ====== 设置页 ======
function buildSettings(el) {
    // 三个表单工厂均返回 { el, load, save, isDirty }，挂 .el、后台 load（💾 保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const llmForm = createModelConfigForm();
    el.appendChild($el("div", { className: "ns-settings" }, [
        $el("div", { className: "ns-settings-section" }, [
            $el("h3", { textContent: "生图设置" }), genForm.el,
        ]),
        $el("div", { className: "ns-settings-section" }, [
            $el("h3", { textContent: "生视频设置" }), videoForm.el,
        ]),
        $el("div", { className: "ns-settings-section" }, [
            $el("h3", { textContent: "LLM 设置" }), llmForm.el,
        ]),
    ]));
    Promise.all([genForm.load(), videoForm.load(), llmForm.load()])
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
            if (onRecipesLoaded) onRecipesLoaded();
        }
    } catch { /* ComfyUI 未就绪时保持空白 */ }
}

// ====== 显存/内存监控 ======
function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "--";
    const gb = n / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)}G` : `${Math.round(n / (1024 * 1024))}M`;
}

function setMemItem(el, used, total) {
    if (!Number.isFinite(total) || total <= 0) { el.textContent = "--"; return; }
    const pct = used / total;
    el.textContent = `${fmtBytes(used)} / ${fmtBytes(total)}`;
    el.classList.toggle("warn", pct >= 0.75 && pct < 0.9);
    el.classList.toggle("crit", pct >= 0.9);
}

async function pollMemStats() {
    try {
        const r = await api.fetchApi("/system_stats");
        const data = await r.json();
        const vramEl = document.getElementById("ns-vram");
        const ramEl = document.getElementById("ns-ram");
        if (data?.devices?.length) {
            const d = data.devices[0];
            setMemItem(vramEl, (d.vram_total || 0) - (d.vram_free || 0), d.vram_total);
        }
        if (data?.system) {
            setMemItem(ramEl, (data.system.ram_total || 0) - (data.system.ram_free || 0), data.system.ram_total);
        }
    } catch { /* 网络抖动忽略 */ }
}

function initMemMonitor() {
    pollMemStats();
    setInterval(pollMemStats, 3000);
    const btn = document.getElementById("ns-clear-mem");
    if (btn) {
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "清理中…";
            try {
                const r = await api.fetchApi("/neo_studio/clear_memory", { method: "POST" });
                const data = await r.json().catch(() => null);
                if (data?.success) {
                    btn.textContent = `释放 ${fmtBytes(data.freed_bytes)} ✓`;
                } else {
                    btn.textContent = "清理失败";
                }
            } catch {
                btn.textContent = "清理失败";
            }
            setTimeout(() => { btn.disabled = false; btn.textContent = "🧹 清理"; }, 2500);
            pollMemStats();   // 立即刷新一次
        });
    }
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
    initMemMonitor();
    route();
});
