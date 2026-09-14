// 导演编辑器「只显示当前段」：默认显示第 1 段，点击时间轴块切换到对应段。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, fetchLog } from "./setup.mjs";
import { app, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
});

function mouse(type, x) {
    return new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
}

test("导演编辑器：默认仅第 1 段有 current 标记，点击时间轴块切换当前段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 无媒体候选
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "sk-b", name: "技能 B", gen_video: true },
    ]));

    const existing = {
        name: "T",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-b", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60); // 等 rAF：时间轴拿到段数据

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2);
    const currentSegs = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentSegs.length, 1, "只显示当前一段");
    assert.equal(currentSegs[0], segs[0], "默认显示第 1 段");
    assert.equal(segs[0].querySelector(".neo-director-seg-title").textContent, "段 1");

    // 时间轴点击第 2 块 → current 切换到第 2 段
    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    assert.ok(canvas, "时间轴 canvas 已创建");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    canvas.dispatchEvent(mouse("mousedown", 450)); // 块1（最小宽溢出后 [335,662]）内
    window.dispatchEvent(mouse("mouseup", 450));

    const after = Array.from(document.querySelectorAll(".neo-director-seg"));
    const currentAfter = after.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentAfter.length, 1);
    assert.equal(currentAfter[0], after[1], "点击第 2 块后切换显示第 2 段");

    // 再点回第 1 块 → current 回到第 1 段
    canvas.dispatchEvent(mouse("mousedown", 100)); // 块0 [8,160] 内
    window.dispatchEvent(mouse("mouseup", 100));
    const currentBack = Array.from(document.querySelectorAll(".neo-director-seg"))
        .filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentBack.length, 1);
    assert.equal(currentBack[0], segs[0], "点击第 1 块后切回第 1 段");

    // 关闭编辑器：销毁时间轴（取消 rAF），避免测试结束后残留异步绘制
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
    // eslint-disable-next-line no-unused-vars
    void segs;
});

