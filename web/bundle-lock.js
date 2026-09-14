/**
 * bundle-lock.js
 * NeoKrea2Generate / NeoH3VideoGenerate：
 * 1) bundle 是 NeoPromptAgent 产出的引用 id，不由用户手输——后端以 forceInput 声明为纯连线槽，
 *    与 image 一致：节点体内不显示文本框，只留左侧 slot；未连接时后端收到 ""。
 * 2) bundle 输入一旦链接，即禁用 prompt / skill_id 两个控件，表示"以 bundle 为准"（后端同优先级）。断开后恢复；
 *    节点创建/工作流加载时按当前连线状态设置初始态。
 */

const BUNDLE_LOCK_NODES = ["NeoKrea2Generate", "NeoH3VideoGenerate"];
const LOCKED_WIDGETS = ["prompt", "skill_id"];

function bundleLinked(node) {
    const input = node.inputs?.find((i) => i.name === "bundle");
    return !!(input && input.link != null);
}

function applyBundleLock(node) {
    const locked = bundleLinked(node);
    for (const name of LOCKED_WIDGETS) {
        const w = node.widgets?.find((w) => w.name === name);
        if (w) w.disabled = locked;
    }
    if (node.graph) node.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "NeoNodes.BundleLock",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!BUNDLE_LOCK_NODES.includes(nodeData.name)) return;

        // 连线变化（bundle 输入 link 增删）时切换禁用态
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (side, slot, connect) {
            origOnConnectionsChange?.apply(this, arguments);
            applyBundleLock(this);
        };

        // 节点创建（含工作流加载）：按当前连线状态设置禁用初始态
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            applyBundleLock(this);
        };
    },
});
