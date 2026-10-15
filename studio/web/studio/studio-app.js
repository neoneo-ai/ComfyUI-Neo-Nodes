// Neo Studio 外桌面端：hash 路由（#/gallery #/director #/skills #/settings）+ 各视图挂载。
// 功能全部复用 web/ 现有模块（import-map 把 scripts/* 指到 shim）：
// - 素材：NeoGallery（gallery.js 注册的扩展，侧栏 tab 的 render 直接挂进主区）
// - 导演：配方面板（recipes.js）+ 整片生成面板（POST /neo_studio/director/generate）
// - 技能：统一技能管理（skill.js createSkillManager，与顶栏「🗂 技能管理」同组件，直接展开无弹窗）
// - 设置：生图/生视频/LLM 设置表单（内嵌，无弹窗）
import { app, initExtensions, getSidebarTab } from "./shim/app.js";
import { api } from "./shim/api.js";
import { $el } from "./shim/ui.js";

import "../gallery.js";   // 注册 comfy.neo.gallery 扩展（NeoGallery + 侧栏 tab 定义）
import { openDirectorEditor, DIRECTOR_RECIPE_SAVED_EVENT, DIRECTOR_ASPECTS, DIRECTOR_CUSTOM, MP_MIN, MP_MAX, MP_DEFAULT, directorClampMp, directorResolution, directorInferAspect } from "../director.js";
import { DirectorTimeline } from "../director-timeline.js";
import { createFramePlayer } from "../live-preview.js";
import { createRecipesPanel, listRecipes } from "../recipes.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "../image-gen.js";
import { createModelConfigForm } from "../llm-setting.js";
import { createSkillManager } from "../skill.js";
import { t, tf, getLang, applyLang, LANGS } from "../js/core/i18n.js";

const view = document.getElementById("ns-view");
let directorPanelOpts = null;   // 导演页配方面板选项（buildDirector 设置；含 onSelect 回传选中配方）
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
    setMemActive(name === "director");   // 显存读数只在导演页轮询
}

