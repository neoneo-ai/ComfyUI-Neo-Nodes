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
    const tl = new DirectorTimeline(container, Object.assign({ height: 40 }, opts, {
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
    assert.equal(tl._identityHue({ id: "a" }, 1), (0 * 47 + 180) % 360);   // a 移到位置 1 颜色不变（slot0，青绿起点）
    assert.equal(tl._identityHue({ id: "b" }, 0), (1 * 47 + 180) % 360);  // b 移到位置 0 颜色不变（slot1）
    assert.equal(tl._identityHue({}, 2), (2 * 47 + 180) % 360);           // 无 id → 按位置
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

    // W=320，onAdd 预留 32px：usable=272 → 块 [8,144]/[144,280]；「＋」x∈[288,312]、y∈[16,40]（height=40）
    const chip = tl._addChipRect();
    assert.ok(chip, "非只读 + onAdd：按钮位置存在");
    const L = tl._layout();
    const last = L.blocks[L.blocks.length - 1];
    assert.equal(last.x + last.w, 280, "块布局为 ＋ 预留尾部空间");

    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    tl.canvas.dispatchEvent(click("mousedown", 300, 28));
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

test("setZoom/getZoom：放大/缩小 → canvas 按像素宽；缩回铺满；越界钳制", async () => {
    resetEnv();
    const { tl, container } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // 组件不再内置控制条（UI 由宿主建）；canvas 位于横向滚动容器内
    assert.equal(container.querySelector(".neo-dtl-zoombar"), null, "无内置放大控制条");
    assert.equal(tl.scroll.parentNode, container, "canvas 位于横向滚动容器内");

    // 初始 zoom=1：内容宽度 = 可视宽（320），canvas 铺满
    assert.equal(tl.getZoom(), 1);
    assert.equal(tl._width(), 320, "zoom=1 内容宽度=可视宽");
    assert.equal(tl.canvas.style.width, "100%", "zoom=1 canvas 铺满");

    // 拉伸到 2x：内容宽度 = 640，canvas 按像素宽（横向滚动）
    tl.setZoom(2);
    await sleep(40);
    assert.equal(tl.getZoom(), 2, "getZoom 同步");
    assert.equal(tl._width(), 640, "zoom=2 内容宽度=可视宽×2");
    assert.equal(tl.canvas.style.width, "640px", "zoom>1 canvas 按像素宽");

    // 缩回铺满（zoom→1）：内容回到可视宽，滚动归零
    tl.setZoom(1);
    await sleep(40);
    assert.equal(tl.getZoom(), 1, "缩回铺满");
    assert.equal(tl._width(), 320, "缩回后内容宽度=可视宽");
    assert.equal(tl.canvas.style.width, "100%", "缩回后 canvas 铺满");

    // 缩小（zoom<1）：[5,5] natural=320=可视宽，缩到 0.5 → 内容不窄于可视宽，仍铺满（不拉伸失真）
    tl.setZoom(0.5);
    await sleep(40);
    assert.equal(tl.getZoom(), 0.5, "getZoom 同步（缩小）");
    assert.equal(tl._width(), 320, "内容不窄于可视宽 → 铺满");
    assert.equal(tl.canvas.style.width, "100%", "缩到小于可视宽时仍铺满（不拉伸）");

    // 多段溢出时缩小：内容从默认总宽收窄，但不小于可视宽（横向滚动范围减小）
    const { tl: tlMany } = makeTimeline(Array.from({ length: 10 }, () => ({ duration: 1 })), { height: 184 });
    await sleep(40);
    const manyDefaultW = tlMany._width();
    assert.ok(manyDefaultW > 320, "默认总宽溢出可视区");
    tlMany.setZoom(0.5);
    await sleep(40);
    assert.equal(tlMany.getZoom(), 0.5);
    assert.ok(tlMany._width() < manyDefaultW && tlMany._width() >= 320, "缩小后内容变窄但不小于可视宽");
    tlMany.destroy();

    // setZoom 越界钳制到 [DT_MIN_ZOOM, DT_MAX_ZOOM] = [0.25, 4]
    tl.setZoom(99);
    await sleep(40);
    assert.equal(tl.getZoom(), 4, "超过上限钳制到最大倍数 4");
    tl.setZoom(0);
    await sleep(40);
    assert.equal(tl.getZoom(), 0.25, "低于下限钳制到 0.25");

    tl.destroy();
});

test("默认拉伸=1：_width 恒等于可视宽、canvas 铺满", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tl.getZoom(), 1);
    assert.equal(tl._width(), 320);
    assert.equal(tl.canvas.style.width, "100%");
    tl.destroy();
});

test("拉伸时滚轮驱动横向滚动 + 显示可见滚动条类；未拉伸不响应", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    const wheel = (deltaY) => {
        const ev = new window.WheelEvent("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "deltaX", { value: 0, configurable: true });
        Object.defineProperty(ev, "deltaY", { value: deltaY, configurable: true });
        return ev;
    };

    // 初始未拉伸：无 zoomed 类，滚轮不横向滚动
    assert.ok(!tl.scroll.classList.contains("neo-dtl-zoomed"), "zoom=1 无 zoomed 类");
    tl.scroll.dispatchEvent(wheel(120));
    assert.equal(tl.scroll.scrollLeft, 0, "未拉伸：滚轮不横向滚动");

    // 拉伸后：出现 zoomed 类（可见滚动条），竖直滚轮 deltaY → scrollLeft
    tl.setZoom(3);
    await sleep(40);
    assert.ok(tl.scroll.classList.contains("neo-dtl-zoomed"), "zoom>1 显示可见滚动条");
    tl.scroll.dispatchEvent(wheel(120));
    assert.equal(tl.scroll.scrollLeft, 120, "拉伸：滚轮 deltaY → scrollLeft");
    tl.scroll.dispatchEvent(wheel(-40));
    assert.equal(tl.scroll.scrollLeft, 80, "反向滚动累加");

    // 缩回铺满：zoomed 类移除
    tl.setZoom(1);
    await sleep(40);
    assert.ok(!tl.scroll.classList.contains("neo-dtl-zoomed"), "缩回后移除 zoomed 类");

    tl.destroy();
});

test("默认总宽 = 段数×(块净高×16/9)：超可视区横滚、窄则铺满；段内按时长比例分配", async () => {
    resetEnv();
    // 用编辑器同款高度 184（块净高=184-28=156）→ 每段默认宽 ≈277px；10 段总宽 = 10×277 + padding(16) ≈ 2790 > 可视宽(320) → 横滚
    const segs = Array.from({ length: 10 }, () => ({ duration: 1 }));
    const { tl } = makeTimeline(segs, { height: 184 });
    await sleep(40);

    const frameW = (tl.opts.height - 28) * 16 / 9; // 每段默认宽 = 块净高 × 16/9（height=184 → ≈277px）
    assert.ok(tl._width() > 320, "内容宽度超出可视区");
    assert.equal(tl._width(), Math.ceil(10 * frameW + 16), "默认总宽 = 段数×默认宽 + padding");
    const blocks = tl._layout().blocks;
    assert.equal(blocks.length, 10);
    for (const b of blocks) assert.ok(Math.abs(b.w - frameW) < 1, "时长相等时每块≈默认帧宽（比例分配，非下限）");
    assert.equal(tl.canvas.style.width, tl._width() + "px", "溢出时 canvas 按像素宽");
    assert.ok(tl.scroll.classList.contains("neo-dtl-zoomed"), "溢出显示可见滚动条");
    tl.destroy();

    // 段少且默认总宽 < 可视区：拉伸铺满可视区
    const { tl: tl2 } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tl2._width(), 320, "默认总宽不足时铺满可视区");
    assert.equal(tl2.canvas.style.width, "100%", "铺满可视区");
    tl2.destroy();

    // 时长不等：段内按 dur 比例分配相对宽（长段更宽）
    const { tl: tl3 } = makeTimeline([{ duration: 1 }, { duration: 3 }]);
    await sleep(40);
    const b3 = tl3._layout().blocks;
    assert.ok(b3[1].w > b3[0].w, "长段更宽（按时长比例）");
    assert.ok(Math.abs(b3[1].w / b3[0].w - 3) < 0.5, "宽度比≈时长比 3:1");
    tl3.destroy();
});

