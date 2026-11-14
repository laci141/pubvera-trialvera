// UI polish test (U1-U12): hero h1, key row grid, key hint, wide result modal,
// 44 px touch targets, toolbar filter sizing, auth hit area, mobile blur and
// reduced motion.
//
// Run: node tools/ui_polish_test.js
//
// CSS-source check: index.html's <style> block is read as text, comments are
// dropped and the @media blocks are split off by brace matching. This is NOT a
// layout test.
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
function refuse(what) {
  console.error("FAIL: " + what + " not found in index.html - refusing to pass silently");
  process.exit(1);
}

const styleOpen = /<style\b[^>]*>/.exec(html);
const styleStart = styleOpen ? styleOpen.index : -1;
const styleEnd = html.indexOf("</style>");
if (styleStart < 0 || styleEnd < styleStart) refuse("the <style> block");
const style = html.slice(styleStart + styleOpen[0].length, styleEnd).replace(/\/\*[^]*?\*\//g, "");

// Bodies of every @media block whose head matches headRe (brace-matched), the
// index just past each block, plus the CSS left without them.
function mediaSplit(css, headRe) {
  const re = new RegExp(headRe.source, "g");
  const bodies = [], ends = [];
  let rest = "", last = 0, m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    bodies.push(css.slice(re.lastIndex, i - 1));
    ends.push(i);
    rest += css.slice(last, m.index);
    last = i;
    re.lastIndex = i;
  }
  return { bodies: bodies, ends: ends, rest: rest + css.slice(last) };
}
// Declarations of every rule whose selector list contains `sel`, joined with
// ";" and without whitespace.
function decls(css, sel) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim()).includes(sel))
    .map(m => m[2]).join(";").replace(/\s+/g, "");
}
const has = (d, prop) => new RegExp("(^|;)" + prop.replace(/[()%.]/g, "\\$&") + "(;|$)").test(d);
const hasAll = (d, props) => props.every(p => has(d, p));
// Whitespace-free CSS so adjacency can be checked with indexOf.
const flat = s => s.replace(/\s+/g, "");