// ====== 素材页：直接借用 Neo Gallery 侧栏 tab 的 render（内部会挂载并加载 gallery.element） ======
function buildGallery(el) {
    const host = $el("div", { className: "ns-gallery-host" });
    el.appendChild(host);
    const tab = getSidebarTab("neo.gallery");
    if (!tab) {
        host.textContent = t("Neo Gallery 未加载");
        return;
    }
    tab.render(host).catch(e => {
        console.error("[Neo Studio] gallery render failed:", e);
        host.textContent = t("Neo Gallery 加载失败");
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
        statusEl.textContent = tf("排队中…（{recipe}）", { recipe: task.recipe });
    } else if (task.status === "running") {
        const p = task.progress;
        statusEl.textContent = p ? tf("生成中… {value}/{max}", { value: p.value, max: p.max }) : t("生成中…");
        if (p) fillEl.style.width = `${Math.round(100 * p.value / p.max)}%`;
    } else if (task.status === "succeeded" && !genState.done) {
        genState.done = true;   // 终态可能经 WS + 在途轮询重复到达：成片只替换一次
        statusEl.textContent = tf("已完成：{filename}", { filename: task.filename });
        const url = `/view?filename=${encodeURIComponent(task.filename)}`
            + `&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        // 成片就地替换实时预览（定格帧一并清掉）；也可在浏览器单独打开
        genState.mediaRight.replaceChildren(
            $el("video", { className: "ns-gen-preview ns-gen-final", controls: true, src: url }),
            $el("a", { className: "ns-gen-final", href: url, textContent: tf("🎬 {filename}（在浏览器中打开）", { filename: task.filename }) })
        );
        refreshRecipesPanel();
    } else if (task.status === "failed") {
        statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
    } else if (task.status === "cancelled") {
        statusEl.textContent = t("已取消");
    }
    genState.runBtn.disabled = task.status === "queued" || task.status === "running";
    genState.cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
}

let recipesPanelEl = null;
async function refreshRecipesPanel() {
    if (!recipesPanelEl || !directorPanelOpts) return;
    const parent = recipesPanelEl.parentNode;
    recipesPanelEl.remove();
    recipesPanelEl = await createRecipesPanel(directorPanelOpts());   // 导演页只列多段导演配方；点选回传 onSelect
    parent.appendChild(recipesPanelEl);
}


async function buildDirector(el) {
    const page = $el("div", { className: "ns-director" });
    el.appendChild(page);
    let currentRecipeName = null;   // 当前选中的导演配方（由下方配方面板点选回传，直接喂给整片生成区）

    const onSelect = (r) => {
        currentRecipeName = r.name;
        applyRecipeDefaults(r.name);   // 填 分辨率/步数 + 同步只读时间轴分段
    };
    const panelOpts = () => ({ directorOnly: true, autoSelectFirst: true, initialSelection: currentRecipeName, onSelect });
    directorPanelOpts = panelOpts;

    // --- 整片生成面板 ---
    // 分辨率与配方编辑器同源：宽高比 + 百万像素 → W/H（32 对齐）；「自定义」手输 W/H
    const seedInput = $el("input", { type: "number", placeholder: t("默认"), title: t("留空 = 用配方里的种子"), className: "ns-gen-seed" });
    const continuityChk = $el("input", { type: "checkbox" });
    continuityChk.checked = true;
    const ctxInput = $el("input", { type: "number", value: "22", className: "ns-gen-ctx" });
    const stepsInput = $el("input", { type: "number", placeholder: t("默认"), title: t("留空 = 用技能默认步数"), className: "ns-gen-steps" });
    const aspectSel = $el("select", { className: "ns-gen-aspect" });
    for (const [label] of DIRECTOR_ASPECTS) aspectSel.appendChild($el("option", { value: label, textContent: label }));
    aspectSel.appendChild($el("option", { value: DIRECTOR_CUSTOM, textContent: DIRECTOR_CUSTOM + t("（手输 W/H）") }));
    const mpInp = $el("input", { type: "number", min: MP_MIN, max: MP_MAX, step: 0.1, value: MP_DEFAULT, className: "ns-gen-mp" });
    const cwInp = $el("input", { type: "number", min: 16, placeholder: t("宽"), className: "ns-gen-cw" });
    const chInp = $el("input", { type: "number", min: 16, placeholder: t("高"), className: "ns-gen-ch" });
    const resOut = $el("span", { className: "ns-gen-res-out" });
    // 预设比例 + 百万像素 → W×H 回显；「自定义」改显手输 W/H（与配方编辑器同交互）
    const updateRes = () => {
        const custom = aspectSel.value === DIRECTOR_CUSTOM;
        cwInp.style.display = chInp.style.display = custom ? "" : "none";
        resOut.style.display = custom ? "none" : "";
        if (custom) return;
        const r = directorResolution(aspectSel.value, mpInp.value);
        resOut.textContent = r ? `${r.width}×${r.height}` : "";
    };
    aspectSel.addEventListener("change", updateRes);
    mpInp.addEventListener("input", updateRes);
    updateRes();
    const runBtn = $el("button", { className: "rs-btn ns-gen-run", type: "button", textContent: t("🎬 生成整片") });
    gateRunButton(runBtn, "director", t("🎬 生成整片"));

    const cancelBtn = $el("button", { className: "rs-btn ns-gen-cancel", type: "button", textContent: t("⏹ 取消"), style: { display: "none" } });
    const statusEl = $el("div", { className: "ns-gen-status" });
    const barEl = $el("div", { className: "ns-gen-progress" }, [$el("div")]);

    // --- 只读时间轴：画出所选配方的分段（与画布节点内嵌同款组件）；运行中各段状态由 director_progress 轮询驱动 ---
    const tlBox = $el("div", { className: "ns-gen-timeline" });
    let tlSegments = [];
    let tlProgress = { active: false, segment_index: -1, total_segments: 0 };
    let timeline = null;
    // 「仅运行勾选的段」：时间轴段块左上角勾选 → 整片生成只提交这些段（运行期临时状态，不写进配方；换配方即清空）
    let checkedSegments = [];
    const onlyHint = $el("div", { className: "ns-gen-hint" });
    const setChecked = (list) => {
        checkedSegments = list || [];
        onlyHint.textContent = checkedSegments.length
            ? tf("仅运行勾选的 {n} 段：[{list}]", { n: checkedSegments.length, list: checkedSegments.map((i) => i + 1).join(",") })
            : t("未勾选 = 生成整片");
        onlyHint.title = t("在时间轴段块左上角勾选，可只跑其中几段");
    };
    setChecked([]);
    try {
        timeline = new DirectorTimeline(tlBox, {
            height: 122,   // 默认 92 加高约 1/3，段块内容更宽裕
            readOnly: true,
            checkable: true,          // 段块左上角勾选框：只跑勾选的段
            onCheckChange: setChecked,
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
    const livePlayer = createFramePlayer(liveBox, () => {
        liveBox.style.height = NS_LIVE_H + "px";
        genBody.classList.remove("ns-gen-empty");   // 预览一有画面就占住右栏
    });
    mediaRight.appendChild(liveBox);

    // 配方默认值：选中配方后从 director_spec 填 分辨率/步数（与画布节点 widget 填充同源；
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
            } catch { /* ComfyUI 未就绪时保持默认 */ }
            if (spec) specCache.set(name, spec);
        }
        tlSegments = spec?.segments || [];
        // 分段已换（切配方/配方内容变更）→ 勾选作废（运行期临时状态，不跨配方保留）
        timeline?.clearChecked();
        setChecked(timeline ? timeline.getChecked() : []);
        timeline?.refresh();   // 只读时间轴同步到所选配方的分段
        const d = spec?.defaults;
        if (!d) return;
        if (Number.isFinite(d.steps)) stepsInput.value = d.steps;
        // 分辨率回填与编辑器同规则：预设比例 → 比例 + 百万像素；只存 W/H → 能精确复现原值则走预设，否则自定义手输（不漂移）；
        // shared 缺省 → 从默认 W/H 反推（命中预设走比例，否则自定义）
        const sh = spec.shared || {};
        let init;
        if (sh.aspect_ratio && DIRECTOR_ASPECTS.some(([l]) => l === sh.aspect_ratio)) {
            init = { label: sh.aspect_ratio, mp: directorClampMp(sh.megapixels != null ? sh.megapixels : MP_DEFAULT), cw: 0, ch: 0 };
        } else if (Number(sh.width) > 0 && Number(sh.height) > 0) {
            const inf = directorInferAspect(sh.width, sh.height);
            const r = directorResolution(inf.label, inf.mp);
            init = (r && r.width === Number(sh.width) && r.height === Number(sh.height))
                ? { label: inf.label, mp: inf.mp, cw: 0, ch: 0 }
                : { label: DIRECTOR_CUSTOM, mp: MP_DEFAULT, cw: sh.width, ch: sh.height };
        } else {
            const inf = directorInferAspect(Number(d.width) || 1344, Number(d.height) || 768);
            init = { label: inf.label, mp: inf.mp, cw: d.width, ch: d.height };
        }
        aspectSel.value = init.label;
        mpInp.value = init.mp;
        cwInp.value = init.cw || "";
        chInp.value = init.ch || "";
        updateRes();
    }

    // 点时间轴分段块 → 打开导演编辑器并定位到该段（与画布节点 ✎ / 块点击同源）；
    // 保存后由 DIRECTOR_RECIPE_SAVED_EVENT 统一刷新下拉、默认值与时间轴分段
    async function openRecipeEditor(segIndex = -1) {
        const name = String(currentRecipeName || "").trim();
        if (!name) { statusEl.textContent = t("请先选择配方"); return; }
        try {
            const metas = await listRecipes();
            const meta = (Array.isArray(metas) ? metas : []).find(r => r.name === name && r.type === "video_director");
            if (!meta) { statusEl.textContent = tf("未找到分段配方：{name}", { name }); return; }
            await openDirectorEditor(meta, null, segIndex);
        } catch (e) {
            console.error("[Neo Studio] open director editor failed:", e);
            statusEl.textContent = tf("打开配方编辑器失败：{msg}", { msg: e.message || e });
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
        const recipe = currentRecipeName;
        if (!recipe) { statusEl.textContent = t("请先在下方选择一个配方"); return; }
        // 空输入归一为 -1（用配方默认），避免 Number("") === 0 被后端当成显式 0
        const num = (input, fallback) => input.value.trim() === "" ? fallback : Number(input.value);
        // 分辨率：预设比例 + 百万像素 → W/H（32 对齐）；「自定义」取手输 W/H（空 = 用配方默认）
        let width = -1, height = -1;
        if (aspectSel.value === DIRECTOR_CUSTOM) {
            width = num(cwInp, -1);
            height = num(chInp, -1);
        } else {
            const r = directorResolution(aspectSel.value, mpInp.value);
            if (r) { width = r.width; height = r.height; }
        }
        const body = {
            recipe,
            seed: num(seedInput, -1),
            width,
            height,
            continuity: continuityChk.checked,
            context_frames: num(ctxInput, 22),
            steps: num(stepsInput, -1),
            only_segments: checkedSegments.map((i) => i + 1).join(","),   // 勾选的段（空 = 整片）
        };

        stopPolling();
        runBtn.disabled = true;
        statusEl.textContent = t("提交中…");
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
            statusEl.textContent = tf("提交失败：{msg}", { msg: e.message });
            return;
        }
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.success) {
            runBtn.disabled = false;
            statusEl.textContent = tf("提交失败：{msg}", { msg: data?.error || resp.status });
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
            if (!r.ok) statusEl.textContent = tf("取消失败：{msg}", { msg: data?.error || r.status });
        } catch (e) {
            statusEl.textContent = tf("取消失败：{msg}", { msg: e.message });
        }
        cancelBtn.disabled = false;
    });

    // 整块面板两列：左 = 配方区（控制行 + 时间轴），右 = 结果区（实时预览 / 成片）
    // 控制行属于左列（参数与时间轴同源，都取自当前配方），行尾 ⋯ 按钮展开高级选项 → 视觉只有一行
    // （.rs-gen-advanced 点 ⋯ 按钮切换 .rs-adv-open；展开后种子/连续性/上下文帧占满第二行）
    const advToggle = $el("button", { className: "rs-gen-adv-toggle", textContent: t("⋯ 高级"), title: t("种子 / 连续性 / 上下文帧（高级）") });
    // 生成/取消按钮贴控制行右端：与下方时间轴右端对齐（同一列，等宽）
    const runGroup = $el("div", { className: "ns-gen-run-group" }, [cancelBtn, runBtn]);
    // 控制行按「字段」排布：标签在控件上方，一行放不下就整字段换行（标签不落到上一行末尾）
    const field = (label, ...kids) => $el("div", { className: "ns-gen-field" }, [$el("label", { textContent: label }), ...kids]);
    const genRow = $el("div", { className: "ns-gen-row rs-gen-advanced" }, [
        field(t("宽高比"), aspectSel),
        field(t("百万像素"), mpInp),
        field(t("分辨率"), $el("div", { className: "ns-gen-field-row" }, [resOut, cwInp, chInp])),
        field(t("步数"), stepsInput),
        advToggle,
        runGroup,
        $el("div", { className: "rs-gen-adv-content" }, [
            $el("div", { className: "ns-gen-row" }, [
                field(t("种子"), seedInput),
                field(t("连续性"), continuityChk),
                field(t("上下文帧"), ctxInput),
            ]),
        ]),
    ]);
    advToggle.addEventListener("click", () => genRow.classList.toggle("rs-adv-open"));
    const emptyHint = $el("div", { className: "ns-gen-empty-hint", textContent: t("生成后在此显示实时预览") });
    const genLeft = $el("div", { className: "ns-gen-left" }, [genRow, tlBox, onlyHint, emptyHint]);
    // 右栏没有画面时整块收起，时间轴与预览占位共用整幅宽度
    const genBody = $el("div", { className: "ns-gen-body ns-gen-empty" }, [genLeft, mediaRight]);
    // 面板底部一行：状态文字 + 显存/内存读数（只有导演生成吃显存，监控跟着生成面板走）
    const foot = $el("div", { className: "ns-gen-foot" }, [statusEl]);
    const memBar = buildMemBar();
    if (memBar) foot.appendChild(memBar);
    page.appendChild($el("div", { className: "ns-gen-panel" }, [
        genBody,
        barEl, foot,
    ]));

    // --- 配方面板（点卡片直接选中并喂给上方整片生成区；只列多段导演配方） ---
    recipesPanelEl = await createRecipesPanel(panelOpts());
    page.appendChild(recipesPanelEl);
    // 编辑器保存后：刷新配方列表、清 spec 缓存、同步默认值与时间轴分段（新建配方直接选中，其余保持当前选中）
    window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, async (e) => {
        specCache.clear();
        if (e?.detail?.created) currentRecipeName = e.detail.name;
        await refreshRecipesPanel();
    });
}




// ====== 技能页：统一技能管理（与顶栏「🗂 技能管理」同组件）直接挂满主区，无弹窗外桌面端 ======
function buildSkills(el) {
    el.classList.add("ns-skills");
    // Studio 无画布：不显示 ✕ 与「从画布」导出按钮
    createSkillManager(el, { showClose: false, showCanvasBtn: false });
}

// ====== 启动设置：便携 exe 的 ComfyUI 根目录 / 解释器 / 端口 ======
// 这份数据归桌面端：桌面端窗口里走 js_api，页面在桌面端端口还是 ComfyUI 端口都读得到（就绪后整页跳到 ComfyUI，
// 同源就没有 /neo_studio/launcher 了）；浏览器标签页没有桥，只剩桌面端服务那条路由，读不到就收起 tab。
function createLauncherPanel() {
    const input = (ph) => $el("input", { className: "ns-launch-input", placeholder: ph, spellcheck: "false" });
    const rootIn = input(t("ComfyUI 根目录"));
    const pyIn = input(t("python.exe 路径"));
    const portIn = input("8188");
    const remoteIn = input("http://192.168.0.20:8188");
    remoteIn.classList.add("ns-launch-remote");
    const listenSel = $el("select", { className: "ns-launch-input ns-launch-listen" });
    const status = $el("div", { className: "ns-launch-status" });
    const info = $el("div", { className: "ns-launch-info" });
    const lanHint = $el("div", { className: "ns-launch-info" });
    const browseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const pyBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const applyBtn = $el("button", { className: "ns-btn ns-launch-apply", textContent: t("保存并重启 ComfyUI") });
    const depsBtn = $el("button", { className: "ns-btn", textContent: t("安装依赖") });
    const fixBtn = $el("button", { className: "ns-btn", textContent: t("重试安装插件") });
    const framelessIn = $el("input", { type: "checkbox", className: "ns-launch-frameless" });
    const devIn = $el("input", { type: "checkbox", className: "ns-launch-dev" });
    const kernelState = $el("div", { className: "ns-kernel-state" });
    const startBtn = $el("button", { className: "ns-btn ns-kernel-start", textContent: t("▶ 启动内核") });
    const stopBtn = $el("button", { className: "ns-btn ns-kernel-stop", textContent: t("■ 停止内核") });
    // 标签旁的 ⓘ：悬停给出前提条件与生效方式 —— 面板里这几项的规矩各不相同（保存并重启 / 重启窗口 / 归远端管）
    const TIPS = {
        root: "ComfyUI 安装目录，要有 main.py。\n"
            + "改完点「保存并重启 ComfyUI」：桌面端停掉旧进程，按新配置重新拉起。",
        python: "跑 ComfyUI 的 python.exe，要已装好 ComfyUI 的依赖（缺依赖时下方出「安装依赖」按钮）。\n"
            + "改完点「保存并重启 ComfyUI」。",
        port: "本机 ComfyUI 的端口，窗口与探活都打在 127.0.0.1:该端口。\n"
            + "端口被占用时桌面端自动换到下一个空闲端口。改完点「保存并重启 ComfyUI」。",
        listen: "ComfyUI 的 --listen，默认「仅本机」= 只监听 127.0.0.1，局域网访问不到。\n"
            + "填网卡地址时会自动带上 127.0.0.1，否则窗口自己打不开。\n"
            + "ComfyUI 没有鉴权：防火墙放行该端口，只在你信任的网段开。改完点「保存并重启 ComfyUI」。",
        remote: "连远端那台 ComfyUI：http(s)://主机[:端口]，留空 = 连本机。\n"
            + "前提：远端已装 comfyui-neo-studio 插件，并在远端自己的「启动设置 → 局域网监听」放开监听。\n"
            + "远程模式本机不启动也不停止 ComfyUI：「启动内核」= 重连远端，「停止内核」禁用，"
            + "根目录 / 解释器 / 端口 / 局域网监听归远端管。\n"
            + "改完点「保存并重启 ComfyUI」，窗口直接开在远端页面。",
        frameless: "桌面端窗口自绘标题栏（最小化 / 最大化 / 全屏 / 关闭），勾掉回系统标题栏。\n"
            + "立刻生效并写进启动配置，下次开机沿用。",
        dev: "打开刷新键 / 右键菜单 / 开发者工具，排查窗口白屏与前端问题用。\n"
            + "pywebview 在建窗口时定值：勾完要重启桌面端窗口才生效。",
    };
    const infoDot = (tip) => $el("span", { className: "ns-info", textContent: "i", tabindex: "0", "data-tip": tip });
    const row = (label, tip, ...kids) => $el("div", { className: "ns-launch-row" },
        [$el("span", { className: "ns-launch-label" }, [label, infoDot(tip)]), ...kids]);
    const rootRow = row(t("ComfyUI 根目录"), t(TIPS.root), rootIn, browseBtn);
    const pyRow = row("Python", t(TIPS.python), pyIn, pyBrowseBtn);
    const portRow = row(t("端口"), t(TIPS.port), portIn);
    const listenRow = row(t("局域网监听"), t(TIPS.listen), listenSel);
    const remoteRow = row(t("远程 ComfyUI"), t(TIPS.remote), remoteIn);
    // 远程模式下这几项归远端那台机器管：灰掉，别让本机设置看起来能影响远端
    const localRows = [rootRow, pyRow, portRow, listenRow];
    const localInputs = [rootIn, pyIn, portIn, listenSel, browseBtn, pyBrowseBtn];

    const STATE_TEXT = {
        ok: "就绪",
        bad_root: "根目录无效",
        missing_python: "找不到 Python",
        deps_missing: "缺少插件依赖",
        install_failed: "插件安装失败",
    };

    // 局域网监听做成下拉：手输 IP 容易错，可选项就是「仅本机 / 全部网卡 / 本机各网卡」
    const LAN_CHOICES = [["", "仅本机（默认）"], ["0.0.0.0", "全部网卡（0.0.0.0）"]];
    let lanIps = [];

    // 桌面端存的是规范化值（127.0.0.1,192.168.0.165）：去掉补出来的回环才是下拉项
    const lanKey = (listen) => (listen || "").split(",")
        .map((x) => x.trim()).filter((x) => x && x !== "127.0.0.1").join(",");

    function renderLanHint() {
        const remote = remoteIn.value.trim();
        if (remote) {
            lanHint.textContent = tf("远程 ComfyUI：{remote}/neo-studio · 远端要已开监听并装好 Neo Studio 插件，起停与端口都在远端那台机器上设", { remote });
            return;
        }
        const v = listenSel.value;
        const port = portIn.value || "8188";
        if (!v) {
            lanHint.textContent = tf("仅本机访问：http://127.0.0.1:{port}/neo-studio", { port });
            return;
        }
        const urls = v === "0.0.0.0"
            ? lanIps.map((ip) => `http://${ip}:${port}/neo-studio`)
            : [`http://${v}:${port}/neo-studio`];
        lanHint.textContent = t("局域网可访问（ComfyUI 没有鉴权，只在你信任的网段开）：")
            + (urls.join("  ·  ") || tf("http://<本机 IP>:{port}/neo-studio", { port }));
    }

    // 远程模式灰掉本机启动项：远端的根目录 / 解释器 / 端口 / 监听由远端自己配
    function renderLocalMode(remote) {
        for (const el of localInputs) el.disabled = remote;
        for (const r of localRows) r.classList.toggle("ns-launch-remote-off", remote);
    }

    function render(s) {
        rootIn.value = s.root || "";
        pyIn.value = s.python || "";
        portIn.value = s.port || "";
        remoteIn.value = s.remote || "";
        renderLocalMode(!!s.remote);
        lanIps = s.lan_ips || [];
        const opts = LAN_CHOICES.concat(lanIps.map((ip) => [ip, tf("本机网卡 {ip}", { ip })]));
        const key = lanKey(s.listen);
        if (!opts.some(([v]) => v === key)) opts.push([key, tf("已保存：{key}", { key })]);
        listenSel.replaceChildren(...opts.map(([v, label]) => $el("option", { value: v, textContent: t(label) })));
        listenSel.value = key;
        renderLanHint();
        status.textContent = t(STATE_TEXT[s.state] || s.state || "") + (s.error ? ` · ${s.error}` : "");
        status.classList.toggle("ns-launch-bad", !!s.state && s.state !== "ok");
        info.textContent = tf("插件 {plugin} · 状态 {state} · {mode}", {
            plugin: s.plugin_dir, state: s.state_dir, mode: t(s.portable ? "便携模式" : "插件内运行"),
        });
        depsBtn.style.display = s.state === "deps_missing" ? "" : "none";
        fixBtn.style.display = s.state === "install_failed" ? "" : "none";
        framelessIn.checked = !!s.frameless;
        devIn.checked = !!s.dev_mode;
    }

    // 动作 → 桌面端 js_api 上的方法名：桥在就直接问桌面端，不在才走桌面端服务的 HTTP 路由
    const BRIDGE_FN = { apply: "apply_launcher", install_plugin: "install_plugin", install_deps: "install_deps", set_frameless: "set_frameless", set_dev_mode: "set_dev_mode" };
    const bridge = () => (window.pywebview?.api?.launcher_state ? window.pywebview.api : null);

    async function refresh() {
        const desktop = bridge();
        if (desktop) {
            render(await desktop.launcher_state());
            return;
        }
        const resp = await api.fetchApi("/neo_studio/launcher");
        if (!resp.ok) throw new Error(`读取启动设置失败：${resp.status}`);
        render(await resp.json());
    }

    async function post(payload) {
        applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = true;
        try {
            const action = payload.action || "apply";
            const fn = bridge()?.[BRIDGE_FN[action]];
            let data;
            if (fn) {
                data = action === "apply"
                    ? await fn(payload.root, payload.python, payload.port, payload.listen, payload.remote)
                    : action === "set_frameless"
                        ? await fn(payload.frameless)
                        : action === "set_dev_mode"
                            ? await fn(payload.dev_mode)
                            : await fn();
            } else {
                const resp = await api.fetchApi("/neo_studio/launcher", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                data = await resp.json();
            }
            const failed = data.ok === false;   // 重试安装插件回的是内核状态，没有 ok 字段也算成功
            toast(failed ? (data.error || t("操作失败")) : (data.msg || t("已保存，ComfyUI 重启中…")));
            if (!failed) await refresh();
        } catch (e) {
            toast(tf("启动设置保存失败：{msg}", { msg: e.message }));
        } finally {
            applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = false;
        }
    }

    browseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_root?.();
        if (picked) rootIn.value = picked;
    });
    pyBrowseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_python?.();
        if (picked) pyIn.value = picked;
    });
    applyBtn.addEventListener("click", () => post({
        root: rootIn.value, python: pyIn.value, port: portIn.value,
        listen: listenSel.value, remote: remoteIn.value.trim(),
    }));
    depsBtn.addEventListener("click", () => post({ action: "install_deps" }));
    fixBtn.addEventListener("click", () => post({ action: "install_plugin" }));
    framelessIn.addEventListener("change", () => post({ action: "set_frameless", frameless: framelessIn.checked }));
    devIn.addEventListener("change", () => post({ action: "set_dev_mode", dev_mode: devIn.checked }));
    // 提示行跟着选中项与端口实时变，点「保存并重启 ComfyUI」才落盘
    listenSel.addEventListener("change", renderLanHint);
    portIn.addEventListener("input", renderLanHint);
    remoteIn.addEventListener("input", renderLanHint);

    // 内核启停在面板顶部：状态一行 + 启动 / 停止两枚按钮，此刻做不了的那枚禁用
    // 内核状态行：远程模式没有本机端口 / 谁启动 / PID 可报，只报远端地址；停止内核管不到远端进程，禁用
    function renderKernel(s) {
        const booting = (userStarting || s.starting) && !s.ready;
        const running = s.running && !booting;
        kernelState.textContent = `ComfyUI ${booting ? t("启动中…") : (s.running ? t("运行中") : t("已停止"))}`
            + (s.remote ? tf(" · 远程 {remote}", { remote: s.remote })
                : tf(" · 端口 {port} · {by}", { port: s.port, by: t(s.mine ? "桌面端启动" : "外部启动") }))
            + (s.pid ? ` · PID ${s.pid}` : "");
        kernelState.classList.toggle("ns-kernel-run", running);
        startBtn.textContent = booting ? t("🚀 启动中…") : (s.remote ? t("🚀 重连远端") : t("▶ 启动内核"));
        startBtn.disabled = booting || s.running;
        stopBtn.disabled = booting || !s.running || !!s.remote;
    }
    onComfyState(renderKernel);
    startBtn.addEventListener("click", () => { startBtn.disabled = true; startKernel(); });
    stopBtn.addEventListener("click", () => { stopBtn.disabled = true; stopKernel(); });

    const el = $el("div", { className: "ns-settings-section" }, [
        $el("h3", { textContent: t("启动设置") }),
        $el("div", { className: "ns-kernel" }, [
            kernelState,
            $el("div", { className: "ns-kernel-actions" }, [startBtn, stopBtn]),
        ]),
        status,
        rootRow,
        pyRow,
        portRow,
        listenRow,
        remoteRow,
        row(t("无边框窗口"), t(TIPS.frameless), framelessIn),
        row(t("开发模式"), t(TIPS.dev), devIn),
        $el("div", { className: "ns-launch-actions" }, [applyBtn, depsBtn, fixBtn]),
        lanHint,
        info,
    ]);
    return { el, refresh };
}

