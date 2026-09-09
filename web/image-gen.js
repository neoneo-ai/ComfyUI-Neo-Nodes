/**
 * image-gen.js
 * 出图（Krea2）客户端：/neo_image_gen/* API 包装、任务事件等待、四视图模板拼装、
 * 结果发送到 LoadImage 节点（复用 /neo_gallery/copy_to_input）与出图设置表单。
 * 设置表单挂在「自动增强」菜单内，接口形态与 llm-setting.js 一致：{ el, load, save }。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { loadSkill } from "./skill.js";
import { attachComboBox } from "./combo-box.js";
import { mkEl } from "./dom-utils.js";
import { showToast } from "./gallery-utils.js";

const GEN_API = "/neo_image_gen";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const GEN_PLACEHOLDER = "【人物形象描述】";
// 后端 _watch 按变化推送的任务快照事件（广播，按 task_id 过滤）
const STATUS_EVENT = "rs.image_gen.status";

// ==========================================
// API 包装
// ==========================================

async function getJson(path) {
    const resp = await fetch(path);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

export async function getGenSettings() {
    return getJson(`${GEN_API}/settings`);
}

export async function saveGenSettings(patch) {
    const resp = await fetch(`${GEN_API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

export async function listGenModels() {
    return getJson(`${GEN_API}/models`);
}

/** 提交出图任务，返回任务快照（含 task_id / warnings）；失败抛 Error(后端消息) */
export async function requestGeneration(payload) {
    const resp = await fetch(`${GEN_API}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

export async function cancelTask(taskId) {
    try {
        await fetch(`${GEN_API}/cancel/${encodeURIComponent(taskId)}`, { method: "POST" });
    } catch (e) {
        console.warn("cancel generation failed:", e);
    }
}

/** 把当前画布工作流（API prompt）保存为出图技能；返回 { id, warnings } */
export async function saveWorkflowSkill({ name, description, tags, workflow }) {
    const resp = await fetch(`${GEN_API}/save_workflow_skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, tags: tags || [], workflow })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 读技能的出图设置覆盖（config.json；缺失返回 {}） */
export async function getSkillGenConfig(skillId) {
    try {
        return await getJson(`${GEN_API}/skill_config?skill_id=${encodeURIComponent(skillId)}`);
    } catch (e) {
        return {};
    }
}

/** 写技能的出图设置覆盖（预设只读，失败抛 Error(后端消息)） */
export async function saveSkillGenConfig(skillId, config) {
    const resp = await fetch(`${GEN_API}/skill_config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: skillId, config: config || {} })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 「复制为自定义」时把源技能的 workflow.json / config.json 一并带过去（失败静默） */
export async function copySkillFiles(fromId, toId) {
    try {
        await fetch(`${GEN_API}/copy_skill_files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_id: fromId, to_id: toId })
        });
    } catch (e) {
        console.warn("copy skill files failed:", e);
    }
}

/**
 * 等待任务到终态（succeeded/failed/cancelled），返回最终快照。
 * 后端把快照按变化经 WebSocket 推送（rs.image_gen.status），这里订阅事件而非轮询
 * HTTP；订阅后兜底首拉一次当前状态（兜住推送前已终态的任务），断线重连时再拉一次
 * 补漏；约 40 分钟无终态按失败收场，避免无限等待。
 */
export function watchTask(taskId, onSnapshot, isCancelled) {
    return new Promise((resolve) => {
        const statusUrl = `${GEN_API}/status/${encodeURIComponent(taskId)}`;
        let timeout;
        function finish(snap) {
            clearTimeout(timeout);
            api.removeEventListener(STATUS_EVENT, onStatus);
            api.removeEventListener("reconnected", onReconnected);
            resolve(snap);
        }
        function apply(snap) {
            if (!snap || snap.task_id !== taskId) return;
            onSnapshot?.(snap);
            if (TERMINAL_STATUSES.has(snap.status)) finish(snap);
        }
        function resync() {
            // 兜底拉取（非轮询）：订阅窗口与断线重连可能错过推送
            getJson(statusUrl).then(apply).catch(() => {}); // 404/网络抖动：等推送或重连再拉
        }
        function onStatus(event) {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            apply(event.detail);
        }
        function onReconnected() {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            resync();
        }
        timeout = setTimeout(
            () => finish({ status: "failed", error: "等待出图超时，请稍后在 Gallery 查看" }),
            40 * 60 * 1000
        );
        api.addEventListener(STATUS_EVENT, onStatus);
        api.addEventListener("reconnected", onReconnected);
        if (isCancelled?.()) {
            finish({ status: "cancelled" });
            return;
        }
        resync();
    });
}

