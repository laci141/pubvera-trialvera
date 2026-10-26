// BYOK key storage test (B1-B12): the LLM key lives in sessionStorage by
// default, moves to localStorage only behind the "Remember key on this device"
// box, and "Forget key" clears it from both storages.
//
// Run: node tools/byok_storage_test.js
//
// Behaviour test without a browser. byokTry, byokStore, byokLoad and
// byokForget are cut out of index.html by a brace-balanced scan and run inside
// node:vm against Map-based fake storages. The markup, the .keyhint text and
// the wiring are asserted on source. Real page load, tab close and reload in a
// browser are NOT checked here. No key value is ever printed.
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
// A step that throws (missing function, old code) is a FAIL, not a crash.
// Only the error name is printed so a key can never reach the output.
function attempt(f) { try { return !!f(); } catch (e) { console.log("      note: threw " + (e && e.name)); return false; } }

// sliceFunction returns the text of "function <name>(...){ ... }" (plain brace
// depth count) or "" when it is missing.
function sliceFunction(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return "";
}

const names = ["byokTry", "byokStore", "byokLoad", "byokForget"];
const src = {};
names.forEach(n => { src[n] = sliceFunction(n); });
const missing = names.filter(n => src[n] === "");
if (missing.length) console.error("FAIL: function " + missing.join(", ") + " not found in index.html");
const sandbox = {};
vm.createContext(sandbox);
names.forEach(n => { if (src[n]) vm.runInContext(src[n], sandbox); });
const fn = n => { if (typeof sandbox[n] !== "function") throw new ReferenceError(n); return sandbox[n]; };

// Map-based Storage stand-in.
function fake(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    m: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}
// A storage whose every call throws, as private mode or blocked site data can.
const thrower = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};
const KEY = "test-key-0000-not-real";

check("B1 default save (remember off) puts ct_key in sessionStorage, not localStorage", attempt(() => {
  const ls = fake(), ss = fake();
  fn("byokStore")(KEY, false, ls, ss);
  return ss.m.get("ct_key") === KEY && !ls.m.has("ct_key") && !ls.m.has("ct_remember");
}));

check("B2 remember on puts ct_key and ct_remember=1 in localStorage (and none in sessionStorage)", attempt(() => {
  const ls = fake(), ss = fake({ ct_key: KEY });
  fn("byokStore")(KEY, true, ls, ss);
  return ls.m.get("ct_key") === KEY && ls.m.get("ct_remember") === "1" && !ss.m.has("ct_key");
}));

check("B3 turning remember off removes localStorage ct_key and ct_remember, key kept in sessionStorage", attempt(() => {
  const ls = fake({ ct_key: KEY, ct_remember: "1" }), ss = fake();
  fn("byokStore")(KEY, false, ls, ss);
  return !ls.m.has("ct_key") && !ls.m.has("ct_remember") && ss.m.get("ct_key") === KEY;
}));