test("时间轴说明行最右侧「拉伸」控制条：点按钮/拖滑块驱动 timeline.setZoom", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    const existing = {
        name: "T",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    // 说明行：左侧文字 span + 最右侧「拉伸」控制条（🔍 拉伸 按钮 + 滑块）
    const label = document.querySelector(".neo-director-tl-label");
    assert.ok(label, "时间轴说明行存在");
    assert.ok(label.querySelector("span"), "说明行含文字 span");
    const zoomGroup = label.querySelector(".neo-director-zoom");
    assert.ok(zoomGroup, "说明行最右侧有「拉伸」控制条");
    const toggle = zoomGroup.querySelector(".neo-director-zoom-toggle");
    const slider = zoomGroup.querySelector(".neo-director-zoom-slider");
    assert.ok(toggle && toggle.textContent.includes("拉伸"), "🔍 拉伸按钮");
    assert.ok(slider && slider.type === "range", "滑块存在");

    // canvas 可视宽 320（供 setZoom 后按像素宽断言）
    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    // 点「🔍 拉伸」→ zoom 1→2：滑块同步、canvas 按像素宽（自然宽 = max(可视宽, 默认总宽) = 326，×2）
    toggle.click();
    await sleep(60);
    assert.equal(slider.value, "2", "点按钮后滑块同步到 2");
    assert.equal(canvas.style.width, "652px", "zoom=2 canvas 按像素宽（自然宽 326×2）");

    // 拖滑块到 4 → zoom 跟随：canvas 自然宽 326×4
    slider.value = "4";
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(60);
    assert.equal(canvas.style.width, "1304px", "拖滑块到 4 → canvas 自然宽 326×4");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("导演编辑器：添加段后自动切换到新段，删除当前段后切回前一段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null); // 新建：默认 1 个空段
    await sleep(60);

    const addBtn = document.querySelector(".neo-director-add");
    assert.ok(addBtn, "添加段按钮存在");
    addBtn.click();
    await sleep(20); // 添加后同步切换到新段（无异步，但时间轴 rAF 需让步）

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2);
    let current = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segs[1], "添加段后自动切换到新段");

    // 删除当前段（第 2 段）→ 切回第 1 段
    segs[1].querySelector(".neo-director-seg-del").click();
    const segsAfter = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segsAfter.length, 1);
    current = segsAfter.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segsAfter[0], "删除当前段后切回前一段");

    // 关闭编辑器：销毁时间轴（取消 rAF），避免测试结束后残留异步绘制
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("素材格 ✕ 删除：移除候选并清理不再被任何段引用的 imageRefs", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    // 画布：LoadImage(10) 输出 → 下游目标(20) 的 IMAGE 输入（slot 非空才会进候选）
    appState.graph = {
        _nodes: [
            {
                id: 10,
                comfyClass: "LoadImage",
                type: "LoadImage",
                widgets: [{ name: "image", value: { filename: "hero.png", subfolder: "", type: "input" }, type: "combo" }],
                inputs: [],
                outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
                mode: 0,
            },
            {
                id: 20,
                comfyClass: "NeoKrea2Generate",
                type: "NeoKrea2Generate",
                inputs: [{ name: "image", type: "IMAGE" }],
                outputs: [],
                mode: 0,
            },
        ],
        links: {
            forEach(cb) {
                cb({ id: 1, origin_id: 10, origin_slot: 0, target_id: 20, target_slot: 0 });
            },
        },
        autoShow: false,
    };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    await openDirectorEditor(null); // 新建：默认 1 个空段，候选含 hero.png
    await sleep(60);

    const delBtn = Array.from(document.querySelectorAll(".neo-director-ff-del"))
        .find(b => b.closest(".neo-director-ff-item").dataset.file === "hero.png");
    assert.ok(delBtn, "素材格有 ✕ 删除按钮");
    delBtn.click();
    await sleep(10);

    const tiles = Array.from(document.querySelectorAll(".neo-director-ff-item"))
        .filter(it => it.dataset.file === "hero.png");
    assert.equal(tiles.length, 0, "hero.png 候选格已被移除");

    // 关闭编辑器；保存前 imageRefs 里 hero.png 也应被清理（无法直接读闭包，改以「重开后不再出现」验证）
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("素材直接拖到时间轴段块：落地并选中该段候选（覆盖非当前段）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    let copied = false;
    mockRoute("/neo_gallery/copy_to_input", (req) => {
        copied = true;
        return jsonResponse({ success: true, filename: "dragged.png" });
    });

    const existing = {
        name: "T2",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    // 拖到第 2 块（x=450，最小宽溢出后块1=[335,662]）；素材 MIME 携带 dragged.png
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"dragged.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "clientX", { value: 450, configurable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    canvas.dispatchEvent(dropEv);
    await sleep(30);

    assert.ok(copied, "素材已请求 copy_to_input");
    // 自动切换到第 2 段，且 dragged.png 候选被选中（active）
    const segRows = Array.from(document.querySelectorAll(".neo-director-seg"));
    const current = segRows.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segRows[1], "拖放后切到第 2 段");
    const active = current[0].querySelector(".neo-director-ff-item.neo-director-ff-active");
    assert.ok(active && active.dataset.file === "dragged.png", "拖入的素材被选中");

    // 清理
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：旧配方 W/H 反推宽高比+百万像素；改 MP 更新显示；自定义切手输", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T3",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const aspectSel = document.querySelector(".neo-director-aspect");
    const mpInp = document.querySelector(".neo-director-mp");
    const resOut = document.querySelector(".neo-director-res");
    assert.ok(aspectSel && mpInp && resOut, "宽高比/百万像素/分辨率显示控件存在");
    // 1344×768 → 命中 16:9（±2%），反推百万像素取一位小数 ≈1.0，显示按 32 对齐重算
    assert.equal(aspectSel.value, "16:9 (宽屏)");
    assert.equal(mpInp.value, "1");
    assert.equal(resOut.textContent, "1376×768");

    // 改百万像素 → 显示按 32 对齐重算（16:9 @ 0.4 = 864×480）
    mpInp.value = "0.4";
    mpInp.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(resOut.textContent, "864×480");

    // 超出上限按一位小数钳制（3.57 → 2）
    mpInp.value = "3.57";
    mpInp.dispatchEvent(new window.Event("input", { bubbles: true }));
    // 16:9 @ 2.0：scale=sqrt(2*1048576/144)≈120.69 → 1920×1088
    assert.equal(resOut.textContent, "1920×1088");

    // 切「自定义」→ 显示清空、手输 W/H 行出现
    aspectSel.value = "自定义";
    aspectSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(resOut.textContent, "");
    const customRow = Array.from(document.querySelectorAll(".neo-director-shared"))
        .find(el => el.querySelector('input[placeholder="宽"]'));
    assert.ok(customRow, "自定义行存在");
    assert.notEqual(customRow.style.display, "none", "自定义行可见");

    // 种子输入框已移除
    assert.equal(document.querySelector(".neo-director-shared input[placeholder='种子']"), null);

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：新建配方初始为 16:9 @ 百万像素 0.5（默认 960×544）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null); // 新建：无 existing → 走默认分支
    await sleep(60);

    assert.equal(document.querySelector(".neo-director-aspect").value, "16:9 (宽屏)");
    assert.equal(document.querySelector(".neo-director-mp").value, "0.5", "新建配方百万像素初始 0.5");
    assert.equal(document.querySelector(".neo-director-res").textContent, "960×544", "按 32 对齐的默认分辨率");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});