// ====== 界面语言：桌面端设置页的一栏，单选即选即落盘并整页刷新 ======
// 语言只影响桌面端自有文案（顶栏、导演面板、启动设置、状态位）；素材 / 技能 / 各设置表单沿用共享模块原文。
function createLangPanel() {
    const current = getLang();
    const rows = LANGS.map((l) => {
        const input = $el("input", { type: "radio", name: "ns-lang", value: l.value });
        input.checked = l.value === current;
        input.addEventListener("change", () => applyLang(l.value));
        return $el("label", { className: "ns-lang-row" }, [input, $el("span", { textContent: l.label })]);
    });
    return $el("div", { className: "ns-lang" },
        [...rows, $el("div", { className: "ns-lang-hint", textContent: t("选择后立即落盘并整页刷新，界面文案按新语言重建。") })]);
}

// ====== 设置页：左侧 tab 切换（LLM / 生图 / 生视频 / 界面语言 / 日志 / 启动设置 / 关于），默认 LLM ======
function buildSettings(el) {
    // 三个表单工厂均返回 { el, load, save, isDirty }，挂 .el、后台 load（💾 保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const llmForm = createModelConfigForm();

    // 日志面板：ComfyUI 控制台环形缓冲（app.logger 300 条），tab 激活时轮询
    const logBody = $el("pre", { className: "ns-log" });
    let logTimer = null;
    let logStick = true;   // 贴底才自动滚；用户往上翻看时停住，翻回底部恢复

    const logAtBottom = () =>
        logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight <= 40;
    logBody.addEventListener("scroll", () => { logStick = logAtBottom(); });

    async function refreshLog() {
        try {
            const data = await (await api.fetchApi("/neo_studio/log")).json();
            // 条目是原始 stdout，自带换行与 ANSI 色码；色码在网页里是乱码，剥掉
            logBody.textContent = (data.entries || []).map(e => String(e.m).replace(/\x1b\[[0-9;]*m/g, "")).join("");
            if (logStick) logBody.scrollTop = logBody.scrollHeight;
        } catch { /* ComfyUI 未就绪时保留上次内容 */ }
    }

    // tab 顺序：LLM 设置 → 生图设置 → 生视频设置 → 界面语言 → 日志 → 启动设置 → 关于；每个 tab 只显示对应设置区
    const launcher = createLauncherPanel();
    const section = (title) => $el("h3", { textContent: t(title) });
    const sections = [
        { key: "llm", label: t("LLM 设置"), body: $el("div", { className: "ns-settings-section" }, [section("LLM 设置"), llmForm.el]) },
        { key: "gen", label: t("生图设置"), body: $el("div", { className: "ns-settings-section" }, [section("生图设置"), genForm.el]) },
        { key: "video", label: t("生视频设置"), body: $el("div", { className: "ns-settings-section" }, [section("生视频设置"), videoForm.el]) },
        { key: "lang", label: t("界面语言"), body: $el("div", { className: "ns-settings-section" }, [section("界面语言"), createLangPanel()]) },
        { key: "log", label: t("日志"), body: $el("div", { className: "ns-settings-section ns-log-section" }, [section("日志"), logBody]) },
        { key: "launch", label: t("启动设置"), body: launcher.el },
        { key: "about", label: t("关于"), body: $el("div", { className: "ns-settings-section" }, [section("关于"), $el("div", { className: "ns-about-version", id: "ns-about-version", textContent: versionText() })]) },
    ];

    const tabs = $el("div", { className: "ns-settings-tabs" });
    const content = $el("div", { className: "ns-settings-content" });
    const showSection = (key) => {
        for (const s of sections) s.body.style.display = s.key === key ? "" : "none";
        for (const btn of tabs.children) btn.classList.toggle("active", btn.dataset.key === key);
        if (key === "log") {
            logStick = true;   // 重新进 tab 回到最新，之后按用户滚动位置决定
            refreshLog();
            logTimer = setInterval(refreshLog, 2000);
        } else if (logTimer) {
            clearInterval(logTimer);
            logTimer = null;
        }
    };
    for (const s of sections) {
        const btn = $el("button", { className: "ns-settings-tab", textContent: s.label });
        btn.dataset.key = s.key;
        btn.addEventListener("click", () => showSection(s.key));
        tabs.appendChild(btn);
        content.appendChild(s.body);
    }

    el.appendChild($el("div", { className: "ns-settings" }, [tabs, content]));
    showSection("llm");  // 默认 LLM 设置
    Promise.all([genForm.load(), videoForm.load(), llmForm.load()])
        .catch(e => console.error("[Neo Studio] settings load failed:", e));
    // 桥由 pywebview 在导航完成后才注入、方法还要晚一步填：桥在长就等它长完，别把桌面端窗口判成浏览器
    (async () => {
        for (let tries = 0; tries < 10; tries++) {
            try {
                await launcher.refresh();
                return;
            } catch {
                if (!window.pywebview) break;
                await new Promise(r => setTimeout(r, 300));
            }
        }
        launcher.el.remove();
        tabs.querySelector('[data-key="launch"]')?.remove();
    })();
}

// ====== 启动：版本信息 + 扩展初始化 + 路由 ======
let offline = false;   // 页面跑在桌面端的服务上：文件类功能可用，生成类请求由桌面端回 409
let starting = false;  // 桌面端已拉起 ComfyUI 还没就绪：这段时间只出「启动中」，其余离线提示一律收起
let caps = {};         // 桌面端能力表（/neo_studio/version 下发）；ComfyUI 页里缺省即全可用
let versionInfo = { plugin: "", comfy: "", offline: false };   // 版本号只在设置「关于」里显示

function can(feature) { return caps[feature] !== false; }

// ComfyUI 内核状态：顶栏只显状态，启停在「设置 → 启动设置」顶部。
// 一份 comfy_state 轮询下发给所有看它的人（顶栏状态位 + 启动设置的启停按钮）。
let comfyState = null;      // 最近一次快照；浏览器标签页里没有桌面端的桥，永远是 null
let userStarting = false;   // 已点下启动内核，等端口就绪
let pageReloaded = false;   // 就绪后的整页刷新只发一次
const comfyViewers = new Set();

function publishComfyState(s) {
    comfyState = s;
    for (const fn of comfyViewers) fn(s);
}

function onComfyState(fn) {
    comfyViewers.add(fn);
    if (comfyState) fn(comfyState);
}

function toast(text) {
    let el = document.getElementById("ns-toast");
    if (!el) {
        el = $el("div", { id: "ns-toast", className: "ns-toast" });
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove("show"), 4200);
}

// 前端错误上报桌面端日志（data/studio_desktop.log）：白屏这类问题只有 DevTools 能看太晚。
// pywebview 桥脚本注入晚于页面加载，报错正撞在这个空档 —— 没就绪就重试几轮，别把消息丢了；
// 浏览器标签页里永远没有桌面端 api，重试完静默放弃。
function desktopLog(text) {
    let tries = 0;
    const send = () => {
        const api = window.pywebview?.api;
        if (api?.log) {
            api.log(text);
            return;
        }
        if (tries++ < 10) setTimeout(send, 300);
    };
    send();
}

// 内核启停：「启动设置」顶部的两枚按钮与生成入口共用；状态由 comfy_state 轮询下发
function startKernel() {
    const desktop = window.pywebview?.api;
    if (!desktop?.comfy_start) {
        toast(t("请在 Neo Studio 窗口里启动 ComfyUI"));
        return;
    }
    if (starting || userStarting) return;   // 启动中：不重复拉起
    userStarting = true;
    desktop.comfy_start().then(publishComfyState).catch(() => { userStarting = false; });
}

function stopKernel() {
    const desktop = window.pywebview?.api;
    if (!desktop?.comfy_stop) return;
    desktop.comfy_stop().then(publishComfyState).catch(() => {});
}

function startComfy() {
    if (starting) return;   // 启动中：不重复拉起，也不出提示
    const inDesktop = !!window.pywebview?.api?.comfy_start;
    startKernel();
    if (inDesktop) toast(comfyState?.remote ? t("重连远端 ComfyUI…") : t("ComfyUI 启动中…就绪后自动回到完整 Studio"));
}

// 生成类请求打到桌面端上必 409：统一提示并指向「设置 → 启动设置」，不给前端假成功
window.addEventListener("neo-offline-request", () => {
    if (starting) return;   // 启动中不提示：就绪后桌面端整页跳回完整 Studio
    toast(t("该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」"));
    document.getElementById("ns-comfy-status")?.classList.add("ns-comfy-hint");
});

// 运行类按钮 → 所需 ComfyUI 运行时能力：能力缺失时点它交给桌面端拉起 ComfyUI，不发假请求。
// 编辑类不在表里（保存 / 生成分段 / 重写提示词 / 逐格描述 / 宫格拆分 / 技能编辑 / 设置 / LLM 配置）：
// 那些接口只读写文件与 8080 服务，桌面端自己就能服务。
const RUN_GATES = [
    [".neo-gallery-gm-btn", "image_gen", t("生成素材")],
    [".ns-gen-run", "director", t("🎬 生成整片")],
    [".neo-director-regen-run", "segment", t("生成这一段")],
    [".neo-director-merge-run", "segment", t("拼回成片")],
    [".neo-director-sb-gen", "storyboard", t("生成图片分镜")],
];

// 生成按钮改写成「需要 ComfyUI」：不发请求，点一下引导启动（须在原 handler 之前注册）
function gateRunButton(btn, feature, label) {
    if (can(feature)) return;
    btn.textContent = runLabel();
    btn.title = tf("{label} 需要 ComfyUI 执行队列 · 点一下启动", { label });
    btn.classList.add("ns-gen-off");
    btn.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        startComfy();
    });
}

