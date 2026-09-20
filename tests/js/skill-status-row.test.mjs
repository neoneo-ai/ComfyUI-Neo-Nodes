// 节点级 Skill 有效性状态条：选完 skill 后台检测缺模型/缺节点，节点底部聚合告警可一键进详情修复。
// 覆盖 createSkillStatusRow（渲染/聚合去重/缓存/事件重检/destroy）与 validateSkillForNode（无工作流、校验失败不误报）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, window, sleep, click } from "./setup.mjs";

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    const { invalidateSkillValidation } = await import("../../web/skill.js");
    invalidateSkillValidation(); // 名称反查/校验缓存是模块级，清掉避免跨用例串味
});

const OBJ_INFO = { UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } } };
// 缺 1 个模型 + 1 个未安装节点
const WF_BAD = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "no_such.safetensors" } },
    "2": { class_type: "GhostNode", inputs: {} },
};
const WF_OK = { "1": { class_type: "UNETLoader", inputs: { unet_name: "real.safetensors" } } };

// 节点 skill 下拉的 value 是技能「名称」（id 是目录名）：状态条必须按名称反查真实 skill 才能取到模板。
// 注意：skill.js 的校验缓存是模块级、跨用例共享（TTL 60s），所以每个用例用独立的 skill id/名称，避免命中别的用例的缓存。
const SK = (id, name, video = false) => ({ id, name, gen_image: !video, gen_video: video, has_workflow: true });

/** 装齐状态条会打到的接口；skills = 技能列表，workflows = 真实 skill（id）→ 模板，未列出的视为没有 workflow.json */
function installRoutes({ skills = [], workflows = {}, objectInfo = OBJ_INFO } = {}) {
    const state = { workflows, objectInfo, workflowCalls: 0, objectInfoCalls: 0, requested: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
    mockRoute("/neo_image_gen/skill_workflow", (b, call) => {
        const id = String(call.query?.get("skill_id") || "");
        state.workflowCalls++;
        state.requested.push(id);
        return state.workflows[id] ? jsonResponse({ workflow: state.workflows[id] }) : jsonResponse({ error: "missing" }, 404);
    });
    mockRoute("/object_info", () => { state.objectInfoCalls++; return jsonResponse(state.objectInfo); });
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(call.method === "GET" ? {} : { success: true }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["real.safetensors"], text_encoders: [], vae: [], loras: [] }));
    return state;
}

/** getSkills 传数组或取值函数（切换选择用函数），opts 可传 isVideo；挂到 body 上便于点击 */
function mountRow(createSkillStatusRow, getSkills, opts = {}) {
    const row = createSkillStatusRow({ getSkills: typeof getSkills === "function" ? getSkills : () => getSkills, ...opts });
    document.body.appendChild(row.el);
    return row;
}


test("状态条：缺模型/缺节点时显示聚合告警，点按钮打开反查出的真实 skill 详情", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t1_img", "缺模型的图技能")], workflows: { t1_img: WF_BAD } });
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b.id;
        return jsonResponse({
            id: b.id, name: "Bad Skill", content: "body", files: [{ name: "skill.md", size: 4 }],
            gen_image: false, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "", config_overridden: false,
        });
    });
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));

    const row = mountRow(createSkillStatusRow, ["缺模型的图技能"]);
    assert.equal(row.el.style.display, "none", "检测前状态条不占高");

    await row.refresh();
    assert.notEqual(row.el.style.display, "none", "有缺失应显示告警条");
    const label = row.el.querySelector(".neo-skill-status-label").textContent;
    assert.ok(label.includes("1 个模型缺失") && label.includes("1 个节点未安装"), `告警文案应含两类缺失：${label}`);
    assert.deepEqual(state.requested, ["t1_img"], "应按反查出的真实 skill 取模板（下拉给的是名称）");

    click(row.el.querySelector(".neo-skill-status-open"));
    await sleep(60);
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    assert.ok(overlay && overlay.style.display === "flex", "点「查看详情/修复」应打开 skill 详情弹窗");
    assert.equal(loadedId, "t1_img", "应打开首个有缺失的真实 skill");
    row.destroy();
});