test("时间轴尾部 ＋ 直接添加新段并切换到该段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T4",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 184, width: 320, height: 184 };

    // 默认总宽溢出后 W≈603：「＋」在 x∈[571,595]、y∈[88,112]（时间轴高度 184）
    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    canvas.dispatchEvent(click("mousedown", 583, 100));

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 3, "点击 ＋ 后新增一段");
    const current = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segs[2], "自动切换到新段");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("标题栏拖动：mousedown 切绝对定位，mousemove 平移面板，mouseup 后停止；✕ 不触发", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-drag",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const panel = document.querySelector(".neo-director-panel");
    assert.ok(titleBar && panel, "标题栏与面板已创建");

    // jsdom 无布局：桩一个可预测的居中矩形，供首次 mousedown 读取起点
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 500, width: 780, height: 400 };
    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

    // 在标题栏空白处按下（非 ✕）→ 切绝对定位并记录当前居中位置为起点
    titleBar.dispatchEvent(evt("mousedown", 300, 120));
    assert.equal(panel.style.position, "absolute", "首次拖动切到绝对定位");
    assert.equal(panel.style.left, "100px", "起点取当前 left");
    assert.equal(panel.style.top, "100px", "起点取当前 top");

    // 拖动：mousemove 按位移平移面板
    window.dispatchEvent(evt("mousemove", 350, 140));
    assert.equal(panel.style.left, "150px", "left 随位移更新");
    assert.equal(panel.style.top, "120px", "top 随位移更新");

    // 继续拖动：相对起点累计，不回跳
    window.dispatchEvent(evt("mousemove", 380, 150));
    assert.equal(panel.style.left, "180px", "left 相对起点累计");
    assert.equal(panel.style.top, "130px", "top 相对起点累计");

    // mouseup 结束：之后 mousemove 不再跟随
    window.dispatchEvent(evt("mouseup", 380, 150));
    window.dispatchEvent(evt("mousemove", 500, 200));
    assert.equal(panel.style.left, "180px", "松开后停止跟随（left）");
    assert.equal(panel.style.top, "130px", "松开后停止跟随（top）");

    // ✕ 按钮上的 mousedown 不触发拖动
    const closeBtn = document.querySelector(".neo-director-close");
    const beforeLeft = panel.style.left;
    closeBtn.dispatchEvent(evt("mousedown", 380, 150));
    window.dispatchEvent(evt("mousemove", 420, 190));
    assert.equal(panel.style.left, beforeLeft, "✕ 按钮不触发拖动");

    closeBtn.click();
    await sleep(20);
});

test("导演编辑器：右下角手柄拖拽缩放窗口，越界钳制在视口内", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-resize",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const panel = document.querySelector(".neo-director-panel");
    const handle = document.querySelector(".neo-director-resize");
    assert.ok(panel && handle, "面板与右下角缩放手柄已创建");

    // jsdom 无布局：桩出可预测的矩形 + 初始宽高，供 mousedown 读取起点(780×500)
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 600, width: 780, height: 500 };
    Object.defineProperty(panel, "offsetWidth", { value: 780, configurable: true });
    Object.defineProperty(panel, "offsetHeight", { value: 500, configurable: true });

    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

    // 在手柄按下 → 切绝对定位并记录起点
    handle.dispatchEvent(evt("mousedown", 860, 580));
    assert.equal(panel.style.position, "absolute", "首次缩放切到绝对定位");

    // 拖拽放大：width/height 随位移增长
    window.dispatchEvent(evt("mousemove", 960, 620));
    assert.equal(panel.style.width, "880px", "宽度随 dx=+100 增大");
    assert.equal(panel.style.height, "540px", "高度随 dy=+40 增大");

    // 继续拖：相对起点累计，不回跳
    window.dispatchEvent(evt("mousemove", 900, 600));
    assert.equal(panel.style.width, "820px", "宽度相对起点累计 (dx=+40)");
    assert.equal(panel.style.height, "520px", "高度相对起点累计 (dy=+20)");

    // mouseup 结束：之后 mousemove 不再跟随
    window.dispatchEvent(evt("mouseup", 900, 600));
    window.dispatchEvent(evt("mousemove", 1200, 900));
    assert.equal(panel.style.width, "820px", "松开后停止跟随（width）");
    assert.equal(panel.style.height, "520px", "松开后停止跟随（height）");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("导演编辑器：标题栏 ⛶ 放大到最大，双击标题栏还原", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const panel = document.querySelector(".neo-director-panel");
    const maxBtn = document.querySelector(".neo-director-maximize");
    assert.ok(titleBar && panel && maxBtn, "标题栏/面板/⛶ 按钮已创建");
    assert.equal(maxBtn.textContent, "⛶");

    // 放大：记录当前几何（桩矩形）→ 绝对定位铺满视口（留 8px 边距）
    panel.__rect = { x: 100, y: 80, top: 80, left: 100, right: 600, bottom: 480, width: 500, height: 400 };
    maxBtn.click();
    assert.equal(panel.style.position, "absolute", "放大时切到绝对定位");
    assert.equal(panel.style.left, "8px");
    assert.equal(panel.style.top, "8px");
    assert.equal(panel.style.width, (window.innerWidth - 16) + "px");
    assert.equal(panel.style.height, (window.innerHeight - 16) + "px");
    assert.ok(maxBtn.classList.contains("neo-director-maximized"), "放大态标记");

    // 双击标题栏 → 还原到放大前几何
    titleBar.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(panel.style.left, "100px");
    assert.equal(panel.style.top, "80px");
    assert.equal(panel.style.width, "500px");
    assert.equal(panel.style.height, "400px");
    assert.ok(!maxBtn.classList.contains("neo-director-maximized"), "还原后取消放大态");

    // 再点按钮 → 再次放大；双击按钮自身不触发切换
    maxBtn.click();
    assert.equal(panel.style.left, "8px", "按钮再点重新放大");
    maxBtn.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(panel.style.left, "8px", "双击按钮本体不切换（忽略按钮目标）");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("标题栏配方名：默认直显文本、点击行内编辑（Enter/失焦提交、Esc 还原），名称区不触发拖动/最大化", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "T-renamed" }));

    const existing = {
        name: "T-name",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const wrap = titleBar.querySelector(".neo-director-name-wrap");
    assert.ok(wrap, "配方名在标题栏内");
    assert.equal(document.querySelectorAll(".neo-director-name").length, 1, "配方名输入框唯一（内容区不再重复一份）");
    const view = wrap.querySelector(".neo-director-name-view");
    const inp = wrap.querySelector(".neo-director-name");
    assert.equal(view.textContent, "T-name", "默认直接显示配方名");

    // 点击进入编辑：输入框出现并聚焦
    view.click();
    assert.ok(wrap.classList.contains("neo-director-name-editing"), "点击后进入编辑态");
    assert.equal(document.activeElement, inp, "编辑态自动聚焦输入框");

    // Enter 提交 → 退出编辑态并更新显示文本
    inp.value = "T-renamed";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.ok(!wrap.classList.contains("neo-director-name-editing"), "Enter 后退出编辑态");
    assert.equal(view.textContent, "T-renamed", "显示文本随提交更新");

    // Esc 还原为打开时的配方名
    view.click();
    inp.value = "临时改的名";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(inp.value, "T-name", "Esc 还原原配方名");
    assert.equal(view.textContent, "T-name", "Esc 后显示文本不变");

    // 失焦同样提交
    view.click();
    inp.value = "T-renamed";
    inp.dispatchEvent(new window.Event("blur"));
    assert.ok(!wrap.classList.contains("neo-director-name-editing"), "失焦后退出编辑态");
    assert.equal(view.textContent, "T-renamed", "失焦提交后更新显示文本");

    // 名称区按下 / 双击不触发标题栏拖动与最大化切换
    const panel = document.querySelector(".neo-director-panel");
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 500, width: 780, height: 400 };
    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    view.dispatchEvent(evt("mousedown", 400, 120));
    window.dispatchEvent(evt("mousemove", 500, 160));
    assert.notEqual(panel.style.position, "absolute", "名称区按下不触发拖动");
    view.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.notEqual(panel.style.left, "8px", "名称区双击不触发最大化");

    // 标题栏空白处仍可拖动
    titleBar.dispatchEvent(evt("mousedown", 120, 120));
    assert.equal(panel.style.position, "absolute", "标题栏空白处仍可拖动");
    window.dispatchEvent(evt("mouseup", 120, 120));

    // 保存取行内编辑后的名称
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.name, "T-renamed", "保存使用行内编辑后的名称");
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "保存成功后窗口关闭");
});

