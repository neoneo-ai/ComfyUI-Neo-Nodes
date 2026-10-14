// Neo Gallery 瀑布流布局：最短列装箱（web/gallery-masonry.js packColumns）。
// 目录卡/素材卡高度随图片朝向变化，CSS multi-column 会整列留白，改由这里逐个放进最矮列。
import test from "node:test";
import assert from "node:assert/strict";

let masonry;
async function loadMasonry() {
    if (!masonry) masonry = await import("../../web/gallery-masonry.js");
    return masonry;
}

const GAP = 12;

test("packColumns：按顺序填满每一列，再回填最矮的一列", async () => {
    const { packColumns } = await loadMasonry();
    assert.deepEqual(packColumns([400, 400, 400, 100], 3).placement, [[0, 0], [1, 0], [2, 0], [0, 412]]);
});

test("packColumns：高矮不一时不等最矮列排空，整列不会只放一张", async () => {
    const { packColumns } = await loadMasonry();
    // 第一张特别高，后面三张矮卡先铺满另外两列
    const { placement, height } = packColumns([900, 200, 200, 200], 3);
    assert.deepEqual(placement, [[0, 0], [1, 0], [2, 0], [1, 212]]);
    assert.equal(height, 900);
});

test("packColumns：同高时优先靠左，列内不重叠", async () => {
    const { packColumns } = await loadMasonry();
    assert.deepEqual(packColumns([100, 100, 100, 100, 100, 100], 3).placement,
        [[0, 0], [1, 0], [2, 0], [0, 112], [1, 112], [2, 112]]);
});

test("packColumns：单列时顺次堆叠，容器高度等于内容总高", async () => {
    const { packColumns } = await loadMasonry();
    const { placement, height } = packColumns([300, 150, 150], 1);
    assert.deepEqual(placement, [[0, 0], [0, 312], [0, 474]]);
    assert.equal(height, 300 + GAP + 150 + GAP + 150);
});

test("packColumns：空列表高度为 0（不产生 -Infinity）", async () => {
    const { packColumns } = await loadMasonry();
    assert.deepEqual(packColumns([], 3), { placement: [], height: 0 });
});
