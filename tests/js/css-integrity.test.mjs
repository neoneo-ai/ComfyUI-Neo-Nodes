// CSS 结构完整性守卫：用 postcss 逐个解析 web/ 下的 .css，捕获未闭合块 / 语法错误。
// 这类错误在浏览器里是「静默」的——不报错、不白屏，只会让后续规则悄悄失效（级联被污染），
// 极难定位。postcss.parse 对真正的结构错误会抛 CssSyntaxError，正好在这里把它拦成红灯。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

test("web/*.css 均为结构合法的 CSS（无未闭合块 / 语法错误）", async () => {
    const cssFiles = fs.readdirSync(webDir).filter((f) => f.endsWith(".css")).sort();
    assert.ok(cssFiles.length > 0, `未在 ${webDir} 找到 .css 文件`);

    const errors = [];
    for (const name of cssFiles) {
        const file = path.join(webDir, name);
        try {
            await postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
        } catch (e) {
            const loc = e.line ? `（第 ${e.line} 行，第 ${e.column} 列）` : "";
            errors.push(`${name}${loc}: ${e.reason || e.message}`);
        }
    }

    assert.deepEqual(errors, [], "存在结构非法的 CSS：\n" + errors.join("\n"));
});