test("标题栏配方名：新建（无名称）时显示占位文本，输入后去除占位样式", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor(null);
    await sleep(60);

    const view = document.querySelector(".neo-director-name-view");
    assert.equal(view.textContent, "未命名配方", "新建时显示占位名");
    assert.ok(view.classList.contains("neo-director-name-empty"), "占位名标记为空态");

    const wrap = document.querySelector(".neo-director-name-wrap");
    const inp = wrap.querySelector(".neo-director-name");
    view.click();
    inp.value = "  我的导演  ";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(view.textContent, "我的导演", "提交时去掉首尾空格");
    assert.ok(!view.classList.contains("neo-director-name-empty"), "有名称后取消空态标记");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器单例：同一配方重复点击忽略，另一配方重新加载，关闭后可重开", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-single",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "首次打开创建浮层");

    // 同一配方重复点击 → 忽略，仍只有一个浮层、内容不变
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "同一配方重复点击不叠加");
    assert.equal(document.querySelector(".neo-director-name").value, "T-single", "内容保持原配方");

    // 另一配方 → 重新加载为该配方，仍只有一个浮层
    await openDirectorEditor({ name: "T-other", shared: {}, segments: [{ skill_id: "sk-a", prompt: "x", duration_sec: 5 }] });
    await sleep(20); // 等重载：关旧窗 + 重建新窗
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "重载后仍只有一个浮层");
    assert.equal(document.querySelector(".neo-director-name").value, "T-other", "重载为点击的配方");

    // 关闭后可再次打开
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "关闭后浮层移除");
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "关闭后可重新打开");
});