const loadIIFE = (/\(function load\(\)\{[\s\S]*?\}\)\(\);/.exec(html) || [""])[0];
check("B4 migration: an existing localStorage ct_key loads, remember=true, ct_remember=1 set, key kept; load() checks the box", attempt(() => {
  const ls = fake({ ct_key: KEY, ct_provider: "zai" }), ss = fake();
  const r = fn("byokLoad")(ls, ss);
  const fresh = fn("byokLoad")(fake(), fake({ ct_key: KEY }));
  return r.key === KEY && r.remember === true && ls.m.get("ct_remember") === "1" && ls.m.get("ct_key") === KEY &&
    fresh.key === KEY && fresh.remember === false &&
    /byokLoad\(/.test(loadIIFE) && /\$\("#llmRemember"\)\.checked=/.test(loadIIFE);
}));

const forgetWire = (/\$\("#llmForget"\)\.addEventListener\("click",[\s\S]*?\}\);/.exec(html) || [""])[0];
check("B5 Forget removes ct_key from both storages and ct_remember, keeps ct_provider/ct_model; the click clears the input", attempt(() => {
  const ls = fake({ ct_key: KEY, ct_remember: "1", ct_provider: "zai", ct_model: "glm-x" }), ss = fake({ ct_key: KEY });
  fn("byokForget")(ls, ss);
  const after = fn("byokLoad")(ls, ss);
  return !ls.m.has("ct_key") && !ls.m.has("ct_remember") && !ss.m.has("ct_key") &&
    ls.m.get("ct_provider") === "zai" && ls.m.get("ct_model") === "glm-x" &&
    after.key === "" && after.remember === false &&
    /\$\("#llmKey"\)\.value=""/.test(forgetWire) && /byokForget\(/.test(forgetWire);
}));

check("B6 a storage that throws (or is missing) does not throw out of byokStore/byokLoad/byokForget", attempt(() => {
  const pairs = [[thrower, thrower], [null, null], [thrower, fake()], [fake(), thrower]];
  let ok = true;
  pairs.forEach(([ls, ss]) => {
    fn("byokStore")(KEY, false, ls, ss);
    fn("byokStore")(KEY, true, ls, ss);
    const r = fn("byokLoad")(ls, ss);
    fn("byokForget")(ls, ss);
    if (typeof r !== "object" || r === null || typeof r.key !== "string" || typeof r.remember !== "boolean") ok = false;
  });
  const r = fn("byokLoad")(thrower, thrower);
  return ok && r.key === "" && r.remember === false;
}));

const remTag = (/<input\b[^>]*\bid="llmRemember"[^>]*>/.exec(html) || [""])[0];
const forgetTag = (/<button\b[^>]*\bid="llmForget"[^>]*>([^<]*)<\/button>/.exec(html) || ["", ""]);
check("B7 #llmRemember is a checkbox with a <label for> \"Remember key on this device\"; #llmForget is a type=button \"Forget key\"",
  /\btype="checkbox"/.test(remTag) &&
  /<label\b[^>]*\bfor="llmRemember"[^>]*>Remember key on this device<\/label>/.test(html) &&
  /\btype="button"/.test(forgetTag[0]) && forgetTag[1] === "Forget key");

const hint = ((/<div class="keyhint">([\s\S]*?)<\/div>/.exec(html) || ["", ""])[1]).replace(/\s+/g, " ");
check("B8 .keyhint: tab-only default, Remember, Forget key, query and results go to the chosen provider, not logged, not medical advice",
  /only for this tab/.test(hint) && /tab closes/.test(hint) && /\bRemember\b/.test(hint) && /Forget key/.test(hint) &&
  /query/.test(hint) && /result/.test(hint) && /provider you choose/.test(hint) &&
  /never logged/i.test(hint) && /not medical advice/.test(hint) && !/\(localStorage\)/.test(hint));

const store = src.byokStore;
const split = store.indexOf("}else{");
const rememberPath = split >= 0 ? store.slice(0, split) : "";
const defaultPath = split >= 0 ? store.slice(split) : "";
const inputWire = (/\$\("#llmKey"\)\.addEventListener\("input",[^\n]*/.exec(html) || [""])[0];
check("B9 no localStorage.setItem(\"ct_key\" anywhere; ls.setItem(\"ct_key\" only in byokStore's remember branch; the input listener goes through byokStore",
  !/localStorage\.setItem\(\s*["']ct_key/.test(html) &&
  /ls\.setItem\("ct_key"/.test(rememberPath) && !/ls\.setItem\("ct_key"/.test(defaultPath) &&
  (html.match(/\.setItem\("ct_key"/g) || []).length === 2 &&
  /byokStore\(/.test(inputWire) && !/localStorage/.test(inputWire));

// B10: the rule scoped to the Forget key button (.keyopts .auth-btn or
// #llmForget) makes it a touch target: min-height (or height) >= 52px (rem/em
// at 16px), centred text (inline-flex/flex + align-items:center) and
// box-sizing:border-box. The global .auth-btn rule is not accepted.
const css = ((/<style>([\s\S]*?)<\/style>/.exec(html) || ["", ""])[1]).replace(/\/\*[\s\S]*?\*\//g, "");
function toPx(v) {
  const m = /^([\d.]+)(px|rem|em)$/.exec((v || "").trim());
  return m ? parseFloat(m[1]) * (m[2] === "px" ? 1 : 16) : 0;
}
const forgetRules = [];
css.replace(/([^{}]+)\{([^{}]*)\}/g, (all, sel, body) => {
  if (sel.split(",").some(x => /^(\.keyopts\s+\.auth-btn|#llmForget)$/.test(x.trim()))) forgetRules.push(body);
  return all;
});
check("B10 the .keyopts .auth-btn / #llmForget rule sets min-height >= 52px, inline-flex + align-items:center, box-sizing:border-box",
  forgetRules.some(b => {
    const prop = n => ((new RegExp("(?:^|;)\\s*" + n + "\\s*:\\s*([^;]+)").exec(b) || ["", ""])[1]).trim();
    return Math.max(toPx(prop("min-height")), toPx(prop("height"))) >= 52 &&
      /^(inline-)?flex$/.test(prop("display")) && prop("align-items") === "center" &&
      prop("box-sizing") === "border-box";
  }));

// B11: the Remember row is a touch target too. Rules scoped to .keyopts give
// the checkbox width and height >= 24px, the row (.keyopts span) min-height
// >= 52px with align-items:center, and the clickable area is wider than the text
// (label padding, or span horizontal padding >= 8px).
function rulesFor(re) {
  const out = [];
  css.replace(/([^{}]+)\{([^{}]*)\}/g, (all, sel, body) => {
    if (sel.split(",").some(x => re.test(x.trim()))) out.push(body);
    return all;
  });
  return out;
}
const cssProp = (b, n) => ((new RegExp("(?:^|;)\\s*" + n + "\\s*:\\s*([^;]+)").exec(b) || ["", ""])[1]).trim();
const boxRules = rulesFor(/^(\.search-box\s+)?\.keyopts\s+(input\[type=checkbox\]|#llmRemember)$/);
const spanRules = rulesFor(/^\.keyopts\s+span$/);
const labelRules = rulesFor(/^\.keyopts\s+label$/);
check("B11 .keyopts checkbox >= 24px square; row span min-height >= 52px with align-items:center; padding widens the click area",
  boxRules.some(b => toPx(cssProp(b, "width")) >= 24 && toPx(cssProp(b, "height")) >= 24) &&
  spanRules.some(b => toPx(cssProp(b, "min-height")) >= 52 && cssProp(b, "align-items") === "center") &&
  (labelRules.some(b => cssProp(b, "padding").split(/\s+/).some(v => toPx(v) > 0)) ||
    spanRules.some(b => { const v = cssProp(b, "padding").split(/\s+/); return toPx(v.length > 1 ? v[1] : v[0]) >= 8; })));

// B12: the whole Remember row except the checkbox is the label, so a tap on
// the side padding toggles the box. The effective .keyopts label values (last
// declaration wins) are text-align:left, flex-grow >= 1 and right padding
// >= 8px; no .keyopts span rule carries horizontal padding.
const lastProp = (rules, n) => rules.map(b => cssProp(b, n)).filter(Boolean).pop() || "";
function padSides(b) {
  const v = cssProp(b, "padding").split(/\s+/).filter(Boolean);
  const right = v.length ? (v.length > 1 ? v[1] : v[0]) : "";
  const left = v.length ? (v.length > 3 ? v[3] : v.length > 1 ? v[1] : v[0]) : "";
  return { right: cssProp(b, "padding-right") || right, left: cssProp(b, "padding-left") || left };
}
const labelGrow = (() => {
  const g = lastProp(labelRules, "flex-grow"), f = lastProp(labelRules, "flex");
  return parseFloat(g || (f.split(/\s+/)[0] || "0")) || 0;
})();
check("B12 .keyopts label: text-align:left, flex-grow >= 1, right padding >= 8px; .keyopts span: no horizontal padding",
  lastProp(labelRules, "text-align") === "left" &&
  labelGrow >= 1 &&
  labelRules.some(b => toPx(padSides(b).right) >= 8) &&
  spanRules.every(b => { const p = padSides(b); return toPx(p.left) === 0 && toPx(p.right) === 0; }));

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed || missing.length ? 1 : 0);
