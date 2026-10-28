// Delegated data-action listeners test (CSP phase 0b).
//
// Run: node tools/delegated_actions_test.js
//
// The modal's built HTML carries data-action="..." instead of inline on*=
// handlers, and two delegated listeners on #modalContent (mc) act on them.
// no_inline_handlers_test.js proves the handlers are gone; this proves the
// replacement works:
//   T3 every data-action value used in index.html has a branch in the mc click
//      listener, and every branch is used by at least one data-action;
//   T4 both mc listeners are cut out of index.html and driven in a vm sandbox
//      with fake elements; window.__fill/__fillPair are the real ones.
// A listener block that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const raw = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
// HTML comments are blanked character by character so line numbers still match.
const html = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
const lineOf = i => html.slice(0, i).split("\n").length;

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// A block runs from its opening line to the first "\n});" after it, and the
// opening line must occur exactly once.
function cut(open) {
  const at = [];
  for (let i = html.indexOf(open); i >= 0; i = html.indexOf(open, i + 1)) at.push(i);
  if (at.length !== 1) return { found: at.length, code: "" };
  const end = html.indexOf("\n});", at[0]);
  if (end < 0) return { found: 1, code: "" };
  return { found: 1, code: html.slice(at[0], end + 4), line: lineOf(at[0]) };
}
const clickBlk = cut('mc.addEventListener("click",e=>{');
const inputBlk = cut('mc.addEventListener("input",e=>{');
check("T3/T4 mc click listener found exactly once (found " + clickBlk.found +
  (clickBlk.line ? ", L" + clickBlk.line : "") + ")", clickBlk.found === 1 && clickBlk.code !== "");
check("T4 mc input listener found exactly once (found " + inputBlk.found +
  (inputBlk.line ? ", L" + inputBlk.line : "") + ")", inputBlk.found === 1 && inputBlk.code !== "");

// ── T3: data-action values vs handler branches ──
const branches = [...new Set([...clickBlk.code.matchAll(/\ba===\s*"([^"]*)"/g)].map(m => m[1]))];
// JS line comments ("// ... data-action=\"signIn\" ...") document, they do not use.
const used = new Map();
const dynamic = [];
html.split("\n").forEach((ln, i) => {
  if (/^\s*\/\//.test(ln)) return;
  for (const m of ln.matchAll(/data-action\s*=\s*\\?["']([^"'\\]*)/g)) {
    if (!/^[A-Za-z][\w-]*$/.test(m[1])) { dynamic.push("L" + (i + 1) + ": " + m[0]); continue; }
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(i + 1);
  }
});
console.log("      branches in click listener: " + (branches.join(", ") || "(none)"));
console.log("      data-action values used:    " +
  ([...used].map(([v, ls]) => v + " (L" + ls.join(",L") + ")").join(", ") || "(none)"));
const missing = [...used.keys()].filter(v => !branches.includes(v));
const dead = branches.filter(v => !used.has(v));
check("T3 click listener has at least one branch (found " + branches.length + ")", branches.length > 0);
check("T3 index.html uses at least one data-action (found " + used.size + ")", used.size > 0);
check("T3 every data-action has a handler branch (missing: " + (missing.join(", ") || "none") + ")", missing.length === 0);
check("T3 every handler branch is used by a data-action (dead: " + (dead.join(", ") || "none") + ")", dead.length === 0);
check("T3 every data-action value is a literal (non-literal: " + dynamic.length + ")", dynamic.length === 0);
for (const d of dynamic) console.log("      " + d);

// ── T4: drive the listeners in a vm sandbox ──
const fillLine = (html.match(/^window\.__fill=.*$/m) || [""])[0];
const pairCode = (html.match(/^window\.__fillPair=[\s\S]*?\};$/m) || [""])[0];
check("T4 window.__fill and window.__fillPair found in index.html", fillLine !== "" && pairCode !== "");

// A fresh sandbox per case: one broken branch cannot leak into the next case.
function harness() {
  const calls = [];
  const els = {
    res: { innerHTML: "<p>result</p>" },
    lv: { textContent: "10" },
    f_query: { value: "", focus() { calls.push("focus:f_query"); } },
    f_drug1: { value: "" },
    f_drug2: { value: "" },
  };
  const L = {};
  const sb = {
    mc: { addEventListener: (t, f) => { L[t] = f; } },
    closeModal: () => calls.push("closeModal"),
    pubveraSignIn: () => calls.push("pubveraSignIn"),
    document: { getElementById: id => els[id] || null },
    window: {},
  };
  vm.createContext(sb);
  vm.runInContext(fillLine + "\n" + pairCode, sb);
  vm.runInContext(clickBlk.code + "\n" + inputBlk.code, sb);
  // The click target is the element inside the button; closest() walks up to it.
  const click = btn => {
    let sel = null;
    L.click({ target: { closest: s => { sel = s; return s === "[data-action]" ? btn : null; } } });
    return sel;
  };
  return { calls, els, L, click };
}
function tcase(label, fn) {
  let ok = false, why = "";
  try { ok = fn(harness()); } catch (e) { why = " (threw: " + e.message + ")"; }
  check("T4 " + label + why, ok === true);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const untouched = els => els.res.innerHTML === "<p>result</p>" && els.lv.textContent === "10" &&
  els.f_query.value === "" && els.f_drug1.value === "" && els.f_drug2.value === "";

tcase("close -> closeModal() once, nothing else", h => {
  const sel = h.click({ dataset: { action: "close" } });
  return sel === "[data-action]" && same(h.calls, ["closeModal"]) && untouched(h.els);
});
tcase("fill -> #f_query gets the chip text and focus", h => {
  h.click({ dataset: { action: "fill", target: "f_query" }, textContent: "breast cancer" });
  return h.els.f_query.value === "breast cancer" && same(h.calls, ["focus:f_query"]);
});
tcase("fillPair -> #f_drug1/#f_drug2 get data-a/data-b", h => {
  h.click({ dataset: { action: "fillPair", a: "aspirin", b: "ibuprofen" } });
  return h.els.f_drug1.value === "aspirin" && h.els.f_drug2.value === "ibuprofen" && same(h.calls, []);
});
tcase("signIn -> pubveraSignIn() once", h => {
  h.click({ dataset: { action: "signIn" } });
  return same(h.calls, ["pubveraSignIn"]) && untouched(h.els);
});
tcase("clear -> #res emptied", h => {
  h.click({ dataset: { action: "clear" } });
  return h.els.res.innerHTML === "" && same(h.calls, []);
});
tcase("click outside any [data-action] (closest -> null) does nothing", h => {
  h.click(null);
  return same(h.calls, []) && untouched(h.els);
});
tcase("unknown data-action does nothing", h => {
  h.click({ dataset: { action: "nope" } });
  return same(h.calls, []) && untouched(h.els);
});
tcase("input on #f_limit -> #lv shows the value", h => {
  h.L.input({ target: { id: "f_limit", value: "42" } });
  return h.els.lv.textContent === "42";
});
tcase("input on another field leaves #lv alone", h => {
  h.L.input({ target: { id: "f_query", value: "zzz" } });
  return h.els.lv.textContent === "10" && same(h.calls, []);
});

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