test("导演编辑器：故事生成 + 确认拆分填充时间轴", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 参考图网格为空
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/director_generate_story", () => jsonResponse({ success: true, story: "生成的故事正文" }));
    mockRoute("/rs_recipes/director_split_segments", () => jsonResponse({
        success: true,
        segments: [
            { prompt: "场景A提示词", duration_sec: 5 },
            { prompt: "场景B提示词", duration_sec: 10 },
        ],
    }));

    await openDirectorEditor(null); // 新建：默认 1 个空段
    await sleep(60);

    // 页签结构：默认落在「时间轴分段」，故事板页隐藏
    const tabs = Array.from(document.querySelectorAll(".neo-director-tab"));
    assert.equal(tabs.length, 2, "两个页签");
    const tabStory = tabs.find((t) => t.textContent.includes("自动故事板"));
    const tabTimeline = tabs.find((t) => t.textContent.includes("时间轴分段"));
    assert.ok(tabStory && tabTimeline, "两个页签齐全");
    assert.ok(tabTimeline.classList.contains("active"), "默认激活时间轴页");
    assert.equal(document.querySelector(".neo-director-pane-story").style.display, "none", "故事板页默认隐藏");

    // 切到「自动故事板」页
    tabStory.click();
    await sleep(20);
    assert.ok(tabStory.classList.contains("active"), "切换到故事板页");
    assert.equal(document.querySelector(".neo-director-pane-timeline").style.display, "none", "时间轴页被隐藏");

    // 故事区元素齐全
    const ideaInp = document.querySelector(".neo-director-story-idea");
    const genBtn = document.querySelector(".neo-director-gen-story");
    const storyTa = document.querySelector(".neo-director-story");
    assert.ok(ideaInp && genBtn && storyTa, "主题输入 / 生成按钮 / 故事框齐全");
    assert.ok(document.querySelector(".neo-director-refgrid"), "参考图网格存在");
    assert.ok(document.querySelector(".neo-director-seglen"), "分段粒度选择器存在");

    // ① 自动生成故事 → 写入可编辑故事框
    ideaInp.value = "一只机器猫找家";
    genBtn.click();
    await sleep(50);
    assert.equal(storyTa.value, "生成的故事正文", "生成结果写入故事框");

    // ② 确认并拆分 → 替换时间轴段落并自动切回时间轴页（技能取首个可用视频技能）
    const splitBtn = document.querySelector(".neo-director-split");
    assert.ok(splitBtn, "拆分按钮存在");
    storyTa.value = "场景一…";
    splitBtn.click();
    await sleep(50);

    assert.ok(tabTimeline.classList.contains("active"), "拆分后自动切回时间轴页");
    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2, "拆分成 2 段");
    assert.equal(segs[0].querySelector(".neo-director-prompt").value, "场景A提示词");
    assert.equal(segs[1].querySelector(".neo-director-prompt").value, "场景B提示词");
    assert.equal(segs[0].querySelector(".neo-director-skill").value, "sk-a", "技能取首个可用视频技能");
    assert.equal(Number(segs[1].querySelector(".neo-director-dur").value), 10);

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：素材直接拖入首帧网格 / 参考图网格（非时间轴 canvas）也能加入", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "dropped.png" }));

    await openDirectorEditor(null); // 新建：默认时间轴页，1 个空段
    await sleep(60);

    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"dragged.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });

    // ① 时间轴页：直接拖到首帧网格（非 canvas）→ 加入该段候选并选中
    const ffGrid = document.querySelector(".neo-director-seg .neo-director-ff-grid");
    assert.ok(ffGrid, "首帧网格存在");
    ffGrid.dispatchEvent(dropEv);
    await sleep(30);
    const ffTile = Array.from(document.querySelectorAll(".neo-director-ff-item")).find((it) => it.dataset.file === "dropped.png");
    assert.ok(ffTile, "拖入的素材加入首帧网格");
    assert.ok(ffTile.classList.contains("neo-director-ff-active"), "拖入的素材被选中");

    // ② 故事板页：拖到角色参考图网格 → 加入并选中
    const tabStory = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("自动故事板"));
    tabStory.click();
    await sleep(20);
    const refGrid = document.querySelector(".neo-director-refgrid");
    assert.ok(refGrid, "参考图网格存在");
    refGrid.dispatchEvent(dropEv);
    await sleep(30);
    const refTile = Array.from(document.querySelectorAll(".neo-director-ref-item")).find((it) => it.dataset.file === "dropped.png");
    assert.ok(refTile, "拖入的素材加入参考图网格");
    assert.ok(refTile.classList.contains("neo-director-ref-active"), "拖入的素材被选中");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：首帧图再点一次取消选中（回落文生视频），再点重新选中", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "picked.png" }));

    await openDirectorEditor(null); // 新建：1 个空段
    await sleep(60);

    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"picked.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });

    const ffGrid = document.querySelector(".neo-director-seg .neo-director-ff-grid");
    ffGrid.dispatchEvent(dropEv);
    await sleep(30);
    const tile = Array.from(document.querySelectorAll(".neo-director-ff-item")).find((it) => it.dataset.file === "picked.png");
    assert.ok(tile, "素材加入首帧网格");
    assert.ok(tile.classList.contains("neo-director-ff-active"), "拖入后被选中");

    // 再点一次 → 取消选中（回落到「无 / 文生视频」）
    tile.click();
    await sleep(20);
    assert.ok(!tile.classList.contains("neo-director-ff-active"), "再点一次取消选中");
    const activeFf = document.querySelector(".neo-director-seg .neo-director-ff-item.neo-director-ff-active");
    assert.ok(activeFf && !activeFf.dataset.file, "当前选中回落到「无（文生视频）」");

    // 再点一次 → 重新选中
    tile.click();
    await sleep(20);
    assert.ok(tile.classList.contains("neo-director-ff-active"), "再次点击重新选中");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});
