// 模型库弹窗（model-hub.js）：仓库分组 / 文件清单归类 / 落盘目标预览 /
// 下载启动与进度轮询（running → done）/ 取消保留断点 / 设置保存 / 源切换 / 失败提示。
import test from "node:test";
import assert from "node:assert/strict";
import {
    resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, missingRoutes,
    click, changeValue, inputText, keydown, sleep, clearBody,
} from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const hub = await import("../../web/model-hub.js");   // setup.mjs 副作用先行

const SETTINGS = {
    source: "modelscope", hf_endpoint: "", hf_token: "", ms_token: "ms-token",
    llm_subdir: "LLM", timeout_total: 3600, sock_read: 120,
};
const REPOS = [
    { repo: "Comfy-Org/z_image", on_hf: true, on_ms: true, downloads: 1234 },
    { repo: "Comfy-Org/ltx-2", on_hf: true, on_ms: false },
    { repo: "Comfy-Org/SomeNew", on_hf: false, on_ms: false },
];
const REGISTRY = { groups: [{ name: "生图", repos: ["Comfy-Org/z_image"] }], bundles: [] };
const FILES = [
    { path: "split_files/diffusion_models/z_image_bfp.safetensors", filename: "z_image_bfp.safetensors", category: "diffusion_models", size: 12 * 1024 ** 3, exists: true },
    { path: "split_files/text_encoders/qwen3_8b.safetensors", filename: "qwen3_8b.safetensors", category: "text_encoders", size: 8.2 * 1024 ** 3, exists: false },
    { path: "qwen3_8b_q4_k_m.gguf", filename: "qwen3_8b_q4_k_m.gguf", category: "llm", size: 5 * 1024 ** 3, exists: false },
];

function mockHub(progress = () => jsonResponse({ download: { state: "idle" } })) {
    mockRoute("/neo_model_hub/settings", (body, call) => jsonResponse(
        call.method === "GET"
            ? { settings: SETTINGS, registry: REGISTRY, categories: ["diffusion_models", "text_encoders", "llm"], sources: ["modelscope", "huggingface"] }
            : { success: true, settings: { ...SETTINGS, ...body } }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: REPOS, ms_live: true }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ files: FILES, categories: ["diffusion_models", "text_encoders", "llm"] }));
    mockRoute("/neo_model_hub/download", () => jsonResponse({ success: true, download: { state: "running" } }));
    mockRoute("/neo_model_hub/cancel", () => jsonResponse({ success: true, download: { state: "cancelling" } }));
    mockRoute("/neo_model_hub/progress", progress);
}

async function openHub(opts = {}) {
    hub.closeModelHub();
    const overlay = hub.openModelHub(opts);
    await sleep(60);
    return overlay;
}

test("模型库：打开弹窗注入样式并拉取设置与仓库列表", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();

    assert.equal(document.getElementById("neo-hub-css")?.getAttribute("href"),
        "/extensions/ComfyUI-Neo-Nodes/model-hub.css", "样式未注入");
    assert.ok(overlay.querySelector(".neo-hub-title")?.textContent.includes("模型库"), "标题缺失");
    assert.deepEqual(missingRoutes.filter((r) => r.includes("/neo_model_hub/")), [], "有未覆盖的模型库请求");

    // 仓库下拉：注册表分组在前，未收录的落「其他」，带源标记与下载数
    const groups = [...overlay.querySelectorAll(".neo-hub-repo optgroup")];
    assert.deepEqual(groups.map((g) => g.label), ["生图", "其他"], "分组未按注册表生成");
    assert.deepEqual([...groups[0].querySelectorAll("option")].map((o) => o.textContent),
        ["Comfy-Org/z_image · 1234 · 双源"], "分组内条目缺失下载数 / 源标记");
    assert.deepEqual([...groups[1].querySelectorAll("option")].map((o) => o.textContent),
        ["Comfy-Org/ltx-2 · HF", "Comfy-Org/SomeNew · 未探测"], "「其他」分组内容不符");

    // 默认源同步到源按钮
    const active = [...overlay.querySelectorAll(".neo-hub-src-btn")]
        .filter((b) => b.classList.contains("neo-hub-src-active")).map((b) => b.dataset.source);
    assert.deepEqual(active, ["modelscope"], "默认源未同步到源按钮");
    hub.closeModelHub();
});


test("模型库：文件清单归类与已存在标记，选文件带出落盘目标", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();

    const opts = [...overlay.querySelectorAll(".neo-hub-files option")];
    assert.deepEqual(opts.map((o) => o.textContent), [
        "z_image_bfp.safetensors  [diffusion_models]  12.00 GB  ✓ 已存在",
        "qwen3_8b.safetensors  [text_encoders]  8.20 GB",
        "qwen3_8b_q4_k_m.gguf  [llm]  5.00 GB",
    ], "文件清单条目不符");

    // 选 GGUF → 落盘类别自动带出，子目录参与目标预览
    changeValue(overlay.querySelector(".neo-hub-files"), "qwen3_8b_q4_k_m.gguf");
    inputText(overlay.querySelector(".neo-hub-sub"), "Qwen");
    assert.equal(overlay.querySelector(".neo-hub-cat").value, "llm", "类别未随文件带出");
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/llm/Qwen/qwen3_8b_q4_k_m.gguf", "落盘目标预览不符");

    // 搜索：回车按当前源带 query 拉仓库
    inputText(overlay.querySelector(".neo-hub-search"), "z_image");
    keydown(overlay.querySelector(".neo-hub-search"), "Enter");
    await sleep(40);
    const repoReq = fetchLog.filter((c) => c.path === "/neo_model_hub/repos").at(-1);
    assert.equal(repoReq.body.query, "z_image", "搜索词未带上");
    assert.equal(repoReq.body.source, "modelscope", "仓库请求未带当前源");
    hub.closeModelHub();
});