test("状态条：手动切换所选技能后按新技能重检，切回再报（不是只初始化检查一次）", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t10_bad", "坏技能"), SK("t10_ok", "好技能")], workflows: { t10_bad: WF_BAD, t10_ok: WF_OK } });
    let current = "坏技能";
    const row = mountRow(createSkillStatusRow, () => [current]);

    await row.refresh();
    assert.notEqual(row.el.style.display, "none", "坏技能应显示告警");

    current = "好技能"; // 手动切换下拉 → 节点回调触发 refresh
    await row.refresh();
    assert.deepEqual(state.requested, ["t10_bad", "t10_ok"], "切换后应按新选中的 skill 重新检测");
    assert.equal(row.el.style.display, "none", "切到无缺失的技能后旧告警应收起");

    current = "坏技能"; // 切回去仍要再次报出
    await row.refresh();
    assert.notEqual(row.el.style.display, "none", "切回坏技能应重新显示告警");
    row.destroy();
});

test("状态条：视频节点（isVideo）同样按技能名称反查后校验", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t2_vid", "H3 图生视频 (Singularity)", true)], workflows: { t2_vid: WF_BAD } });
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["real.safetensors"], text_encoders: [], vae: [], loras: [] }));

    const row = mountRow(createSkillStatusRow, ["H3 图生视频 (Singularity)"], { isVideo: true });
    await row.refresh();
    assert.notEqual(row.el.style.display, "none", "视频技能缺模型应显示告警");
    assert.deepEqual(state.requested, ["t2_vid"], "名称应先反查成视频 skill 的目录名");
    row.destroy();
});

test("状态条：模型/节点齐备时隐藏且不留按钮", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t3_img", "完好的图技能")], workflows: { t3_img: WF_OK } });
    const row = mountRow(createSkillStatusRow, ["完好的图技能"]);

    await row.refresh();
    assert.equal(state.workflowCalls, 1);
    assert.equal(row.el.style.display, "none", "无缺失应隐藏");
    assert.equal(row.el.querySelector(".neo-skill-status-open"), null, "隐藏时不残留按钮");
    row.destroy();
});

test("状态条：技能无 workflow.json 时隐藏且不触发模型/节点校验", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t4_nowf", "无工作流的图技能")] }); // workflows 未列 → 404
    const row = mountRow(createSkillStatusRow, ["无工作流的图技能"]);

    await row.refresh();
    assert.equal(row.el.style.display, "none");
    assert.deepEqual(state.requested, ["t4_nowf"], "名称应先反查成目录名再取模板");
    assert.equal(state.workflowCalls, 1);
    assert.equal(state.objectInfoCalls, 0, "无 workflow.json 不应拉 /object_info");
    row.destroy();
});

test("状态条：/object_info 不可用时按「跳过检查」处理，不误报缺失", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    installRoutes({ skills: [SK("t5_img", "缺模型的图技能")], workflows: { t5_img: WF_BAD } });
    clearRoutes(); // 除下面重挂的接口外全不可用（501）→ checkWorkflow 内部按跳过处理
    mockRoute("/rs_prompts/skills", () => jsonResponse([SK("t5_img", "缺模型的图技能")]));
    mockRoute("/neo_image_gen/skill_workflow", (b, call) => {
        const id = String(call.query?.get("skill_id") || "");
        return id === "t5_img" ? jsonResponse({ workflow: WF_BAD }) : jsonResponse({ error: "missing" }, 404);
    });

    const row = mountRow(createSkillStatusRow, ["缺模型的图技能"]);
    await row.refresh();
    assert.equal(row.el.style.display, "none", "校验接口不可用不应把缺失误报成告警");
    row.destroy();
});

