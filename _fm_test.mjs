// temp test for formatInline infinite-loop fix (delete after)
function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatInline(text) {
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === "`") {
            const end = text.indexOf("`", i + 1);
            if (end !== -1) { out += "<code>" + escapeHtml(text.slice(i + 1, end)) + "</code>"; i = end + 1; continue; }
        }
        if (ch === "[") {
            const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
            if (m) {
                let url = m[2];
                if (!/^(https?:|mailto:|#|\/)/i.test(url)) url = "#";
                out += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + formatInline(m[1]) + "</a>";
                i += m[0].length; continue;
            }
        }
        if (text.startsWith("**", i)) {
            const end = text.indexOf("**", i + 2);
            if (end !== -1) { out += "<strong>" + formatInline(text.slice(i + 2, end)) + "</strong>"; i = end + 2; continue; }
        }
        if (ch === "*" || ch === "_") {
            const end = text.indexOf(ch, i + 1);
            if (end !== -1) { out += "<em>" + formatInline(text.slice(i + 1, end)) + "</em>"; i = end + 1; continue; }
        }
        let j = i;
        while (j < n && text[j] !== "`" && text[j] !== "[" && text[j] !== "*" && text[j] !== "_") j++;
        if (j === i) { out += escapeHtml(text[i]); i++; }
        else { out += escapeHtml(text.slice(i, j)); i = j; }
    }
    return out;
}

const cases = [
  ["trigger-words: [minimalist product ad, premium]", "bare bracket"],
  ["unmatched * star here", "single unmatched asterisk"],
  ["code ` no close backtick", "unclosed backtick"],
  ["a ** bold and _em_ and [link](http://x.com) ok", "normal mixed inline"],
  ["[[[ nested brackets", "multiple bare brackets"],
  ["price is $5 and 100% *emphasis* done", "percent + em"],
  ["underscore _ alone and _two words_", "underscore cases"],
];
for (const [t, label] of cases) {
  const r = formatInline(t);
  console.log(label, "=>", r);
}
console.log("ALL_OK");