function runLabel() { return starting ? t("ComfyUI 启动中") : t("需要 ComfyUI"); }

// 共享模块（gallery / director / voice）大量直接用原生 fetch 打接口，不经 api shim：
// 离线时同样广播 409 offline，让各生成路径统一出「需要 ComfyUI」提示，不静默吞掉。
// 共享模块注册的运行按钮（生成素材 / 生成这一段 / 拼回成片 / 生成图片分镜）在捕获阶段拦掉。
function initOfflineGate() {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => nativeFetch(input, init).then((res) => {
        if (res.status !== 409) return res;
        res.clone().json()
            .then((data) => {
                if (data && data.offline) {
                    window.dispatchEvent(new CustomEvent("neo-offline-request", { detail: { path: String(input) } }));
                }
            })
            .catch(() => {});
        return res;
    });

    document.addEventListener("click", (e) => {
        for (const [selector, feature] of RUN_GATES) {
            if (can(feature)) continue;
            const btn = e.target?.closest?.(selector);
            if (!btn) continue;
            e.preventDefault();
            e.stopPropagation();
            startComfy();
            return;
        }
    }, true);
}

// 离线横幅只在 ComfyUI 未运行时出现；启动中交给顶栏胶囊的「● 启动中」，不叠横幅。
// 状态在 loadVersion 里就从桌面端的快照拿到了 —— js_api 注入晚于页面加载，冷启动不能等它，
// 否则横幅会先闪「ComfyUI 未运行」再改口。
function showOfflineBanner() {
    if (document.getElementById("ns-offline")) return;
    document.body.classList.add("ns-offline");
    const btn = $el("button", { className: "ns-offline-start", type: "button", textContent: t("🚀 启动 ComfyUI") });
    btn.addEventListener("click", startComfy);
    const bar = $el("div", { id: "ns-offline", className: "ns-offline-bar" }, [
        $el("span", { className: "ns-offline-msg" }),
        btn,
    ]);
    document.querySelector(".ns-header").after(bar);
    renderDesktopState();
    // 远程与否由 comfy_state 报：状态一到手横幅就要改口，别停在「ComfyUI 未运行」上
    onComfyState(() => { if (document.getElementById("ns-offline")) renderDesktopState(); });
}

