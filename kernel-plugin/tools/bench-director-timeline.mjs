#!/usr/bin/env node
// DirectorTimeline 性能基准：用真实 recipe（默认「冰雷玄幻对打」）的 prompt 在真实
// Chromium 里驱动组件，量化 _promptSummary 正则与 _fitLines 逐字符测量各占多少。
// Usage: node tools/bench-director-timeline.mjs [recipe.json]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipePath = process.argv[2] || path.join(ROOT, 'recipes', 'custom', '冰雷玄幻对打', 'recipe.json');
const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const segs = recipe.segments.map((s) => ({ duration: Number(s.duration_sec) || 5, prompt: s.prompt || '' }));

const src = fs.readFileSync(path.join(ROOT, 'web', 'director-timeline.js'), 'utf8');
const moduleSrc = src + '\nwindow.DirectorTimeline = DirectorTimeline;';

// 页面内运行的二分版 _fitLines（与逐字符版同语义：中间行取满、末行截断加省略号）
const BISECT_FIT = `
function fitLinesBisect(ctx, text, maxW, maxLines) {
  const out = [];
  let rest = String(text || "");
  for (let n = 0; n < maxLines && rest.length > 0; n++) {
    if (ctx.measureText(rest).width <= maxW) { out.push(rest); break; }
    const last = n === maxLines - 1;
    let lo = 1, hi = rest.length, fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(rest.slice(0, mid) + (last ? "…" : "")).width <= maxW) { fit = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const t = rest.slice(0, fit);
    out.push(last ? t + "…" : t);
    rest = rest.slice(t.length);
  }
  return out;
}
window.fitLinesBisect = fitLinesBisect;
`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!DOCTYPE html><body style="margin:0"></body>');
await page.addScriptTag({ type: 'module', content: moduleSrc });
await page.addScriptTag({ content: BISECT_FIT });

const report = await page.evaluate(async (segs) => {
  const container = document.createElement('div');
  container.style.width = '900px';
  document.body.appendChild(container);
  const tl = new window.DirectorTimeline(container, { height: 184, getSegments: () => segs });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // 初始 refresh 落地
  const ctx = tl.ctx;
  const w = tl._layout().blocks[0].w; // 真实块宽（≈277px）
  const maxW = Math.max(20, w - 14);  // _paintSeg 内给 _fitLines 的实际 maxW

  // 仪表：measureText 调用次数与累计字符量
  let mtCalls = 0, mtChars = 0;
  const origMeasure = ctx.measureText.bind(ctx);
  ctx.measureText = (t) => { mtCalls++; mtChars += String(t).length; return origMeasure(t); };
  // 仪表：正则摘要累计耗时
  const origSummary = tl._promptSummary.bind(tl);
  let regexMs = 0, regexCalls = 0;
  tl._promptSummary = (t) => { const s = performance.now(); const r = origSummary(t); regexMs += performance.now() - s; regexCalls++; return r; };

  const once = (fn) => { mtCalls = 0; mtChars = 0; regexMs = 0; regexCalls = 0; const t0 = performance.now(); fn(); return { ms: performance.now() - t0, mtCalls, mtChars, regexMs, regexCalls }; };
  const out = { promptLens: segs.map((s) => s.prompt.length), blockW: w, maxW };

  // E1 当前实现：单帧全量重绘（4 段）
  out.e1_current = once(() => tl._doRefresh());

  // E2 去掉正则过滤（_promptSummary 直接返回原文）：其余路径不变
  tl._promptSummary = (t) => String(t || "");
  out.e2_no_regex = once(() => tl._doRefresh());
  tl._promptSummary = origSummary;

  // E3 单独 _fitLines：逐字符（当前实现）逐段计时
  out.e3_fitlines_char = segs.map((s) => once(() => tl._fitLines(ctx, s.prompt, maxW, 2)));

  // E4 二分版：耗时 + 与逐字符版输出一致性
  const bisect = [];
  for (let i = 0; i < segs.length; i++) {
    const charLines = tl._fitLines(ctx, segs[i].prompt, maxW, 2);
    const bio = once(() => window.fitLinesBisect(ctx, segs[i].prompt, maxW, 2));
    const bioLines = window.fitLinesBisect(ctx, segs[i].prompt, maxW, 2);
    bio.same = JSON.stringify(charLines) === JSON.stringify(bioLines);
    bisect.push(bio);
  }
  out.e4_fitlines_bisect = bisect;

  // E5 打字场景：连续 10 帧全量重绘（每键 refresh 的最坏情况）
  mtCalls = 0; mtChars = 0; regexMs = 0;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) tl._doRefresh();
  out.e5_ten_frames = { ms: performance.now() - t0, mtCalls, mtChars, regexMs };

  tl.destroy();
  return out;
}, segs);

console.log('prompt 字符数/段:', report.promptLens.join(', '));
console.log(`块宽 ${report.blockW.toFixed(0)}px, 折行 maxW ${report.maxW.toFixed(0)}px\n`);
const fmt = (r) => `${r.ms.toFixed(1)}ms | measureText: ${r.mtCalls} 次 / ${(r.mtChars / 1e6).toFixed(1)}M 字符 | 正则: ${r.regexMs.toFixed(1)}ms (${r.regexCalls} 次)`;
console.log('E1 当前实现 单帧重绘:   ', fmt(report.e1_current));
console.log('E2 去掉正则 单帧重绘:   ', fmt(report.e2_no_regex));
console.log('E3 逐字符 _fitLines/段: ', report.e3_fitlines_char.map((r) => `${r.ms.toFixed(1)}ms (${r.mtCalls} 次 measureText)`).join(' | '));
console.log('E4 二分   _fitLines/段: ', report.e4_fitlines_bisect.map((r) => `${r.ms.toFixed(1)}ms (${r.mtCalls} 次) ${r.same ? '输出一致' : '输出不一致!'}`).join(' | '));
console.log('E5 连续 10 帧(模拟打字): ', fmt(report.e5_ten_frames));
await browser.close();