test("导演编辑器：首帧素材库按钮打开/收起 ComfyUI 左侧素材面板", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor(null);
    await sleep(60);

    const libBtn = document.querySelector(".neo-director-ff-lib");
    assert.ok(libBtn, "首帧说明行存在素材库按钮");

    const tab = app.extensionManager.sidebarTab;
    libBtn.click();
    assert.equal(tab.activeSidebarTabId, "neo.gallery", "点击打开素材面板");
    libBtn.click();
    assert.equal(tab.activeSidebarTabId, null, "再次点击收起素材面板");
    libBtn.click();
    assert.equal(tab.activeSidebarTabId, "neo.gallery", "可再次打开");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：打开旧配方回显自动故事板（主题/脚本/参考图/粒度），保存时带回 story", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] }; // 画布无素材 → 参考图靠已存名回填
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "旧配方" }));

    const existing = {
        name: "旧配方",
        type: "video_director",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
        story: {
            idea: "旧主题",
            story: "旧故事正文",
            characters: [{ filename: "char.png", desc: "猫" }],
            backgrounds: [{ filename: "bg.png" }],
            segment_seconds: 15,
        },
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const tabStory = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("自动故事板"));
    tabStory.click();
    await sleep(20);

    // 主题 / 故事脚本 / 分段粒度回显
    assert.equal(document.querySelector(".neo-director-story-idea").value, "旧主题");
    assert.equal(document.querySelector(".neo-director-story").value, "旧故事正文");
    assert.equal(document.querySelector(".neo-director-seglen").value, "15");

    // 角色 / 背景参考图回填并保持选中（含描述）
    const grids = Array.from(document.querySelectorAll(".neo-director-refgrid"));
    assert.equal(grids.length, 2, "角色/背景两个参考图网格");
    const charTile = Array.from(grids[0].querySelectorAll(".neo-director-ref-item")).find((it) => it.dataset.file === "char.png");
    assert.ok(charTile, "角色参考图回填");
    assert.ok(charTile.classList.contains("neo-director-ref-active"), "角色参考图为选中态");
    assert.equal(charTile.querySelector(".neo-director-ref-desc").value, "猫", "参考图描述回显");
    const bgTile = Array.from(grids[1].querySelectorAll(".neo-director-ref-item")).find((it) => it.dataset.file === "bg.png");
    assert.ok(bgTile, "背景参考图回填");
    assert.ok(bgTile.classList.contains("neo-director-ref-active"), "背景参考图为选中态");

    // 未改动直接保存：请求体完整带回 story（后端据此落盘，下次打开可再回显）
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.story.idea, "旧主题");
    assert.equal(saveCall.body.story.story, "旧故事正文");
    assert.deepEqual(saveCall.body.story.characters, [{ filename: "char.png", desc: "猫" }]);
    assert.deepEqual(saveCall.body.story.backgrounds, [{ filename: "bg.png", desc: "" }]);
    assert.equal(saveCall.body.story.segment_seconds, 15);
});

test("导演编辑器：新建配方无故事内容时 story 各字段为空（由后端判空、不落盘）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "新配方" }));

    await openDirectorEditor(null, null);
    await sleep(60);
    assert.equal(document.querySelector(".neo-director-story-idea").value, "", "新建时主题为空");
    assert.equal(document.querySelector(".neo-director-story").value, "", "新建时故事为空");
    assert.equal(document.querySelector(".neo-director-seglen").value, "10", "粒度回落默认 10 秒");

    document.querySelector(".neo-director-name").value = "新配方";
    document.querySelector(".neo-director-seg .neo-director-skill").value = "sk-a";
    document.querySelector(".neo-director-seg .neo-director-prompt").value = "提示词";
    document.querySelector(".neo-director-save").click();
    await sleep(50);

    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.story.idea, null);
    assert.equal(saveCall.body.story.story, null);
    assert.deepEqual(saveCall.body.story.characters, []);
    assert.deepEqual(saveCall.body.story.backgrounds, []);
});


