// Load the REAL marked.min.js from the plugin and render the user's markdown
let mod = require("./web/marked.min.js");
const parse = (mod && typeof mod.parse === "function") ? mod.parse.bind(mod)
  : (mod && mod.marked && typeof mod.marked.parse === "function") ? mod.marked.parse.bind(mod.marked)
  : null;
if (!parse) { console.log("marked export shape:", Object.keys(mod || {}), typeof mod); process.exit(2); }

const md = [
  "- [ ] **TikTok / Reels / Shorts** (Vertical 9:16)",
  "- [ ] **YouTube / Bilibili** (Horizontal 16:9)",
  "- [x] done item"
].join("\n");

const html = parse(md, { gfm: true, breaks: true });
console.log("=== marked output ===");
console.log(html);
console.log("=== has <input>:", /<input/.test(html), "===");