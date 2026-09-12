// DirectorTimeline 交互回归：点击选中、拖拽重排（光标插入语义 + 源块排除）、readOnly。
// canvas 无后端：ctx 用富桩替代，clientWidth/getBoundingClientRect 手动给可预测值。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, sleep } from "./setup.mjs";

// setup.mjs 先装好钩子与桩后再导入组件模块
const { DirectorTimeline } = await import("../../web/director-timeline.js");

function richCtx() {
    return new Proxy(
        {
            font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "top",
            measureText: () => ({ width: 0 }),
            canvas: null,
        },
        {
            get(t, k) {
                if (k in t) return t[k];
                return () => {}; // 其余绘制方法一律 no-op
            },
            set(t, k, v) {
                t[k] = v;
                return true;
            },
        }
    );
}

function makeTimeline(segs, opts = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const calls = { select: [], reorder: [], resize: [] };
    const extResize = opts.onResize;
    const tl = new DirectorTimeline(container, Object.assign(opts, {
        getSegments: () => segs,
        onSelect: (i) => calls.select.push(i),
        onReorder: (o) => calls.reorder.push(o),
        onResize: (i, d) => {
            calls.resize.push([i, d]);
            if (extResize) extResize(i, d);
        },
    }));
    // 覆盖极简 ctx 桩：组件只读 canvas.clientWidth，绘制全走 no-op
    tl.ctx = richCtx();
    Object.defineProperty(tl.canvas, "clientWidth", { value: 320, configurable: true });
    tl.canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };
    return { tl, container, calls };
}

const mouse = (type, x) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });

test("点击（位移<4px）选中块，不触发 onReorder", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40); // rAF 后 _segs 就绪

    tl.canvas.dispatchEvent(mouse("mousedown", 50));
    window.dispatchEvent(mouse("mousemove", 52)); // <4px，不算拖动
    window.dispatchEvent(mouse("mouseup", 52));

    assert.deepEqual(calls.select, [0]);
    assert.equal(calls.reorder.length, 0);
    tl.destroy();
});

test("2 段：越过目标块中心才移动；落在间隙保持原序（源块不计入比较）", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // W=320, padX=8：块0 [8,160]，块1 [160,312]，块1 中心 236
    tl.canvas.dispatchEvent(mouse("mousedown", 100)); // 按下块0
    window.dispatchEvent(mouse("mousemove", 250));    // 越过块1 中心 → 移到末尾
    window.dispatchEvent(mouse("mouseup", 250));

    assert.equal(calls.reorder.length, 1);
    assert.deepEqual(calls.reorder[0], [1, 0]);
    assert.equal(calls.select.length, 0); // 拖动结束不应走 select

    // 再拖：落在块1 中心之前的间隙（x=200）→ 顺序不变，但仍是"拖动"而非点击
    tl.canvas.dispatchEvent(mouse("mousedown", 100));
    window.dispatchEvent(mouse("mousemove", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    assert.deepEqual(calls.reorder[1], [0, 1]);
    tl.destroy();
});

test("3 段拖到末尾：只按非源块中心点计数，不多跳", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }, { duration: 10 }]);
    await sleep(40);

    // usable=304：A[8,86.5] B[86.5,165] C[165,312]，中心 A≈47 B≈126 C≈238
    tl.canvas.dispatchEvent(mouse("mousedown", 50)); // 按下 A
    window.dispatchEvent(mouse("mousemove", 300));   // 拖过 B、C 两个中心点 → p=2
    window.dispatchEvent(mouse("mouseup", 300));

    assert.deepEqual(calls.reorder, [[1, 2, 0]]);
    tl.destroy();
});

test("3 段拖到中段：光标在 B、C 之间只越过 A 中心 → [1,0,2]", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }, { duration: 10 }]);
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 50)); // 按下 A
    window.dispatchEvent(mouse("mousemove", 200));   // 仅越过 A 中心(47)，未过 B 中心(126)? 200>126 → p=1（B 非源，C 中心238>200）
    window.dispatchEvent(mouse("mouseup", 200));

    assert.deepEqual(calls.reorder, [[1, 0, 2]]);
    tl.destroy();
});

test("readOnly：点击只选中，不进入拖拽", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true });
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 200)); // 块1
    window.dispatchEvent(mouse("mousemove", 60));
    window.dispatchEvent(mouse("mouseup", 60));

    assert.deepEqual(calls.select, [1]);
    assert.equal(calls.reorder.length, 0);
    tl.destroy();
});

test("destroy 移除 canvas 并停止监听", async () => {
    resetEnv();
    const { tl, container } = makeTimeline([{ duration: 5 }]);
    await sleep(40);
    tl.destroy();
    assert.equal(container.querySelector("canvas"), null);
});

test("身份色相按段 id 绑定（重排不变色），无 id 回退按位置", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5, id: "a" }, { duration: 5, id: "b" }]);
    await sleep(40); // rAF 后色相槽位已分配：a→slot0，b→slot1
    assert.equal(tl._identityHue({ id: "a" }, 1), 0);   // a 移到位置 1 颜色不变
    assert.equal(tl._identityHue({ id: "b" }, 0), 47);  // b 移到位置 0 颜色不变
    assert.equal(tl._identityHue({}, 2), (2 * 47) % 360); // 无 id → 按位置
    tl.destroy();
});

