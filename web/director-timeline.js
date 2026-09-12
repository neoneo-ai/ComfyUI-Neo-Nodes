// Neo-Nodes 导演时间轴组件。
// 按 duration_sec 比例绘制分段块 + 顶部秒刻度尺，支持点击选中、拖拽重排。
// 数据完全由宿主通过 options.getSegments() 提供（返回当前顺序的数组），因此可挂到
// 任意容器——导演编辑器浮层或 NeoH3VideoDirector 节点 DOM 均可复用同一组件。
//
// getSegments() 应返回：[{ duration, prompt, thumbUrl, id? }]，顺序即宿主当前分段顺序。
// id 为段身份（可选）：提供后颜色按身份绑定，重排时颜色跟随段内容而非位置。
// 回调：onSelect(index)、onReorder(order)（原始索引的新排列）、
//       onResize(index, durationSec)（拖块右缘调时长，吸附 0.5s、最小 1s；仅非 readOnly）。

const DT_CSS_HREF = "/extensions/ComfyUI-Neo-Nodes/director-timeline.css";

export class DirectorTimeline {
  constructor(container, options) {
    this.container = container;
    this.opts = Object.assign({ height: 92, getSegments: () => [], onSelect: null, onReorder: null, readOnly: false }, options);
    this._segs = [];
    this._thumbs = new Map(); // url -> HTMLImageElement
    this._hueById = new Map(); // 段身份 -> 色相槽位（首次出现顺序分配，重排不变）
    this._selected = -1;
    this._drag = null; // { src, order, moved, startX, cursorX }
    this._hover = null; // 悬停块索引（高亮 + 时间范围提示）
    this._raf = 0;

    this._ensureCss();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "neo-dtl-canvas";
    this.canvas.style.cssText = "display:block;width:100%;cursor:pointer;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._onMoveB = (e) => this._onMove(e);
    this._onUpB = (e) => this._onUp(e);
    this.canvas.addEventListener("mousedown", (e) => this._onDown(e));
    this.canvas.addEventListener("mousemove", (e) => this._hoverAt(e));
    this.canvas.addEventListener("mouseleave", () => { if (this._hover !== null) { this._hover = null; this.refresh(); } });
    this._ro = new ResizeObserver(() => this.refresh());
    this._ro.observe(container);
    this.refresh();
  }