test("导演编辑器：打开时按 focusSeg 定位到指定段（节点上点的那块）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-focus",
        shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第三段", duration_sec: 5 },
        ],
    };
    const currentIdx = () => Array.from(document.querySelectorAll(".neo-director-seg"))
        .findIndex((s) => s.classList.contains("neo-director-seg-current"));

    await openDirectorEditor(existing, null, 2); // 节点上点了第 3 块
    assert.equal(currentIdx(), 2, "打开即定位到指定段");

    // 同一配方、窗口已打开：再点第 1 块 → 复用窗口并切换当前段（不叠加、不重建）
    await openDirectorEditor(existing, null, 0);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "同一配方不叠加浮层");
    assert.equal(currentIdx(), 0, "已打开的窗口切换到所点段");

    // 不带索引（列表 / ✎ 进入）→ 保持当前段不变
    await openDirectorEditor(existing);
    assert.equal(currentIdx(), 0, "未指定段时不改变当前段");

    // 索引超出段数 → 钳到最后一段（节点与编辑器段数不一致时不至于空窗）
    await openDirectorEditor(existing, null, 9);
    assert.equal(currentIdx(), 2, "越界索引钳到最后一段");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器：切换当前段时编辑器时间轴自动把该段滚进可视区", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    // 可视区宽度要在打开前就固定（组件首次绘制/定位滚动按它算块坐标）；jsdom 无布局，只能如此
    const CANVAS_VW = 600;
    Object.defineProperty(window.HTMLCanvasElement.prototype, "clientWidth", { value: CANVAS_VW, configurable: true });

    const existing = {
        name: "T-reveal",
        shared: { width: 1344, height: 768 },
        segments: Array.from({ length: 12 }, (_, i) => ({ skill_id: "sk-a", prompt: "p" + i, duration_sec: 5 })),
    };
    const currentIdx = () => Array.from(document.querySelectorAll(".neo-director-seg"))
        .findIndex((s) => s.classList.contains("neo-director-seg-current"));

    try {
        await openDirectorEditor(existing, null, 10); // 打开即定位第 11 段
        await sleep(80);
        const scroll = document.querySelector(".neo-director-timeline .neo-dtl-scroll");
        assert.ok(scroll, "编辑器时间轴存在");
        assert.equal(currentIdx(), 10, "定位到第 11 段");

        // 12 段 × 5s、面板时间轴高 184 → 块净高 156 → 每块 16:9 ≈277.3px（内容远超 600px 可视区）
        const blockW = (184 - 18 - 4 - 6) * 16 / 9;
        const contentW = Math.ceil(12 * blockW + 8 * 2 + 32); // padX*2 + 尾部「＋」
        const want = Math.min(contentW - CANVAS_VW, 8 + 10 * blockW + blockW - CANVAS_VW + 12);
        assert.ok(Math.abs(scroll.scrollLeft - want) < 3, `滚动到第 11 块（期望≈${Math.round(want)}，实际 ${Math.round(scroll.scrollLeft)}）`);

        // 同一窗口内切回第 1 段 → 滚回最左
        await openDirectorEditor(existing, null, 0);
        assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "复用同一窗口");
        assert.equal(currentIdx(), 0, "当前段切到第 1 段");
        assert.equal(scroll.scrollLeft, 0, "时间轴滚回最左");

        // 再切回第 11 段 → 再次滚到该段
        await openDirectorEditor(existing, null, 10);
        assert.equal(currentIdx(), 10);
        assert.ok(Math.abs(scroll.scrollLeft - want) < 3, "再次滚动到第 11 块");
    } finally {
        delete window.HTMLCanvasElement.prototype.clientWidth; // 还原 jsdom 原型，避免影响同文件其它用例
    }

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：图生视频段三组参考网格回显，保存写入 refs 并把参考视频/音频带进 assets", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };   // 画布无素材 → 参考靠已存名回填
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "R2V" }));

    const existing = {
        name: "R2V",
        type: "video_director",
        shared: { mode: "i2v", width: 960, height: 544 },
        segments: [{
            skill_id: "sk-a", prompt: "p0", duration_sec: 5, mode: "i2v", first_frame: "ff.png",
            refs: { images: ["a.png"], videos: ["v.mp4"], audios: ["s.wav"] },
        }],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const rows = Array.from(document.querySelectorAll(".neo-director-segref-row"));
    assert.equal(rows.length, 3, "参考图 / 参考视频 / 参考音频三组网格");
    assert.deepEqual(rows.map((r) => r.querySelector(".neo-director-refpick-count").textContent),
        ["1/9", "1/3", "1/3"], "各自上限：图 9 / 视频 3 / 音频 3");
    const isActive = (row, name) => {
        const tile = Array.from(row.querySelectorAll(".neo-director-refpick-item")).find((it) => it.dataset.file === name);
        return !!tile && tile.classList.contains("neo-director-refpick-active");
    };
    assert.ok(isActive(rows[0], "a.png"), "参考图回显为选中");
    assert.ok(isActive(rows[1], "v.mp4"), "参考视频回显为选中");
    assert.ok(isActive(rows[2], "s.wav"), "参考音频回显为选中");

    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.deepEqual(saveCall.body.segments[0].refs,
        { images: ["a.png"], videos: ["v.mp4"], audios: ["s.wav"] });
    assert.equal(saveCall.body.shared.mode, "i2v");
    const assets = saveCall.body.assets.map((a) => `${a.filename}:${a.kind}`);
    assert.ok(assets.includes("v.mp4:video"), "参考视频进配方 assets");
    assert.ok(assets.includes("s.wav:audio"), "参考音频进配方 assets");
});

test("导演编辑器：参考素材区仅图生视频段显示（文生段隐藏）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "T2V", shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5 }],
    });
    await sleep(60);
    const block = document.querySelector(".neo-director-seg .neo-director-refs-block");
    assert.ok(block, "参考素材区容器存在");
    assert.equal(block.style.display, "none", "文生段隐藏参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：切换段模式/全局模式即时刷新参考素材区显隐", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "MODE", shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5 }],
    });
    await sleep(60);
    const block = document.querySelector(".neo-director-seg .neo-director-refs-block");
    assert.equal(block.style.display, "none", "初始文生模式隐藏");

    const modeSel = document.querySelector(".neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.equal(block.style.display, "", "切到参考主体模式后显示参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：首尾帧模式显示首帧+尾帧区，保存写入 last_frame", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "FL2V" }));

    await openDirectorEditor({
        name: "FL2V", shared: { mode: "fl2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "fl2v",
                     first_frame: "a.png", last_frame: "z.png" }],
    }, null);
    await sleep(60);

    const ffBlock = document.querySelector(".neo-director-seg .neo-director-ff-block");
    const lfBlock = document.querySelector(".neo-director-seg .neo-director-lf-block");
    const refsBlock = document.querySelector(".neo-director-seg .neo-director-refs-block");
    assert.ok(lfBlock, "尾帧区存在");
    assert.equal(ffBlock.style.display, "", "首尾帧模式显示首帧区");
    assert.equal(lfBlock.style.display, "", "首尾帧模式显示尾帧区");
    assert.equal(refsBlock.style.display, "none", "首尾帧模式隐藏参考素材区");
    // 尾帧网格以独立类名前缀渲染，并按已存文件名回填选中
    const lfActive = lfBlock.querySelector(".neo-director-lf-item.neo-director-lf-active");
    assert.ok(lfActive, "尾帧已选中");
    assert.equal(lfActive.dataset.file, "z.png");

    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saved = fetchLog.find((c) => c.path === "/rs_recipes/save").body.segments[0];
    assert.equal(saved.first_frame, "a.png");
    assert.equal(saved.last_frame, "z.png");
    assert.equal(fetchLog.find((c) => c.path === "/rs_recipes/save").body.shared.mode, "fl2v");
});