test("模型库：下载启动后轮询进度，完成时提示并刷新文件清单", async () => {
    resetEnv();
    clearRoutes();
    let prog = { state: "running", total: 1000, done: 250, speed: 500, filename: "qwen3_8b.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    const overlay = await openHub();

    changeValue(overlay.querySelector(".neo-hub-files"), "split_files/text_encoders/qwen3_8b.safetensors");
    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(60);

    const dlReq = fetchLog.filter((c) => c.path === "/neo_model_hub/download").at(-1);
    assert.deepEqual(dlReq.body, {
        source: "modelscope", repo: "Comfy-Org/z_image",
        path: "split_files/text_encoders/qwen3_8b.safetensors",
        category: "text_encoders", subfolder: "", filename: "qwen3_8b.safetensors",
    }, "下载请求体不符");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, true, "下载中应禁用下载按钮");

    await sleep(900);
    assert.equal(overlay.querySelector(".neo-hub-cancel").disabled, false, "running 后取消按钮应可用");
    assert.equal(overlay.querySelector(".neo-hub-bar i").style.width, "25%", "进度条宽度不符");
    assert.equal(overlay.querySelector(".neo-hub-prog").textContent,
        "25.0% · 250 B / 1000 B · 500 B/s", "进度文案不符");

    prog = { state: "done", total: 1000, done: 1000, speed: 0, filename: "qwen3_8b.safetensors", category: "text_encoders" };
    const filesBefore = fetchLog.filter((c) => c.path === "/neo_model_hub/files").length;
    await sleep(900);
    assert.ok(appState.toasts.some((t) => t.summary === "下载完成"), "完成未提示");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, false, "完成后应恢复下载按钮");
    assert.ok(fetchLog.filter((c) => c.path === "/neo_model_hub/files").length > filesBefore, "完成后未刷新文件清单");
    hub.closeModelHub();
});


test("模型库：取消保留断点，切源与保存设置后重拉仓库", async () => {
    resetEnv();
    clearRoutes();
    let prog = { state: "running", total: 1000, done: 100, speed: 100, filename: "a.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    const overlay = await openHub();

    changeValue(overlay.querySelector(".neo-hub-files"), "split_files/diffusion_models/z_image_bfp.safetensors");
    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(900);
    click(overlay.querySelector(".neo-hub-cancel"));
    await sleep(40);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/cancel").length, 1, "取消未发请求");

    prog = { state: "paused", total: 1000, done: 100, speed: 0, error: "已取消（断点保留）" };
    await sleep(900);
    assert.equal(overlay.querySelector(".neo-hub-status").textContent, "已取消（断点保留）", "断点提示不符");
    assert.ok(appState.toasts.some((t) => t.summary === "已取消"), "取消未提示");
    assert.equal(overlay.querySelector(".neo-hub-cancel").disabled, true, "取消后应禁用取消按钮");

    // 切源 → 按新源重拉仓库
    const hfBtn = [...overlay.querySelectorAll(".neo-hub-src-btn")].find((b) => b.dataset.source === "huggingface");
    click(hfBtn);
    await sleep(40);
    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_model_hub/repos").map((c) => c.body.source),
        ["modelscope", "huggingface"], "切换源未重拉仓库");

    // 设置面板：展开 → 改 LLM 子目录 → 保存（POST 表单值）→ 重拉仓库
    click(overlay.querySelector('.neo-hub-icon-btn[title^="模型库设置"]'));
    const panel = overlay.querySelector(".neo-hub-settings");
    assert.equal(panel.style.display, "block", "设置面板未展开");
    inputText(panel.querySelectorAll("input")[3], "LLM1");
    click(panel.querySelector(".neo-hub-save"));
    await sleep(60);
    const saved = fetchLog.filter((c) => c.path === "/neo_model_hub/settings" && c.method === "POST").at(-1);
    assert.equal(saved.body.llm_subdir, "LLM1", "LLM 子目录未提交");
    assert.ok(appState.toasts.some((t) => t.summary === "模型库设置已保存"), "保存未提示");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/repos").length, 3, "保存后未重拉仓库");
    hub.closeModelHub();
});

test("模型库：接口失败给出可读提示且弹窗保持可用", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_model_hub/settings", () => jsonResponse({ settings: SETTINGS, registry: REGISTRY, categories: ["diffusion_models"] }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: REPOS, ms_live: false }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ error: "仓库不存在该文件" }, 404));
    const overlay = await openHub();

    assert.match(overlay.querySelector(".neo-hub-files").textContent, /文件清单加载失败：仓库不存在该文件/, "清单失败未提示");
    assert.ok(appState.toasts.some((t) => t.summary === "文件清单加载失败"), "清单失败未 toast");
    assert.match(overlay.querySelector(".neo-hub-repo").nextSibling.textContent, /MS 组织列表需 Token/, "无 Token 提示缺失");

    click(overlay.querySelector(".neo-hub-head .neo-hub-icon-btn:last-of-type"));
    assert.equal(document.querySelector(".neo-hub-overlay"), null, "关闭后弹窗未移除");
    hub.closeModelHub();
    clearBody();
});
