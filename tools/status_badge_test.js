// Status badge colours: every badge is a pill and every pill is readable.
//
// Run: node tools/status_badge_test.js
//
// statusBadge() puts a hex colour in data-color; applyBadgeColors() turns it
// into text colour, a 13% tint background and a 33% border, but ONLY for a
// 6-digit colour (a 3-digit one keeps just the text colour). COMPLETED was
// "#888" and the fallback "#aaa", so those two badges rendered as flat grey
// text while every other status was a pill, and "#888" measured 4.42:1 on the
// modal surface, under the WCAG 1.4.3 minimum of 4.5:1 for small text.
//   S1 statusBadge() runs and returns a .u-badge for every status;
//   S2 every colour it emits (all statuses and the fallback for an unknown
//      one) is 6-digit hex, so every badge gets the pill;
//   S3 the text colour on its own tinted pill is at least 4.5:1 on the
//      surface a badge sits on.
// statusBadge() is only called for a table cell (objTable), and a table sits on
// .rcard (white at 3%) over .modal-content (#1a1a2e at 97%): rgb(32,34,53),
// sampled from a real Chromium render. The compare cards (.rcard.compare-side,
// the lighter surface) hold chips and lists, never a table. A function that
// cannot be found is a FAIL.
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

function sliceFunction(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return "";
}

const src = sliceFunction("statusBadge");
check("statusBadge found", src !== "");
const escLine = (html.match(/^const esc=.*;$/m) || [""])[0];
check("esc helper found", escLine !== "");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(escLine + "\n" + src + "\nthis.statusBadge = statusBadge;", sandbox);
const statusBadge = sandbox.statusBadge;

const STATUSES = ["RECRUITING", "NOT_YET_RECRUITING", "COMPLETED", "TERMINATED", "WITHDRAWN",
  "UNKNOWN", "ACTIVE_NOT_RECRUITING", "SOMETHING_NEW_FROM_THE_REGISTRY"];

const colours = {};
for (const s of STATUSES) {
  const out = typeof statusBadge === "function" ? statusBadge(s) : "";
  const m = out.match(/^<span class="u-badge" data-color="([^"]*)">[^<]+<\/span>$/);
  colours[s] = m ? m[1] : null;
}
check("S1 a .u-badge for all " + STATUSES.length + " statuses", STATUSES.every(s => colours[s] !== null));
check("S1 empty status gives no badge", typeof statusBadge === "function" && statusBadge("") === "");

for (const s of STATUSES) {
  check("S2 " + s + " colour is 6-digit hex (" + colours[s] + ")", /^#[0-9a-fA-F]{6}$/.test(colours[s] || ""));
}

const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const SURFACE = [32, 34, 53];
const ALPHA = 0x22 / 255; // applyBadgeColors: background = colour + "22"
for (const s of STATUSES) {
  const h = colours[s];
  if (!/^#[0-9a-fA-F]{6}$/.test(h || "")) { check("S3 " + s + " contrast (no 6-digit colour to measure)", false); continue; }
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const pill = SURFACE.map((v, i) => v * (1 - ALPHA) + c[i] * ALPHA);
  const r = ratio(c, pill);
  check("S3 " + s + " " + h + " on its pill " + r.toFixed(2) + ":1 >= 4.5", r >= 4.5);
}

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
