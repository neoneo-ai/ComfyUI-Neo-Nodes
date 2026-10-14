// 实时预览帧播放器（web/live-preview.js）：载荷应用 / 自动循环播放 / 暂停继续 / 逐帧逐步回看 / 结束定格 / reset。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, click } from "./setup.mjs";

// setup.mjs 先装好钩子与桩后再导入组件模块
const { createFramePlayer } = await import("../../web/live-preview.js");

const frame = (name) => `data:image/jpeg;base64,${name}`;
const payload = (names, fps = 8) => ({ frames: names.map(frame), fps, w: 512, h: 288 });
const FRAME_MS = 1000 / 8; // 一帧的毫秒数（tick 的推进阈值）

function makePlayer(onFrame) {
    const box = document.createElement("div");
    box.className = "neo-dtl-live";
    document.body.appendChild(box);
    const player = createFramePlayer(box, onFrame);
    return {
        box,
        player,
        img: () => box.querySelector(".neo-dtl-live-img"),
        labels: () => [...box.querySelectorAll(".neo-dtl-live-label")].map((e) => e.textContent),
    };
}

test("空闲态：面板隐藏不占位", () => {
    resetEnv();
    const { box } = makePlayer();
    assert.equal(box.style.display, "none");
    assert.equal(box.style.height, "0px");
});

test("载荷到达：立即显示面板、播第一帧，onFrame 带 w/h 回调宿主", () => {
    resetEnv();
    const seen = [];
    const { box, player, img, labels } = makePlayer((d) => seen.push([d.w, d.h]));
    const p = payload(["a", "b", "c"]);
    p.node_id = "task-1"; // node_id 由宿主过滤，播放器不关心
    player.apply(p);
    assert.equal(box.style.display, "");
    assert.equal(img().src, frame("a"));
    assert.deepEqual(labels(), ["第 1/1 步", "1/3 帧"]);
    assert.deepEqual(seen, [[512, 288]]);
});

test("自动循环播放：到尾回第一帧，可暂停/继续", () => {
    resetEnv();
    const { box, player, img } = makePlayer();
    player.apply(payload(["a", "b", "c"]));
    assert.equal(box.style.display, "");
    assert.equal(img().src, frame("a"));

    player.tick(1000);                       // 第一次 tick 只对时
    player.tick(1000 + FRAME_MS);
    assert.equal(img().src, frame("b"));
    player.tick(1000 + 2 * FRAME_MS);
    assert.equal(img().src, frame("c"));
    player.tick(1000 + 3 * FRAME_MS);
    assert.equal(img().src, frame("a"), "到尾自动循环回第一帧");

    click(box.querySelector(".neo-dtl-live-play"));
    assert.match(box.querySelector(".neo-dtl-live-play").title, /继续/);
    player.tick(2000);
    player.tick(4000);
    assert.equal(img().src, frame("a"), "暂停后不再推进");

    click(box.querySelector(".neo-dtl-live-play"));
    player.tick(5000);
    player.tick(5000 + FRAME_MS);
    assert.equal(img().src, frame("b"), "继续播放从当前帧接着走");
});

test("逐帧 / 逐采样步回看：新载荷不拽走回看的旧步", () => {
    resetEnv();
    const { box, player, img } = makePlayer();
    player.apply(payload(["a", "b"]));
    player.apply(payload(["c", "d"]));
    assert.equal(img().src, frame("c"), "跟随最新步");

    click(box.querySelector(".neo-dtl-live-step-prev")); // 回到第 1 步
    assert.equal(img().src, frame("a"));
    player.apply(payload(["e"]));                       // 回看期间的新载荷不得拽走
    assert.equal(img().src, frame("a"), "回看旧步时新载荷不改变画面");

    click(box.querySelector(".neo-dtl-live-frame-next"));
    assert.equal(img().src, frame("b"), "逐帧在当前步内移动并自动暂停");
});

test("结束定格：pause 后迟到载荷不再改画面", () => {
    resetEnv();
    const { box, player, img } = makePlayer();
    player.apply(payload(["a", "b"]));
    player.pause();
    assert.match(box.querySelector(".neo-dtl-live-play").title, /继续/, "pause 后按钮变「继续」");
    player.apply(payload(["z"]));
    assert.equal(img().src, frame("a"), "迟到载荷被忽略");
});

test("reset：清空内容、隐藏面板，为下一次运行就绪", () => {
    resetEnv();
    const seen = [];
    const { box, player, img } = makePlayer((d) => seen.push(d));
    player.apply(payload(["a"]));
    assert.equal(box.style.display, "");
    player.reset();
    assert.equal(box.style.display, "none");
    assert.equal(box.style.height, "0px");
    assert.equal(img().getAttribute("src"), null);
    player.apply(payload(["b"]));
    assert.equal(img().src, frame("b"), "reset 后重新接受载荷并自动播放");
    assert.equal(seen.length, 2, "onFrame 每个载荷回调一次");
});