const base = mediaSplit(style, /@media[^{]*\{/).rest;
const mobileSplit = mediaSplit(style, /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/);
if (mobileSplit.bodies.length !== 1) refuse("exactly one @media(max-width:768px) block");
const mobile = mobileSplit.bodies[0];
const reduced = mediaSplit(style, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/).bodies.join("\n");
const fbase = flat(base);
const fmobile = flat(mobile);
if (!decls(base, ".hero p")) refuse("the base .hero p rule");
if (!decls(base, ".modal-content")) refuse("the base .modal-content rule");
if (!decls(base, ".phasefilter:focus")) refuse("the base .phasefilter:focus rule");
if (!decls(base, ".auth-btn:hover")) refuse("the base .auth-btn:hover rule");

// U1
const h1s = html.match(/<h1\b/g) || [];
check("U1 exactly one <h1>Trialvera</h1>, first child of section.hero, before the p (h1 count " + h1s.length + ")",
  h1s.length === 1 && /<section class="hero">\s*<h1>Trialvera<\/h1>\s*<p>/.test(html));

// U2
const heroH1 = decls(base, ".hero h1");
const iH1 = fbase.indexOf(".heroh1{"), iP = fbase.indexOf(".herop{");
check("U2 .hero h1 rule before .hero p; mobile .hero h1 1.7rem and .hero p 1rem / 1.4rem (\"" + heroH1 + "\")",
  hasAll(heroH1, ["font-size:2.2rem", "font-weight:800", "line-height:1.2", "letter-spacing:-.02em", "color:#e8eef7",
    "margin-bottom:.6rem", "text-shadow:01px6pxrgba(0,0,0,.55)"]) &&
  iH1 >= 0 && iH1 < iP &&
  has(decls(mobile, ".hero h1"), "font-size:1.7rem") &&
  hasAll(decls(mobile, ".hero p"), ["font-size:1rem", "margin-bottom:1.4rem"]));

// U3
const keyrow = decls(base, ".keyrow");
check("U3 .keyrow is a 2fr 1.3fr 1.3fr grid, gap and margin-top kept; mobile 1fr (\"" + keyrow + "\")",
  hasAll(keyrow, ["display:grid", "grid-template-columns:2fr1.3fr1.3fr", "gap:.6rem", "margin-top:.8rem"]) &&
  !/display:flex|flex-direction/.test(keyrow) &&
  has(decls(mobile, ".keyrow"), "grid-template-columns:1fr"));

// U4
const keyhint = decls(base, ".keyhint");
check("U4 .keyhint font-size .8rem, line-height 1.5, colour #bdbdbd (\"" + keyhint + "\")",
  hasAll(keyhint, ["font-size:.8rem", "line-height:1.5", "color:#bdbdbd"]) && !/font-size:\.7rem/.test(keyhint));

// U5
const mc = decls(base, ".modal-content");
check("U5 .modal-content:has(#res table){width:1280px} right after .modal-content, max-width:96% kept",
  /\.modal-content\{[^{}]*\}\.modal-content:has\(#restable\)\{width:1280px\}/.test(fbase) && has(mc, "max-width:96%"));

// U6
const x = decls(base, ".x");
check("U6 .x is a 44 px inline-flex target (\"" + x + "\")",
  hasAll(x, ["min-width:44px", "min-height:44px", "display:inline-flex", "align-items:center",
    "justify-content:center", "flex-shrink:0"]));

// U7
const back = decls(base, ".backbtn");
check("U7 .backbtn has min-height:44px (\"" + back + "\")", has(back, "min-height:44px"));

// U8
const gq = decls(base, ".dl-group .qfilter"), gp = decls(base, ".dl-group .phasefilter");
const common = ["min-height:44px", "padding:4px14px", "font-size:.85rem", "border-radius:999px"];
check("U8 .dl-group .qfilter/.phasefilter 44 px pills right after .phasefilter:focus; mobile width:auto 1rem (" +
  "q \"" + gq + "\", p \"" + gp + "\")",
  hasAll(gq, common.concat(["width:190px"])) && hasAll(gp, common.concat(["width:auto"])) &&
  /\.phasefilter:focus\{[^{}]*\}\.dl-group\.qfilter,\.dl-group\.phasefilter\{/.test(fbase) &&
  /\.qfilter,\.phasefilter\{[^{}]*\}\.dl-group\.qfilter,\.dl-group\.phasefilter\{[^{}]*width:auto[^{}]*font-size:1rem/.test(fmobile));

// U9
const ab = decls(base, ".auth-bar .auth-btn"), after = decls(base, ".auth-bar .auth-btn::after");
check("U9 .auth-bar .auth-btn::after widens the hit area, right after .auth-btn:hover (\"" + after + "\")",
  has(ab, "position:relative") &&
  hasAll(after, ["content:\"\"", "position:absolute", "left:0", "right:0", "top:-12px", "bottom:-16px"]) &&
  /\.auth-btn:hover\{[^{}]*\}\.auth-bar\.auth-btn\{position:relative\}\.auth-bar\.auth-btn::after\{/.test(fbase));

// U10
const blurSels = [".errcard", ".search-box", ".card", ".ai-panel", ".filtered-section"];
check("U10 mobile blur is 11px on " + blurSels.join(" ") + "; no blur(10px) left",
  html.indexOf("blur(10px)") < 0 &&
  blurSels.every(s => hasAll(decls(mobile, s), ["-webkit-backdrop-filter:blur(11px)", "backdrop-filter:blur(11px)"])));

// U11
const after768 = style.slice(mobileSplit.ends[0]).trimStart();
check("U11 prefers-reduced-motion block right after the 768px block; .spin keeps its animation",
  /^@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/.test(after768) &&
  has(decls(reduced, "html"), "scroll-behavior:auto") &&
  [".modal", ".modal-content", ".results"].every(s => has(decls(reduced, s), "animation:none")) &&
  [".card", ".btn", ".search-box"].every(s => has(decls(reduced, s), "transition:none")) &&
  [".card:hover", ".btn:hover", ".btn:active"].every(s => has(decls(reduced, s), "transform:none")) &&
  !decls(reduced, ".spin") && /animation:spin/.test(decls(base, ".spin")));

// U12 guard
const prefixed = (style.match(/-webkit-backdrop-filter:/g) || []).length;
const plain = (style.match(/(^|[^-])backdrop-filter:/g) || []).length;
check("U12 guard: .dl-trigger keeps min-height:44px; -webkit-backdrop-filter " + prefixed + " = backdrop-filter " + plain,
  has(decls(base, ".dl-trigger"), "min-height:44px") && prefixed > 0 && prefixed === plain);

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