// ==========================================
// 四视图模板：占位符替换（仅参考图模式需要）；结构指令由后端固定前缀 + 四视图 LoRA 提供
// ==========================================

const templateCache = new Map();

async function loadGenTemplate(skillId) {
    if (templateCache.has(skillId)) return templateCache.get(skillId);
    const full = await loadSkill(skillId).catch(() => null);
    const body = full && !full.error ? String(full.content || "") : "";
    templateCache.set(skillId, body);
    return body;
}

/**
 * 拼装出图提示词：无参考图直接用用户文本；有参考图套 skill 正文模板。
 * 模板含占位符则全部替换为用户文本，否则把文本附在模板前。
 */
export async function buildGenPrompt(skillId, text, hasRefs) {
    if (!hasRefs) return text;
    const body = await loadGenTemplate(skillId);
    if (!body) return text;
    if (body.includes(GEN_PLACEHOLDER)) {
        return body.split(GEN_PLACEHOLDER).join(text || "参考图片中的角色形象");
    }
    return `${text}\n${body}`;
}

// ==========================================
// 发送到 LoadImage 节点（复用 Gallery 的 copy_to_input 通道）
// ==========================================

function findImageWidget(node) {
    return (node.widgets || []).find(w =>
        w.type === "combo" && /image/i.test(w.name || "")) || null;
}

/** 收集画布上可用的 LoadImage 目标：跳过禁用(mode 4)，按画布位置 y → x 排序 */
export function collectLoadImageTargets() {
    const nodes = app.graph?._nodes || [];
    const targets = [];
    for (const node of nodes) {
        if (node.mode === 4) continue;
        const cls = String(node.comfyClass || node.type || "");
        if (!/load.?image/i.test(cls)) continue;
        const widget = findImageWidget(node);
        if (widget) targets.push({ node, widget });
    }
    targets.sort((a, b) =>
        ((a.node.pos?.[1] ?? 0) - (b.node.pos?.[1] ?? 0))
        || ((a.node.pos?.[0] ?? 0) - (b.node.pos?.[0] ?? 0)));
    return targets;
}

