// UI polish 2 test (V1-V10): result tables wrap on desktop and become one card
// per row on a phone, Enter in the hero search opens Search & Discovery and
// runs a search, and the six group tiles use inline SVG icons instead of emoji.
//
// Run: node tools/ui_polish_2_test.js
//
// CSS-source check: index.html's <style> block is read as text, comments are
// dropped and the @media blocks are split off by brace matching. This is NOT a
// layout test. V9 runs the real Enter handler source in a node:vm sandbox.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const rawStyle = html.slice(styleStart + styleOpen[0].length, styleEnd);
const style = rawStyle.replace(/\/\*[^]*?\*\//g, "");

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
const has = (d, prop) => new RegExp("(^|;)" + prop.replace(/[()%.*+?[\]^$|]/g, "\\$&") + "(;|$)").test(d);
const hasAll = (d, props) => props.every(p => has(d, p));
// Whitespace-free text so adjacency can be checked with indexOf.
const flat = s => s.replace(/\s+/g, "");

const MOBILE_HEAD = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/;
const base = mediaSplit(style, /@media[^{]*\{/).rest;
const mobileSplit = mediaSplit(style, MOBILE_HEAD);
if (mobileSplit.bodies.length !== 1) refuse("exactly one @media(max-width:768px) block");
const mobile = mobileSplit.bodies[0];
const rawMobileSplit = mediaSplit(rawStyle, MOBILE_HEAD);
if (rawMobileSplit.bodies.length !== 1) refuse("exactly one raw @media(max-width:768px) block");
const rawMobile = rawMobileSplit.bodies[0];
const fbase = flat(base);
const fmobile = flat(mobile);
if (!decls(base, ".sortind")) refuse("the base .sortind rule");
if (!decls(base, ".card .ic")) refuse("the base .card .ic rule");
if (fmobile.indexOf(".dl-group.qfilter,.dl-group.phasefilter{width:auto;font-size:1rem}") < 0)
  refuse("the mobile .dl-group .qfilter,.dl-group .phasefilter rule");

const scriptOpen = html.indexOf('"use strict";');
if (scriptOpen < 0) refuse("the main script");
const script = html.slice(scriptOpen);
if (script.indexOf("window.__close=closeModal;") < 0) refuse("window.__close=closeModal;");
if (script.indexOf("// group config:") < 0) refuse("the // group config: comment");
const otStart = script.indexOf("function objTable(");
if (otStart < 0) refuse("function objTable");
const otEnd = script.indexOf("\nfunction ", otStart + 1);
const objTable = script.slice(otStart, otEnd < 0 ? undefined : otEnd);
const heroTag = (/<input\b[^>]*\bid="heroQuery"[^>]*>/.exec(html) || [])[0];
if (!heroTag) refuse("the #heroQuery input");

// V1
const rtd = decls(base, ".results td"), rtd1 = decls(base, ".results td:first-child");
check("V1 base .results td wraps (\"" + rtd + "\"), first column stays nowrap (\"" + rtd1 +
  "\"), right after .sortind; global th,td keeps nowrap",
  hasAll(rtd, ["white-space:normal", "overflow-wrap:break-word", "min-width:4.5rem", "vertical-align:top"]) &&
  hasAll(rtd1, ["white-space:nowrap", "min-width:0"]) &&
  /\.sortind\{[^{}]*\}\.resultstd\{[^{}]*\}\.resultstd:first-child\{/.test(fbase) &&
  has(decls(base, "th"), "white-space:nowrap") && /(^|\})th,td\{[^{}]*white-space:nowrap/.test(fbase));

// V2
const tdTags = objTable.match(/<td\b[^>]*>/g) || [];
check("V2 objTable row cells carry data-label=\"${esc(c)}\" (td tags: " + JSON.stringify(tdTags) + ")",
  tdTags.length === 1 && tdTags[0] === '<td data-label="${esc(c)}">');

// V3
const cardComment = /\.dl-group \.qfilter,\s*\.dl-group \.phasefilter\{width:auto;font-size:1rem\}\s*\n\s*\/\*[^\n]*?\*\/\s*\n\s*\.results table\{/;
const thPill = decls(mobile, ".results th");
check("V3 768px block: result tables become cards (one-line comment, rules right after the .dl-group filter rule; th \"" +
  thPill + "\")",
  cardComment.test(rawMobile) &&
  /\/\*[^\n*]*one card per row on a phone[^\n*]*\*\//.test(rawMobile) &&
  fmobile.indexOf(".dl-group.qfilter,.dl-group.phasefilter{width:auto;font-size:1rem}.resultstable{") >= 0 &&
  hasAll(decls(mobile, ".results table"), ["display:block", "overflow-x:visible"]) &&
  [".results thead", ".results tbody", ".results tr", ".results td"].every(s => has(decls(mobile, s), "display:block")) &&
  hasAll(decls(mobile, ".results thead tr"), ["display:flex", "flex-wrap:wrap", "gap:.35rem", "margin-bottom:.6rem"]) &&
  hasAll(thPill, ["display:inline-flex", "align-items:center", "min-height:44px", "padding:0.75rem",
    "border:1pxsolidrgba(255,255,255,.14)", "border-radius:999px", "background:rgba(0,0,0,.25)", "font-size:.8rem"]) &&
  hasAll(decls(mobile, ".results tbody tr"), ["border:1pxsolidrgba(255,255,255,.08)", "border-radius:.6rem",
    "background:rgba(0,0,0,.18)", "padding:.5rem.75rem", "margin-bottom:.5rem"]) &&
  hasAll(decls(mobile, ".results td"), ["padding:.15rem0", "border-bottom:0", "min-width:0", "white-space:normal"]) &&
  hasAll(decls(mobile, ".results td::before"), ["content:attr(data-label)", "display:inline-block", "margin-right:.5rem",
    "color:#9aa4bf", "font-size:.75rem", "font-weight:600"]));

// V4
const heroAttrs = heroTag.match(/\s[a-z-]+=/g) || [];
check("V4 #heroQuery has enterkeyhint=\"search\" and nothing else changed (" + heroAttrs.length + " attributes)",
  /\senterkeyhint="search"/.test(heroTag) && heroAttrs.length === 4 &&
  /\stype="text"/.test(heroTag) && /\splaceholder="Disease, drug, or NCT ID /.test(heroTag));

// V5
const KEY_START = '$("#heroQuery").addEventListener("keydown"';
const kStart = script.indexOf(KEY_START);
const kEnd = kStart < 0 ? -1 : script.indexOf("\n});", kStart);
const keyBlock = kStart < 0 || kEnd < 0 ? "" : script.slice(kStart, kEnd + 4);
const expectedKey = '$("#heroQuery").addEventListener("keydown",e=>{' +
  'if(e.key!=="Enter"||e.isComposing)return;' +
  "e.preventDefault();" +
  "const v=e.target.value.trim();" +
  'openGroup("search-discovery");' +
  'if(v)run("search-discovery","search");' +
  "});";
check("V5 Enter handler right after window.__close=closeModal; with a comment above it, exact body",
  /window\.__close=closeModal;\n(\/\/[^\n]*\n)+\$\("#heroQuery"\)\.addEventListener\("keydown"/.test(script) &&
  flat(keyBlock) === flat(expectedKey));

// V6
const giLine = (/^const GI=d=>`[^\n]*`;$/m.exec(script) || [])[0] || null;
const iconsStart = script.indexOf("const ICONS={");
const iconsEnd = iconsStart < 0 ? -1 : script.indexOf("\n};", iconsStart);
const iconsSrc = iconsStart < 0 || iconsEnd < 0 ? "" : script.slice(iconsStart, iconsEnd + 3);
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  scale: '<path d="M12 3v18M8 21h8M4 7h16M4 7l-3 7h6zM20 7l-3 7h6z"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};
const GI_OPEN = '<svg class="gi" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
let icons = null;
if (giLine && iconsSrc) {
  try {
    const sb = {};
    vm.runInNewContext(giLine + "\n" + iconsSrc + "\nthis.ICONS=ICONS;", sb);
    icons = sb.ICONS;
  } catch (e) { icons = null; }
}
const gcIdx = script.indexOf("// group config:");
check("V6 GI + ICONS defined right before // group config: with a comment above; six icons render the given paths",
  !!giLine && !!icons &&
  /\n\/\/[^\n]*\nconst GI=d=>/.test(script) &&
  script.indexOf(giLine) < iconsStart && /^\s*$/.test(script.slice(iconsEnd + 3, gcIdx)) &&
  JSON.stringify(Object.keys(icons)) === JSON.stringify(Object.keys(ICON_PATHS)) &&
  Object.keys(ICON_PATHS).every(k => icons[k] === GI_OPEN + ICON_PATHS[k] + "</svg>"));

// V7
const GROUP_ICONS = { "search-discovery": "search", "trial-analysis": "pulse", "comparison": "scale",
  "recruiting-watch": "clipboard", "data-management": "database", "system": "sliders" };
const gStart = script.indexOf("const GROUPS = {");
const groupsSrc = gStart < 0 ? "" : script.slice(gStart, script.indexOf("\n};", gStart));
const strIcons = groupsSrc.match(/\bicon:\s*["'`]/g) || [];
check("V7 the six GROUPS icons are ICONS.* references (string-literal icons left: " + strIcons.length + ")",
  !!groupsSrc && strIcons.length === 0 &&
  Object.keys(GROUP_ICONS).every(g => groupsSrc.indexOf('"' + g + '":{icon:ICONS.' + GROUP_ICONS[g] + ",") >= 0));

// V8
const ic = decls(base, ".card .ic");
check("V8 .card .ic gets color var(--c) and line-height 1 (\"" + ic + "\"); .gi sizing rules right after it",
  hasAll(ic, ["font-size:2.6rem", "margin-bottom:.7rem", "color:var(--c)", "line-height:1"]) &&
  /\.card\.ic\{[^{}]*\}\.card\.ic\.gi\{[^{}]*\}\.modal-headh2\.gi\{/.test(fbase) &&
  hasAll(decls(base, ".card .ic .gi"), ["width:2.6rem", "height:2.6rem", "display:block"]) &&
  hasAll(decls(base, ".modal-head h2 .gi"), ["width:1.2em", "height:1.2em", "vertical-align:-.2em", "margin-right:.2em"]));

// V9
function behaviour() {
  if (!keyBlock) return "keydown block not found";
  const calls = { sel: [], type: [], open: [], run: [] };
  let handler = null;
  const sb = {
    $: s => { calls.sel.push(s); return { addEventListener: (t, fn) => { calls.type.push(t); handler = fn; } }; },
    openGroup: g => calls.open.push(g),
    run: (g, c) => calls.run.push([g, c]),
  };
  try { vm.runInNewContext(keyBlock, sb); } catch (e) { return "block threw: " + e.message; }
  if (typeof handler !== "function" || calls.sel[0] !== "#heroQuery" || calls.type[0] !== "keydown")
    return "no keydown listener on #heroQuery";
  function press(key, value, composing) {
    calls.open = []; calls.run = [];
    let prevented = 0;
    handler({ key: key, isComposing: !!composing, target: { value: value }, preventDefault: () => { prevented++; } });
    return { open: calls.open.slice(), run: calls.run.slice(), prevented: prevented };
  }
  const empty = press("Enter", "");
  if (empty.open.length !== 1 || empty.open[0] !== "search-discovery" || empty.run.length !== 0 || empty.prevented !== 1)
    return "Enter + empty: " + JSON.stringify(empty);
  const full = press("Enter", " diabetes ");
  if (full.open.length !== 1 || full.open[0] !== "search-discovery" || full.run.length !== 1 ||
    JSON.stringify(full.run[0]) !== '["search-discovery","search"]' || full.prevented !== 1)
    return "Enter + text: " + JSON.stringify(full);
  const other = press("a", "diabetes");
  if (other.open.length || other.run.length || other.prevented) return "key a: " + JSON.stringify(other);
  const ime = press("Enter", "diabetes", true);
  if (ime.open.length || ime.run.length || ime.prevented) return "Enter while composing: " + JSON.stringify(ime);
  return "";
}
const why = behaviour();
check("V9 behaviour: Enter opens Search & Discovery, runs search only with text, ignores other keys and IME composition" +
  (why ? " (" + why + ")" : ""), why === "");

// V10 guard
const prefixed = (style.match(/-webkit-backdrop-filter:/g) || []).length;
const plain = (style.match(/(^|[^-])backdrop-filter:/g) || []).length;
check("V10 guard: .dl-trigger keeps min-height:44px; -webkit-backdrop-filter " + prefixed + " = backdrop-filter " + plain +
  "; GI template " + (giLine ? "has aria-hidden=\"true\" and no style=" : "absent"),
  has(decls(base, ".dl-trigger"), "min-height:44px") && prefixed > 0 && prefixed === plain &&
  (giLine === null || (giLine.indexOf('aria-hidden="true"') >= 0 && giLine.indexOf("style=") < 0)));

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