  _ensureCss() {
    if (document.querySelector('link[data-neo-dtl="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = DT_CSS_HREF;
    link.setAttribute("data-neo-dtl", "1");
    document.head.appendChild(link);
  }

  // 宿主在数据变化（增删/重排/时长/首帧）后调用，或组件内部缩略图加载完成后调用。
  refresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._doRefresh();
    });
  }

  _doRefresh() {
    const segs = (this.opts.getSegments && this.opts.getSegments()) || [];
    this._segs = segs;
    // 身份色槽位：段首次出现时按顺序占一个色相，之后重排颜色跟随内容不变
    for (let i = 0; i < segs.length; i++) {
      const id = segs[i].id;
      if (id == null) continue;
      if (!this._hueById.has(id)) this._hueById.set(id, this._hueById.size);
    }
    for (const s of segs) {
      if (!s.thumbUrl || this._thumbs.has(s.thumbUrl)) continue;
      const img = new Image();
      img.onload = () => this.refresh();
      img.src = s.thumbUrl;
      this._thumbs.set(s.thumbUrl, img);
    }
    this._draw();
  }

  select(i) {
    this._selected = i;
    if (this.opts.onSelect) this.opts.onSelect(i);
    this.refresh();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    window.removeEventListener("mousemove", this._onMoveB);
    window.removeEventListener("mouseup", this._onUpB);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  // 光标是否落在某块右缘的调时长热区（仅非 readOnly）
  _resizeZoneAt(x, i) {
    if (this.opts.readOnly || i < 0) return false;
    const b = this._layout().blocks[i];
    return !!b && x >= b.x + b.w - 7 && x <= b.x + b.w + 2;
  }

  _hoverAt(e) {
    if (this._drag) return; // 拖动中不更新悬停
    const rect = this.canvas.getBoundingClientRect();
    const i = this._blockAt(e.clientX - rect.left);
    const zone = this._resizeZoneAt(e.clientX - rect.left, i);
    this.canvas.style.cursor = zone ? "ew-resize" : "pointer";
    if (i !== this._hover) { this._hover = i; this.refresh(); }
  }
  _width() {
    return this.canvas.clientWidth || this.container.clientWidth || 0;
  }

  // 依据当前分段计算每块像素位置：{ padX, usable, total, pxPerSec, blocks:[{i,x,w}] }
  // 调时长拖动中传入 preview（索引 -> 预览秒数），按新总时长重排，实时反馈拉伸效果
  _layout(preview) {
    const W = this._width();
    const padX = 8;
    const usable = Math.max(10, W - padX * 2);
    const segs = this._segs;
    const n = segs.length;
    const durOf = (i) => {
      if (preview && typeof preview[i] === "number") return preview[i];
      return Number(segs[i].duration) || 0;
    };
    let total = 0;
    for (let i = 0; i < n; i++) total += durOf(i);
    const blocks = [];
    if (n > 0 && total > 0) {
      const pps = usable / total;
      let x = padX;
      for (let i = 0; i < n; i++) {
        const w = Math.max(durOf(i) * pps, n > 1 ? 3 : usable);
        blocks.push({ i, x, w, seg: segs[i] });
        x += w;
      }
    } else if (n > 0) {
      const w = usable / n;
      let x = padX;
      for (let i = 0; i < n; i++) { blocks.push({ i, x, w, seg: segs[i] }); x += w; }
    }
    return { padX, usable, total, pxPerSec: total > 0 ? usable / total : 0, blocks };
  }

  _blockAt(x) {
    const L = this._layout();
    for (const b of L.blocks) if (x >= b.x && x <= b.x + b.w) return b.i;
    return -1;
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = this._blockAt(x);
    if (i < 0) return;
    e.preventDefault();
    if (this.opts.readOnly) { this.select(i); return; }
    if (this._resizeZoneAt(x, i)) {
      this._drag = { src: i, resize: true, moved: false, startX: x };
      window.addEventListener("mousemove", this._onMoveB);
      window.addEventListener("mouseup", this._onUpB);
      return;
    }
    this._drag = { src: i, order: this._segs.map((_, k) => k), moved: false, startX: e.clientX, cursorX: 0 };
    window.addEventListener("mousemove", this._onMoveB);
    window.addEventListener("mouseup", this._onUpB);
  }

  _onMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (this._drag.resize) {
      // 调时长：吸附 0.5s、最小 1s；预览值暂存，松手才提交 onResize
      if (!this._drag.moved && Math.abs(x - this._drag.startX) < 4) return;
      this._drag.moved = true;
      const L = this._layout();
      const b = L.blocks[this._drag.src];
      if (!b || !L.pxPerSec) return;
      const raw = Math.max(1, (x - b.x) / L.pxPerSec);
      this._drag.newDur = Math.min(300, Math.max(1, Math.round(raw * 2) / 2));
      this.refresh();
      return;
    }
    if (!this._drag.moved && Math.abs(e.clientX - this._drag.startX) < 4) return;
    this._drag.moved = true;
    const L = this._layout();
    const cx = Math.max(L.padX, Math.min(rect.width - L.padX, x));
    this._drag.cursorX = cx;
    // 插入位：只统计非源块的中心点（源块被"拿起"，不参与排序比较）
    let p = 0;
    for (const idx of this._drag.order) {
      if (idx === this._drag.src) continue;
      const b = L.blocks[idx];
      if (b && b.x + b.w / 2 < cx) p++;
    }
    const order = this._drag.order.filter((i) => i !== this._drag.src);
    order.splice(p, 0, this._drag.src);
    this._drag.order = order;
    // 目标槽位：按新顺序前 p 个块的宽度累加，得到源块落位后的 x（幽灵块与指示线对齐）
    let sx = L.padX;
    for (let k = 0; k < p; k++) { const b = L.blocks[order[k]]; if (b) sx += b.w; }
    this._drag.slotX = sx;
    this.refresh();
  }

  _onUp() {
    window.removeEventListener("mousemove", this._onMoveB);
    window.removeEventListener("mouseup", this._onUpB);
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.resize) {
      if (d.moved && typeof d.newDur === "number" && this.opts.onResize) this.opts.onResize(d.src, d.newDur);
      this.refresh();
      return;
    }
    if (d.moved) { if (this.opts.onReorder) this.opts.onReorder(d.order); }
    else this.select(d.src);
    this.refresh();
  }
  // 段身份色相：有 id 按身份槽位（重排不变），无 id 回退按位置
  _identityHue(seg, i) {
    const slot = seg && seg.id != null ? this._hueById.get(seg.id) : undefined;
    return ((slot == null ? i : slot) * 47) % 360;
  }

  _rulerStep(pps, usable) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const s of steps) if (s * pps >= Math.min(48, usable / 2)) return s;
    return steps[steps.length - 1];
  }

  _rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  _drawThumb(img, x, y, w, h) {
    const ctx = this.ctx;
    const ir = img.naturalWidth / (img.naturalHeight || 1);
    const r = w / h;
    let sw, sh, sx, sy;
    if (ir > r) { sh = img.naturalHeight; sw = sh * r; sx = (img.naturalWidth - sw) / 2; sy = 0; }
    else { sw = img.naturalWidth; sh = sw / r; sx = 0; sy = (img.naturalHeight - sh) / 2; }
    ctx.save();
    this._rr(ctx, x, y, w, h, 3);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  _draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this._width();
    const H = this.opts.height;
    if (W <= 0) return;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 调时长拖动中按预览值重排布局，实时反馈拉伸效果
    const resizeDrag = this._drag && this._drag.moved && this._drag.resize ? this._drag : null;
    const preview = resizeDrag && typeof resizeDrag.newDur === "number" ? { [resizeDrag.src]: resizeDrag.newDur } : undefined;
    const L = this._layout(preview);
    if (L.blocks.length === 0) {
      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("暂无分段", L.padX, H / 2);
      return;
    }

    // 顶部秒刻度尺
    const rulerH = 18;
    if (L.total > 0) {
      ctx.strokeStyle = "#3a3a3a";
      ctx.beginPath(); ctx.moveTo(L.padX, rulerH - 2); ctx.lineTo(W - L.padX, rulerH - 2); ctx.stroke();
      const step = this._rulerStep(L.pxPerSec, L.usable);
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "top";
      for (let t = 0; t <= L.total + 1e-6; t += step) {
        const x = L.padX + t * L.pxPerSec;
        if (x > W - L.padX + 1) break;
        ctx.strokeStyle = "#555";
        ctx.beginPath(); ctx.moveTo(x, rulerH - 8); ctx.lineTo(x, rulerH - 2); ctx.stroke();
        ctx.fillStyle = "#7a7a7a";
        ctx.fillText(Math.round(t) + "s", x + 2, 0);
      }
    }

    const top = rulerH + 4;
    const bh = H - top - 6;
    const drag = this._drag && this._drag.moved ? this._drag : null;
    // 悬停块的起止秒（时间范围提示）；调时长拖动中跟随预览值
    let hoverRange = null;
    if (this._hover != null && this._segs[this._hover]) {
      const durs = drag && drag.resize ? L.blocks.map((bb) => (bb.i === drag.src ? drag.newDur : Number(this._segs[bb.i].duration) || 0)) : this._segs.map((s) => Number(s.duration) || 0);
      let st = 0;
      for (let k = 0; k < this._hover; k++) st += durs[k];
      hoverRange = [st, st + durs[this._hover]];
    }
    for (const b of L.blocks) {
      const seg = b.seg || this._segs[b.i];
      if (drag && drag.src === b.i) {
        // 源块被"拿起"：原位只留虚线占位
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 3]);
        this._rr(ctx, b.x + 1, top, Math.max(2, b.w - 2), bh, 4);
        ctx.strokeStyle = "rgba(140,204,255,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        continue;
      }
      this._paintSeg(ctx, b.x, b.w, top, bh, seg, String(b.i + 1), this._identityHue(seg, b.i), false, b.i === this._selected || b.i === this._hover);
    }

    // 悬停提示：块内左下角显示该段时间范围（如 "5–10s"）
    if (hoverRange) {
      const hb = L.blocks[this._hover];
      if (hb) {
        const txt = `${Math.round(hoverRange[0])}–${Math.round(hoverRange[1])}s`;
        ctx.font = "9px sans-serif";
        const tw = ctx.measureText(txt).width + 8;
        let tx = Math.max(hb.x + 4, hb.x + hb.w - tw - 26);
        const ty = top + bh - 15;
        this._rr(ctx, tx, ty, tw, 13, 3);
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fill();
        ctx.fillStyle = "#eee";
        ctx.textBaseline = "top";
        ctx.fillText(txt, tx + 4, ty + 2);
      }
    }

    // 拖拽：幽灵块落在目标槽位（自带新序号），替代旧的光标指示线
    if (drag && typeof drag.slotX === "number") {
      const srcB = L.blocks[drag.src];
      const seg = srcB.seg || this._segs[drag.src];
      const newIdx = drag.order.indexOf(drag.src);
      this._paintSeg(ctx, drag.slotX, srcB.w, top, bh, seg, String(newIdx + 1), this._identityHue(seg, drag.src), true, false);
    }
  }

  // 绘制单个分段块（普通/幽灵共用）：浅色身份底（重排不变色）；有首帧图则平铺满块宽，文字白字描边，否则浅底深字
  _paintSeg(ctx, x, w, top, bh, seg, numLabel, hue, ghost, sel) {
    const iw = Math.max(2, w - 2);
    this._rr(ctx, x + 1, top, iw, bh, 4);
    if (ghost) ctx.globalAlpha = 0.9;
    ctx.fillStyle = "hsl(" + hue + ",55%," + (ghost ? 62 : sel ? 70 : 58) + "%)";
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = ghost || sel ? 1.5 : 1;
    ctx.strokeStyle = ghost || sel ? "#8cf" : "rgba(255,255,255,0.16)";
    ctx.stroke();

    // 首帧图：按原比例裁出竖条后横向重复，铺满块宽
    const img = seg.thumbUrl ? this._thumbs.get(seg.thumbUrl) : null;
    const tiled = !!(img && img.complete && img.naturalWidth > 0);
    if (tiled) {
      const tileH = bh - 8;
      const tw = Math.max(12, tileH * (img.naturalWidth / img.naturalHeight));
      ctx.save();
      this._rr(ctx, x + 5, top + 4, Math.max(2, iw - 8), tileH, 3);
      ctx.clip();
      for (let tx = x + 5; tx < x + w - 5; tx += tw) this._drawThumb(img, tx, top + 4, tw, tileH);
      ctx.restore();
    }

    const put = (t, tx, ty, font, color) => {
      ctx.font = font;
      if (tiled) { ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.strokeText(t, tx, ty); }
      ctx.fillStyle = color;
      ctx.fillText(t, tx, ty);
    };

    // 序号（当前位置）
    ctx.textBaseline = "top";
    put(numLabel, x + 6, top + 4, "bold 10px sans-serif", tiled ? "#fff" : "#2a2a2a");

    // 提示词片段
    if (seg.prompt) {
      ctx.font = "11px sans-serif";
      put(this._fitText(ctx, seg.prompt, Math.max(20, w - 14)), x + 6, top + 17, "11px sans-serif", tiled ? "#fff" : "#333");
    }

    // 时长
    if (seg.duration) {
      const d = String(seg.duration) + "s";
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "bottom";
      put(d, x + w - ctx.measureText(d).width - 5, top + bh - 3, "9px sans-serif", tiled ? "#fff" : "#555");
    }
  }
}