test("_fitLines：中间行取满不加省略号，仅最后一行超出时加省略号", () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }]);
    tl.ctx.measureText = (t) => ({ width: String(t).length * 10 }); // 每字符 10px，maxW=40 → 中间行满 4 字 / 末行 3 字+…
    assert.deepEqual(tl._fitLines(tl.ctx, "abcdefghij", 40, 2), ["abcd", "efg…"], "超两行：首行取满无省略号、仅末行加省略号");
    assert.deepEqual(tl._fitLines(tl.ctx, "abcdef", 40, 2), ["abcd", "ef"], "两行放得下：均无省略号");
    assert.deepEqual(tl._fitLines(tl.ctx, "ab", 40, 2), ["ab"], "单行放得下：只一行无省略号");
    tl.destroy();
});

// 记录路径与填充：canvas 无后端，进度条是「圆角路径 + fill」，需回读坐标断言画在哪
function recordingCtx() {
    const paths = [];
    let cur = null;
    const rec = {
        _paths: paths,
        font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "top",
        measureText: () => ({ width: 0 }),
        canvas: null,
        beginPath() { cur = { moveTo: null, arcs: [], fill: null }; paths.push(cur); },
        moveTo(x, y) { if (cur) cur.moveTo = [x, y]; },
        arcTo(x1, y1, x2, y2, r) { if (cur) cur.arcs.push([x1, y1, x2, y2, r]); },
        closePath() {},
        fill() { if (cur) cur.fill = this.fillStyle; },
        stroke() {}, fillText() {}, strokeText() {}, fillRect() {},
        save() {}, restore() {}, clip() {}, setLineDash() {}, drawImage() {},
        setTransform() {}, clearRect() {},
    };
    return rec;
}