test("状态条：多个 skill 的缺失项聚合去重（重复名称只检测一次）", async () => {
    const { createSkillStatusRow } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t6_a", "聚合A"), SK("t6_b", "聚合B")], workflows: { t6_a: WF_BAD, t6_b: WF_BAD } });
    const row = mountRow(createSkillStatusRow, ["聚合A", "聚合B", "聚合A"]);

    await row.refresh();
    assert.equal(state.workflowCalls, 2, "重复名称去重后只检测两个技能");
    const label = row.el.querySelector(".neo-skill-status-label").textContent;
    assert.ok(label.includes("1 个模型缺失") && label.includes("1 个节点未安装"), `同名缺失应合并计数：${label}`);
    row.destroy();
});

test("状态条：检测结果命中缓存，SKILL_CHANGED_EVENT 强制重检后告警消失", async () => {
    const { createSkillStatusRow, SKILL_CHANGED_EVENT } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t7_img", "缓存技能")], workflows: { t7_img: WF_BAD } });
    const row = mountRow(createSkillStatusRow, ["缓存技能"]);

    await row.refresh();
    assert.equal(state.workflowCalls, 1);
    await row.refresh();
    assert.equal(state.workflowCalls, 1, "未过期的重复 refresh 应命中缓存");
    assert.notEqual(row.el.style.display, "none");

    // 用户在详情弹窗补齐模型/装好节点 → 保存派发事件 → 状态条绕过缓存重检并收起告警
    state.workflows.t7_img = WF_OK;
    window.dispatchEvent(new window.CustomEvent(SKILL_CHANGED_EVENT, { detail: { skillId: "t7_img" } }));
    await sleep(80);

    assert.equal(state.workflowCalls, 2, "事件应绕过缓存重新检测");
    assert.equal(row.el.style.display, "none", "修复后告警应消失");
    row.destroy();
});

test("状态条：清空选择即隐藏且不再检测；destroy 后事件不再驱动重检", async () => {
    const { createSkillStatusRow, SKILL_CHANGED_EVENT } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t8_img", "切换技能")], workflows: { t8_img: WF_BAD } });
    let skills = ["切换技能"];
    const row = mountRow(createSkillStatusRow, () => skills);

    await row.refresh();
    assert.notEqual(row.el.style.display, "none", "有缺失应显示");

    skills = []; // 清空 skill 选择 → 收起告警
    const callsBefore = state.workflowCalls;
    await row.refresh();
    assert.equal(row.el.style.display, "none", "无选择时应隐藏");
    assert.equal(state.workflowCalls, callsBefore, "无选择不应发检测请求");

    // destroy 注销 SKILL_CHANGED_EVENT → 事件不再触发重检
    skills = ["切换技能"];
    row.destroy();
    window.dispatchEvent(new window.CustomEvent(SKILL_CHANGED_EVENT, { detail: { skillId: "t8_img" } }));
    await sleep(60);
    assert.equal(state.workflowCalls, callsBefore, "destroy 后不应再检测");
});

test("validateSkillForNode：名称反查真实 skill（兼容旧工作流的 id），空选择不发请求", async () => {
    const { validateSkillForNode } = await import("../../web/skill.js");
    const state = installRoutes({ skills: [SK("t9_img", "校验技能")], workflows: { t9_img: WF_BAD } });

    const bad = await validateSkillForNode("校验技能", false); // 下拉存的是名称
    assert.equal(bad.ok, false);
    assert.equal(bad.id, "t9_img", "应返回反查出的真实 skill");
    assert.equal(bad.noWorkflow, false);
    assert.deepEqual(bad.missingModels, ["no_such.safetensors"]);
    assert.deepEqual(bad.missingNodes, ["GhostNode"]);

    const byId = await validateSkillForNode("t9_img", false); // 旧工作流存的是目录名/id
    assert.equal(byId.id, "t9_img");
    assert.equal(state.workflowCalls, 1, "同一真实 skill 反查后应命中缓存");

    const empty = await validateSkillForNode("", false);
    assert.equal(empty.ok, true);
    assert.equal(state.workflowCalls, 1, "空选择不请求工作流");
});
