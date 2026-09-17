// NeoKrea2Generate 节点：width/height 默认跟随所选 skill 预设（base_resolution + default_ratio）。
// 参考 NeoH3VideoDirector（web/director-node.js）的 applyDimDefaults：仅当仍为默认 -1 时填充，
// 切换 skill_id 下拉强制重填；工作流已存的实值优先（首次载入不覆盖）。
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";

app.registerExtension({
    name: "NeoKrea2Generate.DimDefaults",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoKrea2Generate") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;
            const skillWidget = node.widgets?.find((w) => w.name === "skill_id");

            // 用 skill 预设尺寸填 width/height widget；force=false 时仅当仍为默认 -1（保留工作流已存值）。
            const applyDimDefaults = (d, force) => {
                if (!d) return;
                for (const [nm, val] of [["width", d.width], ["height", d.height]]) {
                    const w = node.widgets?.find((x) => x.name === nm);
                    if (!w || !Number.isFinite(val)) continue;
                    if (!force && Number(w.value) !== -1) continue;
                    w.value = val;
                    w.callback?.(val);
                }
            };

            // dimsSeq：并发令牌。工作流还原会先后触发两次（创建默认值 + configure 还原值），旧响应用 seq 判废
            let dimsSeq = 0;
            const loadDims = async (force = false) => {
                const seq = ++dimsSeq;
                const name = skillWidget ? String(skillWidget.value || "") : "";
                if (!name) return;
                try {
                    const resp = await api.fetchApi(`/neo_image_gen/skill_dims?skill_id=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success && seq === dimsSeq) applyDimDefaults(data, force);
                    }
                } catch (e) {
                    console.error("[Neo Nodes] krea2 skill dims fetch failed", e);
                }
            };
            loadDims();

            // 切换 skill_id 下拉时强制重填预设尺寸（本版本 combo widget 用 callback 触发变化，onchange 不存在）
            if (skillWidget) {
                const oc = skillWidget.callback;
                skillWidget.callback = function() { oc?.apply(this, arguments); loadDims(true); };
            }
            return result;
        };
    },
});