/** 把输出目录里的图复制进 input（Gallery 通道），返回 LoadImage 应显示的文件名 */
async function copyOutputToInput(image) {
    const query = "?filename=" + encodeURIComponent(image.filename)
        + (image.subfolder ? "&subfolder=" + encodeURIComponent(image.subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input" + query);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || result.success === false) {
        throw new Error(result?.error || "复制到输入目录失败");
    }
    return result.skipped ? image.filename : result.filename;
}

async function applyImageToTarget(target, image) {
    const filename = await copyOutputToInput(image);
    target.widget.value = filename;
    if (target.widget.type === "combo" && target.widget.callback) {
        target.widget.callback(filename);
    } else if (target.node.onWidgetChanged) {
        target.node.onWidgetChanged(target.widget.name, filename);
    }
    app.graph.setDirtyCanvas(true, true);
}

// 目标选择菜单：内联插入到按钮下方（DOM 流内布局，节点 UI 在变换容器里 fixed 定位坐标不可靠）
let openSendMenu = null;

function closeSendMenu() {
    if (!openSendMenu) return;
    openSendMenu.remove();
    openSendMenu = null;
    document.removeEventListener("pointerdown", onSendMenuOutside, true);
}

function onSendMenuOutside(e) {
    if (!openSendMenu || openSendMenu.contains(e.target)) return;
    closeSendMenu();
}

// 新建节点后 image widget 可能尚未构建完成，短轮询等待
async function waitForImageWidget(node, tries = 20, delayMs = 30) {
    for (let i = 0; i < tries; i++) {
        const w = findImageWidget(node);
        if (w) return w;
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error("Load Image 节点创建后未找到图片选项");
}

// 画布上没有 LoadImage 时自动创建一个（放在按钮下方，屏幕坐标经 canvasPosToGraph 换算到画布坐标）并写入图片
async function createLoadImageTarget(anchorEl, image) {
    const L = globalThis.LiteGraph;
    if (!L?.createNode) throw new Error("无法创建 Load Image 节点");
    const node = L.createNode("LoadImage");
    app.graph.add(node);
    try {
        const cv = app.canvas;
        const cRect = cv?.canvas?.getBoundingClientRect?.() || { left: 0, top: 0 };
        const aRect = anchorEl.getBoundingClientRect();
        const localX = aRect.left - cRect.left;
        const localY = aRect.bottom - cRect.top + 8;
        node.pos = cv?.canvasPosToGraph ? cv.canvasPosToGraph([localX, localY]) : [localX, localY];
    } catch {
        node.pos = [200, 200];
    }
    app.graph.setDirtyCanvas(true);
    const widget = await waitForImageWidget(node);
    await applyImageToTarget({ node, widget }, image);
    return { node, widget };
}

/** 单图发送：唯一目标直接写入；多目标弹菜单确认；无目标自动新建 LoadImage */
export function sendImageToLoadImage(image, anchorEl) {
    closeSendMenu();
    const targets = collectLoadImageTargets();
    if (!targets.length) {
        createLoadImageTarget(anchorEl, image)
            .then(({ node }) => showToast(app, "success", "已发送", `新建 Load Image #${node.id} 并写入`))
            .catch(e => showToast(app, "error", "发送失败", e.message));
        return;
    }
    if (targets.length === 1) {
        const t = targets[0];
        applyImageToTarget(t, image)
            .then(() => showToast(app, "success", "已发送", `写入 ${t.node.title || "LoadImage"} #${t.node.id}`))
            .catch(e => showToast(app, "error", "发送失败", e.message));
        return;
    }
    const menu = mkEl("div", "rs-gen-send-menu");
    const title = mkEl("div", "rs-gen-send-menu-title");
    title.textContent = "发送到 Load Image";
    menu.appendChild(title);
    const selectedIds = new Set(Object.values(app.canvas?.selected_nodes || {}).map(n => n.id));
    for (const t of targets) {
        const item = mkEl("button", "rs-gen-send-menu-item");
        item.type = "button";
        item.textContent = `#${t.node.id} ${t.node.title || t.node.type || "LoadImage"}${selectedIds.has(t.node.id) ? "  ✓" : ""}`;
        item.addEventListener("click", () => {
            closeSendMenu();
            applyImageToTarget(t, image)
                .then(() => showToast(app, "success", "已发送", `写入 ${t.node.title || "LoadImage"} #${t.node.id}`))
                .catch(e => showToast(app, "error", "发送失败", e.message));
        });
        menu.appendChild(item);
    }
    anchorEl.insertAdjacentElement("afterend", menu);
    openSendMenu = menu;
    document.addEventListener("pointerdown", onSendMenuOutside, true);
}

/** 多图装配：按画布顺序把每张图依次写入一个 LoadImage（多余图跳过并提示） */
export async function assembleAllGenerated(images) {
    if (!images?.length) return;
    const targets = collectLoadImageTargets();
    if (!targets.length) {
        showToast(app, "warning", "装配", "画布上没有可用的 Load Image 节点");
        return;
    }
    const n = Math.min(images.length, targets.length);
    let ok = 0;
    let lastError = "";
    for (let i = 0; i < n; i++) {
        try {
            await applyImageToTarget(targets[i], images[i]);
            ok++;
        } catch (e) {
            lastError = e.message;
        }
    }
    if (ok === images.length) {
        showToast(app, "success", "装配完成", `${ok} 张已写入 Load Image 节点`);
    } else {
        const detail = targets.length < images.length
            ? `画布节点不足，已写入 ${ok}/${images.length} 张`
            : `已写入 ${ok}/${images.length} 张${lastError ? "：" + lastError : ""}`;
        showToast(app, ok > 0 ? "warning" : "error", "装配", detail);
    }
}

// ==========================================
// 出图设置表单（挂「自动增强」菜单内）
// ==========================================

function shortModelName(name) {
    const tail = String(name || "").split("/").pop();
    return tail.replace(/\.(safetensors|sft|pt|bin|gguf)$/i, "");
}

// 四视图 LoRA 名称线索（与后端 _QUADVIEW_HINTS 对齐，大小写不敏感）；命中则「依赖参考图」默认勾选
function isQuadviewName(name) {
    return /quadview|四视图/i.test(String(name || ""));
}

function fillComboSelect(select, files, suggested, current) {
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = suggested ? `自动（${shortModelName(suggested)}）` : "自动";
    select.appendChild(auto);
    for (const f of files || []) {
        const opt = document.createElement("option");
        opt.value = f;
        opt.textContent = shortModelName(f);
        select.appendChild(opt);
    }
    select.value = (files || []).includes(current) ? current : "";
}

function numberRow(labelText, attrs) {
    const row = mkEl("div", "rs-config-row");
    const label = mkEl("label", "rs-form-label");
    label.textContent = labelText;
    const input = mkEl("input", "rs-form-input");
    input.type = "number";
    Object.assign(input, attrs);
    row.append(label, input);
    return { row, input };
}

/** 出图模型 / Text Encoder / VAE + LoRA 列表控件区（全局出图设置与每技能设置共用）。 */
export function createModelConfigSection() {
    const section = mkEl("div", "rs-gen-model-section");

    // 三个模型选择行：空值 = 按名称线索自动挑选（后端 suggest_model），用户可显式指定
    const makeComboRow = (labelText, placeholder) => {
        const row = mkEl("div", "rs-config-row");
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, { placeholder }).box;
        row.append(label, combo);
        return { row, select };
    };
    const modelCtl = makeComboRow("出图模型");
    const encoderCtl = makeComboRow("Text Encoder");
    const vaeCtl = makeComboRow("VAE");

    // LoRA 行：动态增删，每行 = 模型选择 + 强度
    const loraRow = mkEl("div", "rs-config-row");
    const loraLabel = mkEl("label", "rs-form-label");
    loraLabel.textContent = "LoRA";
    const loraList = mkEl("div", "rs-gen-lora-list");
    const loraAddBtn = mkEl("button", "rs-gen-lora-add");
    loraAddBtn.type = "button";
    loraAddBtn.textContent = "+ 添加 LoRA";
    loraRow.append(loraLabel, loraList, loraAddBtn);
    section.append(modelCtl.row, encoderCtl.row, vaeCtl.row, loraRow);

    let loraFiles = [];
    let suggestedLora = "";

    function addLoraRow(name = "", strength = 1.0, refOnly = false) {
        const line = mkEl("div", "rs-gen-lora-row");
        const select = document.createElement("select");
        const combo = attachComboBox(select).box;
        // 「依赖参考图」复选框：勾选 = 仅参考图模式加载（四视图 LoRA 即勾此项者），不勾 = 文生图也加载
        const refOnlyWrap = mkEl("label", "rs-gen-lora-refonly-wrap");
        const refOnlyChk = mkEl("input", "rs-gen-lora-refonly");
        refOnlyChk.type = "checkbox";
        refOnlyChk.checked = !!refOnly;
        const refOnlyTxt = mkEl("span", "rs-gen-lora-refonly-txt");
        refOnlyTxt.textContent = "依赖参考图";
        refOnlyWrap.append(refOnlyChk, refOnlyTxt);
        refOnlyWrap.setAttribute("data-rs-tooltip", "编辑 LoRA（依赖参考图）：勾选 = 仅参考图模式加载，不勾 = 文生图也无条件加载");
        const strengthInput = mkEl("input", "rs-gen-lora-strength");
        strengthInput.type = "number";
        strengthInput.min = -10;
        strengthInput.max = 10;
        strengthInput.step = 0.05;
        strengthInput.value = strength;
        const delBtn = mkEl("button", "rs-gen-lora-del");
        delBtn.type = "button";
        delBtn.textContent = "✕";
        delBtn.setAttribute("data-rs-tooltip", "移除此 LoRA");
        delBtn.addEventListener("click", () => line.remove());
        select.addEventListener("change", () => {
            if (isQuadviewName(select.value)) refOnlyChk.checked = true;
        });
        line.append(combo, strengthInput, refOnlyWrap, delBtn);
        fillComboSelect(select, loraFiles, suggestedLora, name);
        loraList.appendChild(line);
    }

    loraAddBtn.addEventListener("click", () => addLoraRow());

    function load(settings, models) {
        loraFiles = models.loras || [];
        suggestedLora = models.suggested_lora || "";
        fillComboSelect(modelCtl.select, models.diffusion_models || [],
            models.suggested_diffusion_models || "", settings.model || "");
        fillComboSelect(encoderCtl.select, models.text_encoders || [],
            models.suggested_text_encoders || "", settings.text_encoder || "");
        fillComboSelect(vaeCtl.select, models.vae || [],
            models.suggested_vae || "", settings.vae || "");
        loraList.innerHTML = "";
        for (const entry of settings.loras || []) {
            if (typeof entry === "string") addLoraRow(entry, 1.0, isQuadviewName(entry));
            else if (entry && typeof entry === "object")
                addLoraRow(entry.name || "", entry.strength ?? 1.0,
                    "ref_only" in entry ? !!entry.ref_only : isQuadviewName(entry.name || ""));
        }
    }

    function collect() {
        const loras = [];
        for (const line of loraList.querySelectorAll(".rs-gen-lora-row")) {
            const select = line.querySelector("select");
            const strength = line.querySelector(".rs-gen-lora-strength");
            const refOnly = line.querySelector(".rs-gen-lora-refonly");
            const name = select ? select.value : "";
            if (!name) continue;
            loras.push({ name, strength: parseFloat(strength?.value ?? "1") || 1.0,
                         ref_only: !!(refOnly && refOnly.checked) });
        }
        return {
            model: modelCtl.select.value,
            text_encoder: encoderCtl.select.value,
            vae: vaeCtl.select.value,
            loras,
        };
    }

    return { el: section, load, collect };
}

/** 出图张数 / 长边尺寸 / 默认比例 / 输出前缀控件区（全局出图设置与每技能设置共用）。 */
export function createGenSizeRows() {
    const section = mkEl("div", "rs-gen-size-section");
    const countCtl = numberRow("出图张数", { min: 1, max: 8, step: 1, value: 1 });

    // 下拉行（长边尺寸 / 默认比例）：结构同模型选择行
    const makeChoiceRow = (labelText) => {
        const row = mkEl("div", "rs-config-row");
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, {}).box;
        row.append(label, combo);
        return { row, select };
    };
    const sizeCtl = makeChoiceRow("长边尺寸");
    const ratioCtl = makeChoiceRow("默认比例");

    // 输出前缀（可含子目录），写入模板 {{PREFIX}}
    const prefixRow = mkEl("div", "rs-config-row");
    const prefixLabel = mkEl("label", "rs-form-label");
    prefixLabel.textContent = "输出前缀";
    const prefixInput = mkEl("input", "rs-form-input");
    prefixInput.type = "text";
    prefixInput.placeholder = "NeoAgent";
    prefixRow.append(prefixLabel, prefixInput);

    // 常用长边（像素）与比例下拉可选；空值（「默认」）= 走后端默认；
    // 未列出的已保存值自动追加为「…（已保存）」项保留，避免切下拉即丢数据
    const COMMON_EDGES = ["1024", "1152", "1280", "1536", "1792", "2048", "2560", "3072"];
    const COMMON_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
    function fillChoiceSelect(select, options, current) {
        select.innerHTML = "";
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "默认";
        select.appendChild(auto);
        for (const v of options) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
        }
        select.value = options.includes(current) ? current : "";
        if (current && !options.includes(current)) {
            const keep = document.createElement("option");
            keep.value = current;
            keep.textContent = current + "（已保存）";
            select.appendChild(keep);
            select.value = current;
        }
    }

    // 三个数值/短文本参数压成一行三列网格
    const grid = mkEl("div", "rs-gen-grid");
    grid.append(countCtl.row, sizeCtl.row, ratioCtl.row);
    section.append(grid, prefixRow);

    function load(settings) {
        countCtl.input.value = settings.count ?? 1;
        fillChoiceSelect(sizeCtl.select, COMMON_EDGES, String(settings.base_resolution ?? ""));
        fillChoiceSelect(ratioCtl.select, COMMON_RATIOS, String(settings.default_ratio ?? ""));
        prefixInput.value = settings.output_prefix ?? "";
    }

    function collect() {
        return {
            count: parseInt(countCtl.input.value, 10) || 1,
            base_resolution: parseInt(sizeCtl.select.value, 10) || 1280,
            default_ratio: ratioCtl.select.value.trim(),
            output_prefix: prefixInput.value.trim(),
        };
    }

    return { el: section, load, collect };
}

