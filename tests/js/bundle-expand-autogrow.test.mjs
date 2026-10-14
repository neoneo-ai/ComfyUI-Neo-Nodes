// L1：NeoBundleExpand 前端 autogrow 输出槽的目标数计算（image_N 连线驱动增长）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

// 插件模块必须在 setup.mjs（安装 app.js shim hooks）求值后动态 import，否则 app.js 解析不到 mock。
const { computeAutogrowTarget } = await import("../../web/bundle-expand.js");

function outputs(connectedImageIndices) {
    // 槽 0 = prompt，槽 1..9 = image_1..9；connectedImageIndices 为已连接的图片槽索引集合。
    return Array.from({ length: 10 }, (_, i) => ({
        name: i === 0 ? "prompt" : `image_${i}`,
        links: connectedImageIndices.includes(i) ? [1] : [],
    }));
}

test("autogrow：默认显示 prompt + image_1", () => {
    resetEnv();
    assert.equal(computeAutogrowTarget(outputs([])), 2);
});

test("autogrow：连接 image_1 后露出 image_2", () => {
    resetEnv();
    assert.equal(computeAutogrowTarget(outputs([1])), 3);
});

test("autogrow：连接中间槽后保留到最高连接槽的下一个", () => {
    resetEnv();
    assert.equal(computeAutogrowTarget(outputs([1, 4])), 6);
});

test("autogrow：image_9 已连接时封顶在 10 个输出", () => {
    resetEnv();
    assert.equal(computeAutogrowTarget(outputs([9])), 10);
    assert.equal(computeAutogrowTarget(outputs([8, 9])), 10);
});
