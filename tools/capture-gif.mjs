#!/usr/bin/env node
// Reusable doc-image GIF capture for ComfyUI-Neo-Nodes.
//
// Drives the live ComfyUI with Playwright, records UI-interaction frames, and
// stitches them into a GIF via Pillow (invoked inline, no extra .py file).
//
// Usage:
//   node tools/capture-gif.mjs <scenario> [options]
//     --out <path>    output .gif (default docs/assets/images/<scenario>.gif)
//     --comfy <url>   ComfyUI URL (default http://127.0.0.1:8188)
//     --python <exe>  python with Pillow (default: project python)
//     --width <px>    output width after scaling (default 900)
//     --crop-w <px>   crop to this width before scaling; 0 = no crop (default full)
//     --keep-frames   keep the temp frames dir for inspection
//
// To add a new doc GIF: register a scenario below (a small async function that
// drives the page and calls h.snap(name, durationMs) to record each frame), then
// run `node tools/capture-gif.mjs <scenario>`. Reference the output in docs with
// a relative path like `assets/images/<file>.gif` and a Chinese caption.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..'); // plugin root (tools/..)

// ---- CLI args -------------------------------------------------------------
const argv = process.argv.slice(2);
function getOpt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const scenarioName = argv.find((a) => !a.startsWith('--'));
if (!scenarioName) {
  console.error('usage: node tools/capture-gif.mjs <scenario> [--out p] [--comfy url] [--width n] [--crop-w n]');
  process.exit(1);
}

const COMFY_URL = getOpt('comfy', 'http://127.0.0.1:8188');
const PYTHON = getOpt('python', 'f:\\comfy\\Comfyui-WF-2026.8.8\\python\\python.exe');
const KEEP_FRAMES = argv.includes('--keep-frames');

// ---- shared helpers -------------------------------------------------------
function makeHelpers(page, frames, framesDir) {
  return {
    page,
    // Record a frame. `duration` is how long this frame shows in the GIF (ms).
    snap(name, duration = 200) {
      const file = `frame_${String(frames.length).padStart(2, '0')}_${name}.png`;
      frames.push({ file, duration });
      return page.screenshot({ path: path.join(framesDir, file) });
    },
    wait: (ms) => page.waitForTimeout(ms),
    // Click the first element matching `sel` whose text contains `text`.
    clickByText(sel, text) {
      return page.locator(sel).filter({ hasText: text }).first().click();
    },
    press: (key) => page.keyboard.press(key),
    // Wait for two animation frames so a canvas repaint lands before the next snap.
    repaint() {
      return page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    },
  };
}

// Absolute-coordinate mouse drag with intermediate steps; waits per step so a
// canvas that repaints on rAF shows the motion across frames.
async function drag(page, x0, y0, x1, y1, steps = 7, onStep) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(55);
    if (onStep) await onStep(i);
  }
  await page.mouse.up();
}

// ---- scenarios ------------------------------------------------------------
const SCENARIOS = {
  // Open the director editor from the recipe list and drag a timeline block to
  // reorder segments. Output matches the file referenced in docs/recipes.md.
  'director-timeline': {
    out: 'neo-video-director-timeline.gif',
    cropW: 1160, // match the committed docs image (drops the empty right canvas)
    async run(h) {
      const page = h.page;
      await page.setViewportSize({ width: 1500, height: 860 });
      await page.goto(COMFY_URL, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.comfyAPI, null, { timeout: 30000 });
      await h.wait(2500);

      // Sidebar -> 配方 tab (registered via extensionManager.registerSidebarTab).
      await page.locator('button[aria-label="Neo Recipes (视频配方)"]').click();
      await page.waitForSelector('.neo-recipes-panel .neo-recipes-card', { timeout: 15000 });
      await h.wait(400);
      await h.snap('panel', 320);

      // Click the director recipe card's cover to open its editor overlay.
      const card = page.locator('.neo-recipes-card').filter({ hasText: /director/i }).first();
      await card.locator('.neo-recipes-card-cover').click();
      await page.waitForSelector('.neo-director-overlay .neo-dtl-canvas', { timeout: 15000 });
      await h.wait(700);
      await h.snap('editor-open', 260);

      // Drag block 0 toward a later slot on the timeline canvas. Fraction-based so it
      // adapts to the segment count; the component snaps the ghost to the target slot.
      const box = await page.locator('.neo-director-overlay .neo-dtl-canvas').boundingBox();
      const n = Math.max(1, await page.locator('.neo-director-overlay .neo-director-seg').count());
      const y = box.y + box.height * 0.5;
      const startX = box.x + box.width * (0.5 / n);
      const endX = box.x + box.width * Math.min(0.92, (3 + 0.5) / n);
      // Snap a frame every couple of steps so the ghost's slot-snapping reads as motion.
      await drag(page, startX, y, endX, y, 8, (i) => (i % 2 === 0 ? h.snap('drag', 90) : null));
      await h.snap('reordered', 520);
    },
  },
};

// ---- GIF build (inline Pillow) --------------------------------------------
const PY_BUILD = `
import json, os, sys
from PIL import Image
frames_dir, out, target_w, crop_w = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
manifest = json.load(open(os.path.join(frames_dir, "manifest.json"), encoding="utf-8"))
frames = []
for item in manifest:
    im = Image.open(os.path.join(frames_dir, item["file"])).convert("RGB")
    if crop_w and 0 < crop_w < im.width:
        im = im.crop((0, 0, crop_w, im.height))
    h = round(im.height * target_w / im.width)
    frames.append((im.resize((target_w, h), Image.LANCZOS), item["duration"]))
dedup = []
for im, dur in frames:
    if dedup and im.tobytes() == dedup[-1][0].tobytes():
        dedup[-1] = (dedup[-1][0], dedup[-1][1] + dur)
    else:
        dedup.append((im, dur))
os.makedirs(os.path.dirname(out), exist_ok=True)
dedup[0][0].save(out, save_all=True, append_images=[i for i, _ in dedup[1:]], duration=[d for _, d in dedup], loop=0)
print("wrote", out, "frames=", len(dedup))
`;

// ---- main -----------------------------------------------------------------
async function main() {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`unknown scenario "${scenarioName}". available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  const base = scenario.out || scenarioName;
  const outPath = getOpt('out', path.join(ROOT, 'docs', 'assets', 'images', base.endsWith('.gif') ? base : `${base}.gif`));
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neogif-'));
  const frames = [];

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 860 } })).newPage();
    await scenario.run(makeHelpers(page, frames, framesDir));
  } finally {
    await browser.close();
  }

  if (!frames.length) {
    console.error('no frames captured');
    process.exit(1);
  }
  fs.writeFileSync(path.join(framesDir, 'manifest.json'), JSON.stringify(frames), 'utf8');

  const width = Number(getOpt('width', 900));
  const cropW = argv.includes('--crop-w') ? Number(getOpt('crop-w', '0')) : (scenario.cropW || 0);
  execFileSync(PYTHON, ['-c', PY_BUILD, framesDir, outPath, String(width), String(cropW)], { stdio: 'inherit' });

  if (KEEP_FRAMES) {
    console.log('frames kept at', framesDir);
  } else {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