test("拖块右缘调时长：吸附 0.5s，松手提交 onResize", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // W=320, padX=8, usable=304, total=10 → pps=30.4；块0 [8,160]，右缘热区 x∈[153,162]
    tl.canvas.dispatchEvent(mouse("mousedown", 158)); // 按下块0 右缘 → resize 模式
    window.dispatchEvent(mouse("mousemove", 200));    // (200-8)/30.4≈6.32 → 吸附 6.5
    window.dispatchEvent(mouse("mouseup", 200));

    assert.equal(calls.reorder.length, 0);
    assert.deepEqual(calls.resize, [[0, 6.5]]);
    tl.destroy();
});

test("悬停块：高亮索引更新；右缘热区光标 ew-resize；mouseleave 清除", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousemove", 100)); // 块0 中部
    assert.equal(tl._hover, 0);
    assert.equal(tl.canvas.style.cursor, "pointer");

    tl.canvas.dispatchEvent(mouse("mousemove", 158)); // 块0 右缘热区
    assert.equal(tl._hover, 0);
    assert.equal(tl.canvas.style.cursor, "ew-resize");

    tl.canvas.dispatchEvent(mouse("mouseleave"));
    assert.equal(tl._hover, null);
    tl.destroy();
});

test("readOnly：右缘热区不进入调时长，点击只选中", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true });
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 158)); // 块0 右缘位置
    window.dispatchEvent(mouse("mousemove", 250));
    window.dispatchEvent(mouse("mouseup", 250));

    assert.deepEqual(calls.select, [0]);
    assert.equal(calls.resize.length, 0);
    tl.destroy();
});

test("素材拖到段块上：dragover 记录落点，drop 分发 onDropImage(index, dataTransfer)", async () => {
    resetEnv();
    const drops = [];
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? "{\"filename\":\"a.png\",\"subfolder\":\"\"}" : "") };
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);

    const dragEvent = (type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clientX", { value: x, configurable: true });
        if (type === "drop" || type === "dragover") Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
        return ev;
    };
    tl.canvas.dispatchEvent(dragEvent("dragover", 100)); // 块0
    assert.equal(tl._dropOver, 0);
    tl.canvas.dispatchEvent(dragEvent("drop", 236)); // 块1
    assert.equal(drops.length, 1);
    assert.deepEqual(drops[0][0], 1);
    assert.equal(drops[0][1].getData("application/x-neo-gallery"), "{\"filename\":\"a.png\",\"subfolder\":\"\"}");
    assert.equal(tl._dropOver, -1, "drop 后清空落点");
    tl.destroy();
});

test("素材拖出（dragleave）清除落点；readOnly 不响应 drop", async () => {
    resetEnv();
    const drops = [];
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? "{\"filename\":\"a.png\"}" : "") };

    const dragEvent = (type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clientX", { value: x, configurable: true });
        if (type === "drop" || type === "dragover") Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
        return ev;
    };
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);
    tl.canvas.dispatchEvent(dragEvent("dragover", 100));
    assert.equal(tl._dropOver, 0);
    tl.canvas.dispatchEvent(dragEvent("dragleave", 100));
    assert.equal(tl._dropOver, -1, "dragleave 清除落点");
    tl.destroy();

    const { tl: tlRo } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true, onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);
    tlRo.canvas.dispatchEvent(dragEvent("dragover", 236));
    assert.equal(tlRo._dropOver, -1, "readOnly：dragover 不设置落点");
    tlRo.canvas.dispatchEvent(dragEvent("drop", 236));
    assert.equal(drops.length, 0, "readOnly：drop 不回调");
    tlRo.destroy();
});

test("尾部 ＋ 按钮：提供 onAdd 且非只读时占位并响应点击；readOnly/未提供时不显示", async () => {
    resetEnv();
    const adds = [];
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onAdd: () => adds.push(1) });
    await sleep(40);

    // W=320，onAdd 预留 32px：usable=272 → 块 [8,144]/[144,280]；「＋」x∈[288,312]、y∈[42,66]
    const chip = tl._addChipRect();
    assert.ok(chip, "非只读 + onAdd：按钮位置存在");
    const L = tl._layout();
    const last = L.blocks[L.blocks.length - 1];
    assert.equal(last.x + last.w, 280, "块布局为 ＋ 预留尾部空间");

    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    tl.canvas.dispatchEvent(click("mousedown", 300, 50));
    assert.equal(adds.length, 1, "点击 ＋ 触发 onAdd");
    assert.equal(calls.select.length, 0, "点击 ＋ 不选中块");
    tl.destroy();

    // readOnly：即使提供 onAdd 也不显示按钮，点击该位置只选中块
    const addsRo = [];
    const { tl: tlRo, calls: callsRo } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true, onAdd: () => addsRo.push(1) });
    await sleep(40);
    assert.equal(tlRo._addChipRect(), null, "readOnly：不显示 ＋");
    tlRo.canvas.dispatchEvent(click("mousedown", 300, 50)); // 块1 [160,312]（无预留）内
    window.dispatchEvent(click("mouseup", 300, 50));
    assert.equal(addsRo.length, 0);
    assert.deepEqual(callsRo.select, [1], "该位置按普通块点击处理");
    tlRo.destroy();

    // 未提供 onAdd：无按钮，布局不预留
    const { tl: tlNo } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tlNo._addChipRect(), null, "未提供 onAdd：不显示 ＋");
    const LNo = tlNo._layout();
    const lastNo = LNo.blocks[LNo.blocks.length - 1];
    assert.equal(lastNo.x + lastNo.w, 312, "布局不预留尾部空间");
    tlNo.destroy();
});