/** 全局出图设置表单（「自动增强」菜单内）：模型/LoRA 区 + 尺寸/前缀区 + 保存按钮。 */
export function createImageGenSettingsForm() {
    const form = mkEl("div", "rs-gen-settings");
    const modelSection = createModelConfigSection();
    const sizeSection = createGenSizeRows();

    // 显式保存按钮：选择后立即落盘，不依赖关菜单时的静默保存
    const saveBtn = mkEl("button", "rs-gen-save");
    saveBtn.type = "button";
    saveBtn.textContent = "💾 保存设置";
    let saveResetTimer = null;
    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        const ok = await save();
        saveBtn.disabled = false;
        saveBtn.textContent = ok ? "✓ 已保存" : "✕ 保存失败";
        clearTimeout(saveResetTimer);
        saveResetTimer = setTimeout(() => { saveBtn.textContent = "💾 保存设置"; }, 1600);
    });
    const saveRow = mkEl("div", "rs-config-row");
    saveRow.appendChild(saveBtn);

    form.append(modelSection.el, sizeSection.el, saveRow);

    // 加载窗口标记：load() 异步回填期间（await 网络请求）不算 dirty，避免初始化误判
    let loading = false;

    async function load() {
        loading = true;
        try {
            const [settings, models] = await Promise.all([getGenSettings(), listGenModels()]);
            modelSection.load(settings, models);
            sizeSection.load(settings);
            snapshot = collect();
        } catch (e) {
            console.warn("Failed to load image gen settings:", e);
        } finally {
            loading = false;
        }
    }

    // 收集当前表单值（与后端 /neo_image_gen/settings 字段对齐）；save 与脏检查共用
    function collect() {
        return { ...modelSection.collect(), ...sizeSection.collect() };
    }

    // load/save 后的表单快照，用于关闭菜单时判断是否有未保存修改
    let snapshot = null;

    async function save() {
        try {
            await saveGenSettings(collect());
            snapshot = collect();
            return true;
        } catch (e) {
            console.warn("Failed to save image gen settings:", e);
            return false;
        }
    }

    // 当前表单相对最近一次 load/save 是否有改动（供关闭菜单时确认用）；加载窗口内恒为 false
    function isDirty() {
        if (loading) return false;
        return snapshot !== null && JSON.stringify(collect()) !== JSON.stringify(snapshot);
    }

    return { el: form, load, save, isDirty };
}