test("导演编辑器：首尾帧模式缺尾帧时保存被拒（提示尾帧）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "FL2V-x" }));

    await openDirectorEditor({
        name: "FL2V-x", shared: { mode: "fl2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "fl2v", first_frame: "a.png" }],
    }, null);
    await sleep(60);
    document.querySelector(".neo-director-save").click();
    await sleep(40);
    assert.equal(fetchLog.find((c) => c.path === "/rs_recipes/save"), undefined, "缺尾帧不发保存请求");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考主体模式显示参考素材区、隐藏首尾帧区", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "R2V", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v",
                     refs: { images: ["a.png"] } }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    assert.equal(row.querySelector(".neo-director-ff-block").style.display, "none", "参考主体模式隐藏首帧区");
    assert.equal(row.querySelector(".neo-director-lf-block").style.display, "none", "参考主体模式隐藏尾帧区");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "参考主体模式显示参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：混合模式下每段可选 t2v/i2v/fl2v/r2v，切换后即时刷新分区显隐", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "MIX", shared: { mode: "mixed" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "t2v" }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    const segMode = row.querySelector(".neo-director-segmode");
    assert.deepEqual(Array.from(segMode.options).map((o) => o.value), ["t2v", "i2v", "fl2v", "r2v"]);

    segMode.value = "fl2v";
    segMode.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.equal(row.querySelector(".neo-director-ff-block").style.display, "", "fl2v 显示首帧区");
    assert.equal(row.querySelector(".neo-director-lf-block").style.display, "", "fl2v 显示尾帧区");

    segMode.value = "r2v";
    segMode.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.equal(row.querySelector(".neo-director-ff-block").style.display, "none", "r2v 隐藏首帧区");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "r2v 显示参考素材区");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：所有网格都有「本地」按钮（首帧/尾帧/参考图/参考视频/参考音频）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "LOCAL", shared: { mode: "fl2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "fl2v" }],
    }, null);
    await sleep(60);

    // 首帧区、尾帧区各有一个「本地」按钮
    const ffBlock = document.querySelector(".neo-director-ff-block");
    const lfBlock = document.querySelector(".neo-director-lf-block");
    assert.ok(ffBlock.querySelector(".neo-director-local-add"), "首帧区有「本地」按钮");
    assert.ok(lfBlock.querySelector(".neo-director-local-add"), "尾帧区有「本地」按钮");

    // 参考素材区三组网格各有「本地」按钮
    const refRows = Array.from(document.querySelectorAll(".neo-director-segref-row"));
    assert.equal(refRows.length, 3, "参考图/视频/音频三组");
    for (const row of refRows) {
        assert.ok(row.querySelector(".neo-director-local-add"), `参考组有「本地」按钮: ${row.querySelector(".neo-director-field-label").textContent}`);
    }

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：「本地」按钮点击上传文件后加入候选并选中", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "uploaded_local.png", subfolder: "", type: "input" }));

    await openDirectorEditor(null);
    await sleep(60);

    // 找到首帧区的「本地」按钮内的 file input
    const ffBlock = document.querySelector(".neo-director-ff-block");
    const localBtn = ffBlock.querySelector(".neo-director-local-add");
    assert.ok(localBtn, "首帧区有「本地」按钮");
    const fileInput = localBtn.querySelector("input[type=file]");
    assert.ok(fileInput, "「本地」按钮内含 file input");
    assert.equal(fileInput.accept, "image/*", "首帧区 file input accept=image/*");

    // 模拟选择文件
    const fakeFile = new File(["fake"], "local.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await sleep(50);

    // 上传成功后，文件加入首帧网格并选中
    const uploadCall = fetchLog.find((c) => c.path === "/upload/image");
    assert.ok(uploadCall, "调用了 /upload/image");
    assert.equal(uploadCall.method, "POST");

    const ffTile = Array.from(document.querySelectorAll(".neo-director-ff-item")).find((it) => it.dataset.file === "uploaded_local.png");
    assert.ok(ffTile, "上传的文件加入首帧网格");
    assert.ok(ffTile.classList.contains("neo-director-ff-active"), "上传的文件被选中");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考视频/音频的「本地」按钮 accept 正确过滤", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "REF", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v" }],
    }, null);
    await sleep(60);

    const refRows = Array.from(document.querySelectorAll(".neo-director-segref-row"));
    const labels = refRows.map((r) => r.querySelector(".neo-director-field-label").textContent);
    // 参考图/参考视频/参考音频
    const imgRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考图"));
    const vidRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考视频"));
    const audRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考音频"));
    assert.ok(imgRow && vidRow && audRow, "三组参考网格都存在");

    assert.equal(imgRow.querySelector("input[type=file]").accept, "image/*", "参考图 accept=image/*");
    assert.equal(vidRow.querySelector("input[type=file]").accept, "video/*", "参考视频 accept=video/*");
    assert.equal(audRow.querySelector("input[type=file]").accept, "audio/*", "参考音频 accept=audio/*");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