function renderDesktopState() {
    const bar = document.getElementById("ns-offline");
    if (!bar) return;
    const remote = comfyState?.remote;
    // 启动中只留顶栏胶囊的「● 启动中」，不再叠一条同义横幅
    bar.style.display = starting ? "none" : "";
    bar.querySelector(".ns-offline-msg").textContent = remote
        ? tf("远程 ComfyUI 不可达 · {remote} —— 这里浏览的是本机素材目录，生成与队列要连上远端", { remote })
        : t("ComfyUI 未运行 · 素材 / 技能 / 配方 / 设置 / 模型库可离线编辑，生成与队列需要 ComfyUI");
    bar.querySelector(".ns-offline-start").textContent = remote ? t("🚀 重连远端") : t("🚀 启动 ComfyUI");
    bar.querySelector(".ns-offline-start").style.display = "";
    for (const b of document.querySelectorAll(".ns-gen-off")) b.textContent = runLabel();
}

function versionText() {
    if (!versionInfo.plugin) return "";
    if (versionInfo.offline) return `Neo Studio ${versionInfo.plugin} · ${starting ? t("ComfyUI 启动中") : t("离线模式")}`;
    return `Neo Studio ${versionInfo.plugin} · ComfyUI ${versionInfo.comfy}`;
}