const DT_TOP = 18 + 4; // DT_RULER_H + DT_TOP_GAP，与 _draw 一致

test("生成进度条画在块顶部（块底部被横向滚动条占用）", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }]);
    const ctx = recordingCtx();
    const bh = 60;

    tl._paintSeg(ctx, 8, 200, DT_TOP, bh, { duration: 5, prompt: "" }, "1", 0, false, false, false, "current");
    const cur = ctx._paths.filter((p) => p.fill === "#e6a23c");
    assert.equal(cur.length, 1, "运行中画一条琥珀色进度条");
    assert.equal(cur[0].moveTo[1], DT_TOP + 1, "进度条贴在块顶部");
    assert.equal(cur[0].arcs[0][3] - cur[0].moveTo[1], 3, "进度条高 3px");

    tl._paintSeg(ctx, 8, 200, DT_TOP, bh, { duration: 5, prompt: "" }, "1", 0, false, false, false, "done");
    const done = ctx._paths.filter((p) => p.fill === "#3fb950");
    assert.equal(done.length, 1, "已完成段画绿色进度条");
    assert.equal(done[0].moveTo[1], DT_TOP + 1, "已完成段进度条同样在顶部");

    // 块下半部不再有任何进度条
    const lowHalf = ctx._paths.filter((p) => (p.fill === "#e6a23c" || p.fill === "#3fb950") && p.moveTo[1] > DT_TOP + bh / 2);
    assert.equal(lowHalf.length, 0, "块下半部不画进度条（原位置已被滚动条盖住）");
    tl.destroy();
});

test("revealSeg：内容溢出时把目标段滚进可视区，已可见则不动，未溢出不滚动", async () => {
    resetEnv();
    // 10 段 × 5s、编辑面板尺寸（height=184 → 每段默认宽≈277px）：默认总宽超出可视区 320
    const { tl } = makeTimeline(Array.from({ length: 10 }, () => ({ duration: 5 })), { height: 184 });
    await sleep(40);
    const view = tl._visibleWidth();
    assert.ok(tl._width() > view, "内容宽于可视区");
    assert.equal(tl.scroll.scrollLeft, 0);

    tl.revealSeg(9);
    const b = tl._layout().blocks[9];
    assert.ok(tl.scroll.scrollLeft > 0, "末段在可视区外 → 滚动");
    assert.ok(b.x >= tl.scroll.scrollLeft, "末段左缘进入可视区");
    assert.ok(b.x + b.w <= tl.scroll.scrollLeft + view, "末段右缘进入可视区");

    const settled = tl.scroll.scrollLeft;
    tl.revealSeg(9);
    assert.equal(tl.scroll.scrollLeft, settled, "已可见的段不再滚动");

    tl.revealSeg(0);
    assert.equal(tl.scroll.scrollLeft, 0, "回到首段滚回最左");
    tl.destroy();

    // 段少（默认总宽 < 可视区）：无需滚动
    const { tl: tl2 } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.ok(tl2._width() <= tl2._visibleWidth(), "内容未溢出");
    tl2.revealSeg(1);
    assert.equal(tl2.scroll.scrollLeft, 0, "未溢出时不滚动");
    tl2.destroy();
});

