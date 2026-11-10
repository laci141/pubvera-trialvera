// Grey (muted) text is readable on every surface it can sit on.
//
// Run: node tools/muted_text_test.js
//
// The muted text (summary, .fnote, .tryrow, .u-empty, .u-muted, .u-more, the
// AI panel meta, the filtered notes) was #888 and the footer #666. Measured in
// Chromium, #888 gives 4.42:1 on a result card, 4.03:1 on an error card and
// 3.39:1 on a compare card, #666 gives about 2.1:1 on the brightest part of the
// footer gradient, and the BYOK key hint (#707070, .7rem) 1.8:1 on the search
// box; WCAG 1.4.3 asks 4.5:1 for small text.
//   M1 no #888 and no #666 text colour is left in the stylesheet;
//   M2 every light pure-grey text colour in the stylesheet (r = g = b, above
//      #404040, so the black text on bright buttons is out; the footer is M3) is at least
//      4.5:1 on the LIGHTEST card surface, rgb(52,53,72) (.rcard.compare-side
//      over .modal-content, sampled from a real render). Exception: the modal
//      close button .x is 1.9rem, large text, so 3:1 applies to it;
//   M3 the footer colour is at least 4.5:1 on the brightest footer background
//      sampled at 1280 px, rgb(44,56,61);
//   M4 the key hint is at least 4.5:1 on the brightest search-box background
//      sampled at 390, 768 and 1280 px, rgb(64,75,92).
// A rule that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgb = h => h.length === 4 ? [1, 2, 3].map(i => parseInt(h[i] + h[i], 16)) : [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

const styleStart = html.indexOf("<style");
const styleEnd = html.indexOf("</style>", styleStart);
check("stylesheet found", styleStart >= 0 && styleEnd > styleStart);
const css = html.slice(styleStart, styleEnd);

check("M1 no color:#888 left (" + (css.match(/[^-]color:#888\b/g) || []).length + ")", !/[^-]color:#888\b/.test(css));
check("M1 no color:#666 left (" + (css.match(/[^-]color:#666\b/g) || []).length + ")", !/[^-]color:#666\b/.test(css));

// Every rule "selector{...}" whose body sets a text colour (not border-color,
// background-color, border-top-color ...).
const CARD = [52, 53, 72];
let greys = 0;
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(css)) !== null) {
  const sel = m[1].trim().split("\n").pop().trim();
  const c = m[2].match(/(?:^|[;\s])color:(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/);
  if (!c) continue;
  const col = rgb(c[1]);
  if (!(col[0] === col[1] && col[1] === col[2]) || col[0] <= 0x40 || sel === "footer") continue;
  greys++;
  const r = ratio(col, CARD);
  const min = sel === ".x" ? 3 : 4.5;
  check("M2 " + sel + " " + c[1] + " on the card " + r.toFixed(2) + ":1 >= " + min, r >= min);
}
check("M2 grey text rules found (" + greys + ")", greys >= 10);

const foot = css.match(/(^|\n)\s*footer\{([^}]*)\}/);
check("M3 footer rule found", !!foot);
const fc = foot && foot[2].match(/(?:^|[;\s])color:(#[0-9a-fA-F]{3,6})\b/);
const fr = fc ? ratio(rgb(fc[1]), [44, 56, 61]) : 0;
check("M3 footer " + (fc ? fc[1] : "?") + " on the footer gradient " + fr.toFixed(2) + ":1 >= 4.5", fr >= 4.5);

const kh = css.match(/(^|\n)\s*\.keyhint\{([^}]*)\}/);
check("M4 .keyhint rule found", !!kh);
const kc = kh && kh[2].match(/(?:^|[;\s])color:(#[0-9a-fA-F]{3,6})\b/);
const kr = kc ? ratio(rgb(kc[1]), [64, 75, 92]) : 0;
check("M4 .keyhint " + (kc ? kc[1] : "?") + " on the search box " + kr.toFixed(2) + ":1 >= 4.5", kr >= 4.5);

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
