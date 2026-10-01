// Phase filter test.
//
// Run: node tools/phase_filter_test.js
//
// Covers two defects measured on a live 126-row "diabetes" search:
//   1. matchesPhase compared the whole cell text, so the 3 rows whose Phase
//      cell reads "PHASE1/PHASE2" matched neither the PHASE1 nor the PHASE2
//      filter (correct counts: PHASE1 = 12 incl. 1 EARLY_PHASE1, PHASE2 = 16);
//   2. the export provenance line listed the quick filter and the sort but
//      never the active phase filter, so a phase-filtered export did not say so.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}

// ── 1: matchesPhase, sliced out of index.html and run as-is ──
const fnStart = html.indexOf("function matchesPhase(");
const fnEnd = html.indexOf("\nfunction applyFilters(");
if (fnStart < 0 || fnEnd < 0 || fnEnd <= fnStart) {
  console.error("FAIL: could not locate matchesPhase in index.html");
  process.exit(1);
}
const phaseSandbox = { __expose: {} };
vm.runInNewContext(html.slice(fnStart, fnEnd) + "\n__expose.matchesPhase=matchesPhase;",
  phaseSandbox, { filename: "matchesPhase.js" });
const matchesPhase = phaseSandbox.__expose.matchesPhase;

const want = {
  //                  PHASE1 PHASE2
  "PHASE1":          [true,  false],
  "PHASE2":          [false, true],
  "PHASE1/PHASE2":   [true,  true],
  "PHASE1 / PHASE2": [true,  true],
  "EARLY_PHASE1":    [true,  false],
  "NA":              [false, false],
  "":                [false, false],
};
for (const [cell, [p1, p2]] of Object.entries(want)) {
  const row = { cells: [{ textContent: cell }] };
  check(JSON.stringify(cell) + " vs PHASE1", matchesPhase(row, "PHASE1", 0), p1);
  check(JSON.stringify(cell) + " vs PHASE2", matchesPhase(row, "PHASE2", 0), p2);
}
// No filter and no Phase column keep every row visible, as before.
check("no filter shows the row", matchesPhase({ cells: [{ textContent: "NA" }] }, "", 0), true);
check("no Phase column shows the row", matchesPhase({ cells: [] }, "PHASE1", -1), true);

// ── 2: the export provenance line records the active phase filter ──
const start = html.indexOf("Export suite (CSV");
const end = html.indexOf("// ── metaRow");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export-suite section in index.html");
  process.exit(1);
}
const suite = html.slice(html.indexOf("\n", start) + 1, end);

const trials = [
  { id: "NCT00000001", title: "a", status: "RECRUITING", phase: "PHASE1/PHASE2", phases: ["PHASE1", "PHASE2"] },
  { id: "NCT00000002", title: "b", status: "RECRUITING", phase: "PHASE3", phases: ["PHASE3"] },
];
const els = trials.map((t, i) => ({
  getAttribute: k => (k === "data-ri" ? String(i) : null),
  style: { display: i === 0 ? "" : "none" },   // PHASE2 filter hides the PHASE3 row
}));
let phaseValue = "PHASE2";
const scope = {
  querySelectorAll: sel => (sel === "[data-ri]" ? els : []),
  querySelector: sel => {
    if (sel === ".qfilter") return { value: "" };
    if (sel === ".phasefilter") return { value: phaseValue };
    return null;
  },
};
const sandbox = {
  console, Date,
  alert: () => {},
  window: { location: { origin: "http://localhost:8199" } },
  document: {
    querySelector: sel => (sel === '[data-exportkey="search"]' ? scope : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({}),
  },
  __expose: {},
};
const exposeNames = ["lastData", "registerView", "domViewProvider", "exportRows", "jsonExport"];
vm.runInNewContext(
  suite + "\n" + exposeNames.map(n => `__expose[${JSON.stringify(n)}]=${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;
S.lastData.search = { rows: trials, query: "diabetes", response: { command: "search", result: {} } };
S.registerView("search", S.domViewProvider("search"));

check("filtered export holds the visible row only", S.exportRows("search").raw.length, 1);
check("provenance records the phase filter", S.exportRows("search").scope.includes("phase: PHASE2"), true);
check("JSON export.filters records the phase filter",
  S.jsonExport("search").export.filters.includes("phase: PHASE2"), true);
phaseValue = "";
check("no phase filter → not in provenance", S.exportRows("search").scope.includes("phase:"), false);

// ── 3: the real filter path finds the Phase column behind its sort arrow ──
// initSortIndicators appends " ⇅" to every header, so phaseColIndex compared
// "phase ⇅" with "phase", returned -1 and the filter showed 126 / 126 rows.
const filterStart = html.indexOf("function phaseColIndex(");
const filterEnd = html.indexOf("\ndocument.addEventListener(\"input\"");
const countStart = html.indexOf("function refreshQCount(");
const countEnd = html.indexOf("\n// ── Sortable columns");
if (filterStart < 0 || filterEnd <= filterStart || countStart < 0 || countEnd <= countStart) {
  console.error("FAIL: could not locate the filter functions in index.html");
  process.exit(1);
}
const filterSandbox = { __expose: {} };
vm.runInNewContext(html.slice(filterStart, filterEnd) + "\n" + html.slice(countStart, countEnd) +
  "\n__expose.phaseColIndex=phaseColIndex;__expose.applyFilters=applyFilters;",
  filterSandbox, { filename: "filters.js" });
const F = filterSandbox.__expose;
const headers = ["id", "title", "status", "phase ⇅"].map(t => ({ textContent: t }));
const table = { querySelectorAll: sel => (sel === "thead th" ? headers : []) };
check("phaseColIndex behind the sort arrow", F.phaseColIndex(table), 3);

const rows = ["PHASE1", "PHASE2", "NA"].map((p, i) => ({
  cells: ["NCT0000000" + i, "t", "RECRUITING", p].map(t => ({ textContent: t })),
  textContent: "NCT0000000" + i + " t RECRUITING " + p,
  style: { display: "" },
  closest: sel => (sel === "table" ? table : null),
}));
const qcount = { textContent: "" };
const filterScope = {
  querySelector: sel => (sel === ".qfilter" ? { value: "" } : sel === ".phasefilter" ? { value: "PHASE1" }
    : sel === ".qcount" ? qcount : null),
  querySelectorAll: sel => (sel === "[data-ri]" || sel === "table tbody tr, ul.li li" ? rows : []),
};
F.applyFilters(filterScope);
check("PHASE1 filter leaves 1 of 3 rows visible", rows.filter(r => r.style.display !== "none").length, 1);
check("counter after PHASE1 filter", qcount.textContent, " · 1 / 3 rows");

console.log(failed ? "\n" + failed + " CHECK(S) FAILED" : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
