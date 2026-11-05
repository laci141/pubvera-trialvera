// No inline style attributes test (CSP style S0).
//
// Run: node tools/no_inline_styles_test.js
//
// A Content-Security-Policy with style-src-attr 'none' drops every style=
// attribute, including ones inserted through innerHTML, so index.html must
// carry none, neither in markup nor in HTML built inside JS strings. Static
// looks live in <style> classes; dynamic values ride on data-* attributes and
// are set through CSSOM (el.style.setProperty / el.style.x, which CSP does not
// block) by small apply functions that run right after the innerHTML
// assignment. Checks (HTML comments blanked first, line numbers kept):
//   S1 no style= attribute anywhere, script strings included;
//   S2 no setAttribute("style"), no .cssText, no insertAdjacentHTML with style=;
//   S3 the replacement classes have rules in <style> (doubled where an existing
//      rule would otherwise outrank them);
//   S4 the templates emit data-cols / data-p / data-sc / data-color;
//   S5 the apply functions exist and are called after the matching innerHTML;
//   S6 run in a vm stub: valid values are applied, non-finite numbers and bad
//      colours are skipped, and only the given scope is queried.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const raw = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
if (!/<script\b/.test(raw)) {
  console.error("FAIL: no <script> found in index.html - refusing to pass silently");
  process.exit(1);
}
const styleStart = raw.indexOf("<style>");
const styleEnd = raw.indexOf("</style>");
if (styleStart < 0 || styleEnd < styleStart) {
  console.error("FAIL: no <style> block found in index.html - refusing to pass silently");
  process.exit(1);
}
const html = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
const css = raw.slice(styleStart + "<style>".length, styleEnd).replace(/\/\*[\s\S]*?\*\//g, "");
const lineOf = i => html.slice(0, i).split("\n").length;

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Source of a top-level `function name(...){...}` by brace matching; "" if absent.
function fnSource(name) {
  const m = new RegExp("function " + name + "\\s*\\(").exec(html);
  if (!m) return "";
  let i = html.indexOf("{", m.index), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}" && --depth === 0) return html.slice(m.index, j + 1);
  }
  return "";
}

// ── S1: no style= attribute (an escaped quote or a bare value counts too) ──
const attrs = [...html.matchAll(/\bstyle\s*=(?!=)/gi)];
check("S1 no style= attribute in index.html (found " + attrs.length + ")", attrs.length === 0);
for (const m of attrs) console.log("      L" + lineOf(m.index) + ": " + html.slice(m.index, m.index + 40).split("\n")[0]);

