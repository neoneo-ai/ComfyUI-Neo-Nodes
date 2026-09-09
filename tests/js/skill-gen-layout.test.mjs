// Playwright 渲染验证：在真实浏览器里确认技能详情弹窗的出图设置布局。
// postcss（css-integrity.test.mjs）只查 CSS 结构是否合法；这里补上"规则是否真的按预期渲染"：
//   model / LoRA / 尺寸区(张数·长边·比例) / 折叠区(Text Encoder·VAE·输出前缀) → 标签左 | 控件右（两栏 grid）
//   LoRA 行                              → 标签 | 动态列表 | 「+ 添加」（三栏 grid）
//   出图张数 / 长边尺寸 / 默认比例 / 输出前缀 → 标签左 | 控件右（两栏 grid）
// DOM 结构按 skill.js / image-gen.js 生成的 class 复刻，CSS 用真实的 web/prompts.css。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const css = fs.readFileSync(path.join(webDir, "prompts.css"), "utf8");

// 复刻 .rs-skill-gen-settings（skill.js genSettingsWrap）内部结构；class 与源码一致
const harnessDom = `
<div class="rs-skill-modal-overlay" style="display:block; position:static;">
  <div class="rs-skill-modal rs-skill-detail" style="width:640px;">
    <div class="rs-skill-modal-content">
      <div class="rs-gen-settings rs-skill-gen-settings">
        <div class="rs-config-row rs-gen-settings-header"><label class="rs-form-label">🖼️ 出图设置（优先于默认设置）</label></div>
        <div class="rs-gen-model-section">
          <div class="rs-config-row"><label class="rs-form-label">Model</label><select></select></div>
          <div class="rs-config-row"><label class="rs-form-label">LoRA</label><div class="rs-gen-lora-list"></div><button type="button" class="rs-gen-lora-add">+ 添加 LoRA</button></div>
        </div>
        <div class="rs-gen-size-section">
          <div class="rs-config-row"><label class="rs-form-label">长边尺寸</label><select></select></div>
          <div class="rs-config-row"><label class="rs-form-label">默认比例</label><select></select></div>
        </div>
        <details class="rs-gen-advanced" open>
          <summary class="rs-gen-advanced-summary">Text Encoder / VAE / 出图张数 / 输出前缀（高级）</summary>
          <div class="rs-gen-adv-content">
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">Text Encoder</label><select></select></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">VAE</label><select></select></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">出图张数</label><input class="rs-form-input" type="number"></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">输出前缀</label><input class="rs-form-input" type="text"></div>
          </div>
        </details>
      </div>
    </div>
  </div>
</div>`;

test("技能弹窗出图设置：各配置行标签左|控件右（模型/LoRA/折叠区/尺寸）", async (t) => {
    let browser;
    try {
        browser = await chromium.launch();
    } catch (e) {
        t.skip("chromium 未安装：先运行 npx playwright install chromium");
        return;
    }
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
        await page.setContent(
            `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${harnessDom}</body></html>`,
            { waitUntil: "load" },
        );

        const r = await page.evaluate(() => {
            const colsOf = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return -1;
                const s = getComputedStyle(el);
                return s.display === "grid" ? s.gridTemplateColumns.split(" ").filter(Boolean).length : -1;
            };
            const summary = document.querySelector(".rs-gen-advanced > summary");
            const advBox = document.querySelector(".rs-gen-advanced");
            return {
                model: colsOf(".rs-skill-gen-settings .rs-gen-model-section > .rs-config-row"),
                adv: colsOf(".rs-skill-gen-settings .rs-gen-adv-row"),
                lora: colsOf(".rs-skill-gen-settings .rs-gen-model-section > .rs-config-row:last-child"),
                size: colsOf(".rs-skill-gen-settings .rs-gen-size-section > .rs-config-row"),
                summaryNarrow: !!(summary && advBox &&
                    summary.getBoundingClientRect().width < advBox.getBoundingClientRect().width - 1),
            };
        });

        assert.equal(r.model, 2, `Model 行应为两栏（label | 控件），实际 ${r.model}`);
        assert.equal(r.adv, 2, `折叠区内 Text Encoder/VAE 行应为两栏，实际 ${r.adv}`);
        assert.equal(r.lora, 3, `LoRA 行应为三栏（label | 列表 | 添加按钮），实际 ${r.lora}`);
        assert.equal(r.size, 2, `尺寸区各行（张数/长边/比例）应为两栏，实际 ${r.size}`);
        assert.ok(r.summaryNarrow, "折叠标题应只占文字宽度（仅点标题展开），不应铺满整行");
    } finally {
        if (browser) await browser.close();
    }
});