function renderVersionInfo() {
    const el = document.getElementById("ns-about-version");
    if (el) el.textContent = versionText();
}

function setStarting(on) {
    if (starting === on) return;
    starting = on;
    if (offline) renderVersionInfo();
    renderDesktopState();
}

async function loadVersion() {
    try {
        const r = await api.fetchApi("/neo_studio/version");
        const data = await r.json();
        if (data?.success) {
            offline = !!data.offline;
            starting = !!data.starting;   // 桌面端已拉起 ComfyUI：页面第一份状态就是「启动中」
            caps = data.caps || {};
            versionInfo = { plugin: data.plugin_version || "", comfy: data.comfyui_version || "", offline };
            renderVersionInfo();
            if (offline) showOfflineBanner();
        }
    } catch { /* ComfyUI 未就绪时保持空白 */ }
}

// ====== 无边框窗口：系统标题栏被桌面端摘掉后，最小化 / 最大化 / 全屏 / 关闭由顶栏自己画 ======
// 只有桌面端窗口有 pywebview 桥；浏览器标签页里桥不存在，控件整块不出现，顶栏照旧。
function initWindowChrome() {
    const btn = (id) => document.getElementById(id);
    const set = (id, ico, title) => {
        const b = btn(id);
        if (b) { b.textContent = ico; b.title = title; }
    };
    let state = { frameless: false, maximized: false, fullscreen: false };
    const render = (s) => {
        state = s;
        document.body.classList.toggle("ns-frameless", !!s.frameless);
        btn("ns-wctl").hidden = !s.frameless;
        set("ns-win-max", s.maximized ? "🗗" : "▢", s.maximized ? t("还原") : t("最大化"));
        set("ns-win-fs", s.fullscreen ? "🗗" : "⛶", s.fullscreen ? t("退出全屏") : t("全屏"));
    };
    const wire = (bridge) => {
        bridge.window_state().then((s) => {
            render(s);
            if (!s.frameless) return;
            btn("ns-win-min").addEventListener("click", () => bridge.win_minimize());
            btn("ns-win-max").addEventListener("click", () => bridge.win_maximize().then(render));
            btn("ns-win-fs").addEventListener("click", () => bridge.win_fullscreen().then(render));
            btn("ns-win-close").addEventListener("click", () => bridge.win_close());
            // 顶栏空白处按下交给桌面端：桌面端在窗口线程上跟住光标搬窗口，JS 自己算位移只会抖
            const header = document.querySelector(".ns-header");
            const blank = (e) => e.button === 0 && !e.target.closest("a,button,input,select,textarea");
            header.addEventListener("mousedown", (e) => {
                if (!blank(e)) return;
                // 拖动期间鼠标捕获在桌面端窗口上，页面收不到 mouseup：拖动收尾时补一发，页面别停在按下态；
                // 桌面端在拖动途中可能顺手还原了最大化 / 退掉了全屏，图标按桌面端的状态重画一遍
                const up = () => document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
                Promise.resolve(bridge.win_start_drag()).finally(() => {
                    up();
                    bridge.window_state().then(render).catch(() => {});
                });
            });
            // 双击顶栏空白 = 原生标题栏语义：最大化 / 还原来回切；全屏时先退回窗口态
            header.addEventListener("dblclick", (e) => {
                if (!blank(e)) return;
                const done = state.fullscreen ? bridge.win_fullscreen() : bridge.win_maximize();
                Promise.resolve(done).then(render).catch(() => {});
            });
        }).catch(() => { /* 桥未就绪：顶栏不出控件 */ });
    };
    // 桥脚本在导航完成之后才注入且分两步：window.pywebview 先到（api 是空的），方法由 finish.js
    // 调 _createApi 后填。模块脚本跑在注入前面，第一趟多半只看到空 api：重试几轮再放弃，
    // 浏览器标签页里 api 永远不来，顶栏控件整块不出
    let tries = 0;
    const attach = () => {
        const bridge = window.pywebview?.api;
        if (!bridge?.window_state) {
            if (tries++ < 10) setTimeout(attach, 300);
            return;
        }
        wire(bridge);
    };
    attach();
}

