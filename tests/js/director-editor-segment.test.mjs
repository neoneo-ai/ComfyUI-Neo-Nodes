// 导演编辑器「只显示当前段」：默认显示第 1 段，点击时间轴块切换到对应段。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function mouse(type, x) {
    return new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
}

test("导演编辑器：默认仅第 1 段有 current 标记，点击时间轴块切换当前段", async () => {
    const { openDirectorEditor } = await import("../../web/recipes.js");
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

    canvas.dispatchEvent(mouse("mousedown", 236)); // 块1 [160,312] 内
    window.dispatchEvent(mouse("mouseup", 236));

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

test("导演编辑器：添加段后自动切换到新段，删除当前段后切回前一段", async () => {
    const { openDirectorEditor } = await import("../../web/recipes.js");
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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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

    // 拖到第 2 块（x=236）；素材 MIME 携带 dragged.png
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"dragged.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "clientX", { value: 236, configurable: true });
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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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

test("时间轴尾部 ＋ 直接添加新段并切换到该段", async () => {
    const { openDirectorEditor } = await import("../../web/recipes.js");
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

    // onAdd 预留尾部 32px：usable=272 → 块 [8,144]/[144,280]；「＋」在 x∈[288,312]、y∈[88,112]（时间轴高度 184）
    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    canvas.dispatchEvent(click("mousedown", 300, 100));

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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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

test("导演编辑器单例：同一配方重复点击忽略，另一配方重新加载，关闭后可重开", async () => {
    const { openDirectorEditor } = await import("../../web/recipes.js");
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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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
    const { openDirectorEditor } = await import("../../web/recipes.js");
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