// ── S2: no other way of writing an inline style string ──
const setAttr = [...html.matchAll(/setAttribute\s*\(\s*["'`]style["'`]/gi)];
const cssText = [...html.matchAll(/\.cssText\b/g)];
const adjacent = [...html.matchAll(/insertAdjacentHTML\s*\([^\n]*style\s*=/gi)];
check("S2 no setAttribute('style') / .cssText / insertAdjacentHTML with style= (found " +
  setAttr.length + "/" + cssText.length + "/" + adjacent.length + ")",
  setAttr.length + cssText.length + adjacent.length === 0);

// ── S3: replacement classes have rules in <style> ──
const rules = ["\\.u-empty", "\\.u-rhead\\.u-rhead", "\\.u-score-row", "\\.u-compare-grid", "\\.u-side-h4",
  "\\.u-factors", "\\.u-badge", "\\.u-badge-results", "\\.u-muted", "\\.u-more", "\\.u-nested-h3\\.u-nested-h3"];
const missingRules = rules.filter(r => !new RegExp(r + "(?![\\w-])[^{}]*\\{").test(css));
check("S3 every replacement class has a <style> rule (missing: " + (missingRules.join(" ") || "none") + ")",
  missingRules.length === 0);

// ── S4: dynamic values are emitted as data-* attributes ──
const tryRowSrc = (/const tryRow=[\s\S]*?\n  \};/.exec(html) || [""])[0];
check("S4a tryRow emits data-cols on .trygrid", /class="trygrid" data-cols="\$\{cols\}"/.test(tryRowSrc));
check("S4b the score ring emits data-p and data-sc", /class="score" data-p="\$\{pc\}" data-sc="\$\{col\}"/.test(fnSource("renderBody")));
check("S4c statusBadge emits data-color on .u-badge", /class="u-badge" data-color="'\+c\+'"/.test(fnSource("statusBadge")));

// ── S5: apply functions exist and run after the matching innerHTML ──
const applyNames = ["applyTryCols", "applyScoreRing", "applyBadgeColors"];
const missingFns = applyNames.filter(n => !fnSource(n));
check("S5a apply functions defined (missing: " + (missingFns.join(" ") || "none") + ")", missingFns.length === 0);
const rf = fnSource("renderFields");
const lastBox = rf.lastIndexOf("box.innerHTML");
const tryCall = rf.lastIndexOf("applyTryCols(box)");
check("S5b renderFields calls applyTryCols(box) after its last box.innerHTML", lastBox >= 0 && tryCall > lastBox);
const assign = html.indexOf("res.innerHTML=renderResult(");
const tail = assign >= 0 ? html.slice(assign, html.indexOf("}catch", assign)) : "";
check("S5c applyScoreRing(res) and applyBadgeColors(res) follow res.innerHTML=renderResult(...)",
  assign >= 0 && /applyScoreRing\(res\)/.test(tail) && /applyBadgeColors\(res\)/.test(tail));

// ── S6: behaviour against a vm stub (no document in the sandbox) ──
function el(dataset) {
  const props = {};
  return { dataset, props, style: { setProperty(k, v) { props[k] = v; } } };
}
function scopeOf(els) {
  const s = { queried: [], querySelectorAll(sel) { s.queried.push(sel); return els; } };
  return s;
}
const helpers = (/const HEX6=[^\n]*/.exec(html) || [""])[0] + "\n" + fnSource("finiteNum") + "\n" +
  fnSource("isColor") + "\n";
let ctx = null;
if (!missingFns.length) {
  try {
    ctx = vm.createContext({});
    vm.runInContext(helpers + applyNames.map(fnSource).join("\n") +
      "\nthis.fns={applyTryCols,applyScoreRing,applyBadgeColors};", ctx);
  } catch (e) { console.log("      vm load error: " + e.message); ctx = null; }
}
function run(label, fn) {
  if (!ctx) { check(label + " (not run: apply functions missing)", false); return; }
  try { check(label, fn(ctx.fns)); } catch (e) { check(label + " (threw " + e.message + ")", false); }
}
run("S6a applyTryCols sets --cols for a finite count, skips NaN/Infinity/text/empty, queries only its scope", f => {
  const good = el({ cols: "6" }), bad = ["NaN", "Infinity", "abc", "", "6;color:red"].map(c => el({ cols: c }));
  const s = scopeOf([good, ...bad]);
  f.applyTryCols(s);
  return good.props["--cols"] === "6" && bad.every(b => !("--cols" in b.props)) &&
    s.queried.length === 1 && /trygrid/.test(s.queried[0]);
});
run("S6b applyScoreRing sets --p and --sc for valid values, skips non-finite --p and bad colours", f => {
  const good = el({ p: "42", sc: "#ff6b6b" });
  const bad = [el({ p: "NaN", sc: "red" }), el({ p: "Infinity", sc: "#fff;x" }), el({ p: "x", sc: "url(a)" }),
    el({ p: "", sc: "#12345g" })];
  const s = scopeOf([good, ...bad]);
  f.applyScoreRing(s);
  return good.props["--p"] === "42" && good.props["--sc"] === "#ff6b6b" &&
    bad.every(b => !("--p" in b.props) && !("--sc" in b.props)) && s.queried.length === 1;
});
run("S6c applyBadgeColors applies #rrggbb fully, #rgb as colour only, skips anything else", f => {
  const six = el({ color: "#2fd6a6" }), three = el({ color: "#888" });
  const bad = ["red", "#12345", "#1234567", "#2fd6a6;x", "", "url(x)"].map(c => el({ color: c }));
  const s = scopeOf([six, three, ...bad]);
  f.applyBadgeColors(s);
  const st = six.style, t3 = three.style;
  return st.background === "#2fd6a622" && st.color === "#2fd6a6" && st.border === "1px solid #2fd6a655" &&
    t3.color === "#888" && t3.background === undefined && t3.border === undefined &&
    bad.every(b => b.style.background === undefined && b.style.color === undefined && b.style.border === undefined) &&
    s.queried.length === 1;
});

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