// ====== 刷新快捷键 ======
// pywebview 把 WebView2 的浏览器加速器键整个绑在 debug 上（platforms/edgechromium.py 里
// AreBrowserAcceleratorKeysEnabled = debug）：不带 --debug 启动时 F5 / Ctrl+F5 / Ctrl+R
// 全被 WebView2 吞掉，热同步完前端在窗口里按刷新没反应。加速器键关掉后按键原样落到网页内容，
// 这里自己接管。JS 走 no-store（studio_server.py 的 no_store 中间件），整页刷新必取新文件。
function initReloadHotkey() {
    document.addEventListener("keydown", (e) => {
        if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyR")) {
            e.preventDefault();
            location.reload();
        }
    }, true);
}


// ====== 显存/内存监控（导演页生成面板底部） ======
// 只有导演生成会把显存吃满：读数挂在导演页，进导演页才轮询，离开即停
function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "--";
    const gb = n / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)}G` : `${Math.round(n / (1024 * 1024))}M`;
}

function setMemItem(el, used, total, label) {
    if (!Number.isFinite(total) || total <= 0) { el.textContent = `${label} --`; return; }
    const pct = used / total;
    el.textContent = `${label} ${fmtBytes(used)}/${fmtBytes(total)}`;
    el.classList.toggle("warn", pct >= 0.6 && pct < 0.85);
    el.classList.toggle("crit", pct >= 0.85);
}

async function pollMemStats() {
    const vramEl = document.getElementById("ns-vram");
    const ramEl = document.getElementById("ns-ram");
    if (!vramEl || !ramEl) return;
    try {
        // 驱动级显存占用（含全部进程）；/system_stats 的 vram_free 把 torch reserved 空闲重复计入，不准
        const r = await api.fetchApi("/neo_studio/mem_stats");
        const data = await r.json();
        if (data?.success) setMemItem(vramEl, data.vram_used, data.vram_total, t("显存"));
    } catch { /* 网络抖动忽略 */ }
    try {
        const r = await api.fetchApi("/system_stats");
        const data = await r.json();
        if (data?.system) {
            setMemItem(ramEl, (data.system.ram_total || 0) - (data.system.ram_free || 0), data.system.ram_total, t("内存"));
        }
    } catch { /* 网络抖动忽略 */ }
}

// 读数 + 清理按钮：导演页生成面板底部那一行；离线（无 memory 能力）整块不出
function buildMemBar() {
    if (!can("memory")) return null;
    const bar = $el("div", { className: "ns-mem" }, [
        $el("span", { className: "ns-mem-item", id: "ns-vram", title: t("GPU 显存占用（含全部进程）"), textContent: `${t("显存")} --` }),
        $el("span", { className: "ns-mem-item", id: "ns-ram", title: t("系统内存占用"), textContent: `${t("内存")} --` }),
    ]);
    const btn = $el("button", {
        className: "ns-mem-clear", id: "ns-clear-mem", type: "button",
        title: t("卸载空闲模型并释放显存缓存 · 生成后显存迟迟不降时用"), textContent: t("🧹 清理"),
    });
    btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = t("清理中…");
        try {
            const r = await api.fetchApi("/neo_studio/clear_memory", { method: "POST" });
            const data = await r.json().catch(() => null);
            btn.textContent = data?.success ? tf("释放 {n} ✓", { n: fmtBytes(data.freed_bytes) }) : t("清理失败");
        } catch {
            btn.textContent = t("清理失败");
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = t("🧹 清理"); }, 2500);
        pollMemStats();   // 立即刷新一次
    });
    bar.appendChild(btn);
    return bar;
}

let memTimer = null;

function setMemActive(on) {
    if (!on) {
        if (memTimer) { clearInterval(memTimer); memTimer = null; }
        return;
    }
    if (memTimer || !can("memory")) return;   // 离线：显存与清理都要 ComfyUI，别每 3s 撞 409
    pollMemStats();
    memTimer = setInterval(pollMemStats, 3000);
}

// ====== 顶栏 ComfyUI 状态位（只有桌面端窗口里有：comfy_state 由桌面端的 js_api 提供） ======
// 只报状态，不带动作 —— 启停在「设置 → 启动设置」顶部；端口 / 谁启动 / 进程号收在提示里。
function initComfyStatus() {
    const el = document.getElementById("ns-comfy-status");
    if (!el) return;
    const render = (s) => {
        setStarting(!!s.starting);   // 桌面端拉起的启动中：横幅与生成按钮文案跟着收
        if (userStarting || s.starting) {
            if (s.ready) {
                if (offline) return;   // 离线页由桌面端整页跳回完整 Studio，自己刷新只会回到离线页
                if (!pageReloaded) { pageReloaded = true; location.reload(); }
                return;
            }
            setStatus("starting", t("启动中"), t("ComfyUI 启动中…就绪后自动回到完整 Studio"));
            return;
        }
        setStatus(s.running ? "run" : null,
            s.running ? t("运行中") : t("已停止"),
            s.remote
                ? (s.running ? tf("远程 ComfyUI 运行中 · {remote} · 起停由远端机器管", { remote: s.remote })
                             : tf("远程 ComfyUI 不可达 · {remote}", { remote: s.remote }))
                : (s.running
                    ? tf("ComfyUI 运行中 · 端口 {port} · {by} · PID {pid}", { port: s.port, by: t(s.mine ? "桌面端启动" : "外部启动"), pid: s.pid })
                    : t("ComfyUI 已停止 · 在「设置 → 启动设置」点「启动内核」")));
    };

    onComfyState(render);

    // pywebview 的桥脚本在导航完成之后才注入，且分两步：window.pywebview 先出现，方法由 finish.js 调
    // _createApi 后填。只判断 api 对象存在就接管，第一次 poll 会抛 TypeError 打断整条启动链（route 再也
    // 不执行，窗口停在只出顶栏的空白页）。等真正要用的方法出现再接管：重试几轮再放弃，
    // 浏览器标签页里永远没有 api，状态位保持隐藏
    let tries = 0;
    const attach = () => {
        const api = window.pywebview?.api;
        if (!api?.comfy_state) {
            if (tries++ < 10) setTimeout(attach, 300);
            return;
        }
        el.hidden = false;
        const poll = () => api.comfy_state().then(publishComfyState).catch(() => {});
        poll();
        setInterval(poll, 5000);
    };
    attach();
}

function setStatus(kind, text, title) {
    const el = document.getElementById("ns-comfy-status");
    el.textContent = `● ${text}`;
    el.classList.remove("ns-comfy-run", "ns-comfy-starting");
    if (kind) el.classList.add(`ns-comfy-${kind}`);
    el.title = title;
}

// ====== 顶栏静态壳：index.html 里的中文是原文，按当前语言重画（切语言走整页刷新，不做运行中热替换） ======
function localizeShell() {
    document.title = t("新影工坊 · Neo Studio");
    const logo = document.querySelector(".ns-logo");
    if (logo) { logo.textContent = t("🎬 新影工坊"); logo.title = t("返回首页"); }
    for (const a of document.querySelectorAll(".ns-tabs a")) a.textContent = t(a.textContent.trim());
    for (const id of ["ns-win-min", "ns-win-max", "ns-win-fs", "ns-win-close"]) {
        const b = document.getElementById(id);
        if (b) b.title = t(b.title);
    }
}

function route() {
    const name = (location.hash || "#/gallery").replace(/^#\//, "").split("?")[0] || "gallery";
    if (name === "director") ensureView("director", buildDirector);
    else if (name === "skills") ensureView("skills", buildSkills);
    else if (name === "settings") ensureView("settings", buildSettings);
    else ensureView("gallery", buildGallery);
    showView(name);
}

// 仅 Studio 独立页启动：本文件也会作为扩展模块被主画布页加载（WEB_DIRECTORY），那里没有 #ns-view
if (view) {
    localizeShell();
    // 未捕获错误与启动失败一并写进桌面端日志：窗口白屏时日志里至少留下证据
    window.addEventListener("error", (e) => desktopLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => desktopLog(`REJECT ${e.reason?.stack || String(e.reason)}`));
    window.addEventListener("hashchange", route);
    initExtensions().then(async () => {
        await loadVersion();   // 先拿到离线标记与能力表，再建视图（生成按钮要按能力门控）
        initOfflineGate();
        route();   // 视图先挂上：桌面端附件（顶栏状态位）失败不能连坐，窗口不至于停在只出顶栏的空白页
        initComfyStatus();
        initWindowChrome();
        initReloadHotkey();
    }).catch(e => {
        console.error("[Neo Studio] startup failed:", e);
        desktopLog(`STARTUP FAILED ${e?.stack || e}`);
    });
}
