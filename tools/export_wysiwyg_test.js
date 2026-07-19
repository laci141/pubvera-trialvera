// WYSIWYG export test: exports must return exactly the rows visible on
// screen (after the 🔍 quick filter and column sort), in on-screen order,
// in all four formats, each carrying a provenance header.
//
// Run: node tools/export_wysiwyg_test.js
//
// The export suite lives inline in index.html; this test slices that script
// section out and executes it in a vm sandbox with a minimal DOM shim, then
// simulates a rendered result (100 trials, 7 visible) and measures.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("Export suite (CSV");
const end = html.indexOf("// ── metaRow");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export-suite section in index.html");
  process.exit(1);
}
const suite = html.slice(html.indexOf("\n", start) + 1, end);

// ── fixtures: 100 trials, the 7 "alpha" ones will stay visible ──
const trials = [];
for (let i = 0; i < 100; i++) {
  trials.push({
    id: "NCT" + String(10000000 + i),
    title: (i % 15 === 0 && i < 100 && [0,15,30,45,60,75,90].includes(i) ? "alpha" : "beta") + " trial " + i,
    status: "RECRUITING", phase: "PHASE3", sponsor: "Sponsor " + i,
    enrollment: 1000 - i * 3, start_date: "2024-01-01", conditions: ["melanoma"],
  });
}
const visibleIdx = trials.map((t, i) => (t.title.startsWith("alpha") ? i : -1)).filter(i => i >= 0);

// ── DOM shim: tagged rows exactly as objTable renders them ──
function makeEls() {
  return trials.map((t, i) => ({
    _ri: i,
    getAttribute: k => (k === "data-ri" ? String(i) : null),
    style: { display: "" },
  }));
}
let els = makeEls();
let qfilterValue = "";
let sortTh = null;
const scope = {
  querySelectorAll: sel => (sel === "[data-ri]" ? els : []),
  querySelector: sel => {
    if (sel === ".qfilter") return { value: qfilterValue };
    if (/th\[data-dir/.test(sel)) return sortTh;
    return null;
  },
};
const alerts = [];
const xlsxCaptured = {};
const sandbox = {
  console,
  Date,
  alert: m => alerts.push(m),
  window: { location: { origin: "http://localhost:8199" } },
  document: {
    querySelector: sel => (sel === '[data-exportkey="search"]' ? scope : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({}),
  },
  XLSX: {
    utils: {
      aoa_to_sheet: aoa => { xlsxCaptured.aoa = aoa; return { "!ref": "A1" }; },
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
      encode_cell: ({ r, c }) => "R" + r + "C" + c,
      book_new: () => ({}),
      book_append_sheet: () => {},
    },
    writeFile: (wb, name) => { xlsxCaptured.written = name; },
  },
  __expose: {},
};

// Run the suite, then grab what the tests need out of the script scope.
const exposeNames = ["lastData","registerView","domViewProvider","exportRows",
  "exportHeader","csvExport","bibExport","jsonExport","downloadXLSX","toCSV"];
vm.runInNewContext(
  suite + "\n" + exposeNames.map(n => `__expose[${JSON.stringify(n)}]=${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}

S.lastData.search = {
  rows: trials, query: "melanoma",
  response: { command: "search", result: { total_matching: 4004 } },
};
S.registerView("search", S.domViewProvider("search"));

// 1 ── unfiltered: screen shows all 100, exports must hold 100
const csvAll = S.csvExport("search");
check("unfiltered CSV data rows", csvAll.split("\r\n").length - 3, 100);
check("unfiltered visible on screen", els.filter(e => e.style.display !== "none").length, 100);

// 2 ── filtered: qfilter leaves 7 of 100 visible → exports must hold exactly 7
qfilterValue = "alpha";
els.forEach(e => { e.style.display = visibleIdx.includes(e._ri) ? "" : "none"; });
check("required test: exportRows(key).rows.length == visible rows",
  S.exportRows("search").rows.length, visibleIdx.length);
const csv = S.csvExport("search");
const csvRows = csv.split("\r\n").length - 3;
check("filtered CSV data rows (screen shows 7 / 100)", csvRows, 7);

// 3 ── quick-toggle switches: Trialvera has none (only qfilter + sort) — n/a.

// 4 ── sort carries into the export: reverse the visible order (DOM order)
els = makeEls().filter(e => visibleIdx.includes(e._ri)).reverse();
sortTh = { textContent: "enrollment ⇅", dataset: { dir: "asc" } };
const sortedFirst = S.exportRows("search").raw[0];
check("first exported row == first on-screen row after sort",
  sortedFirst.id, trials[visibleIdx[visibleIdx.length - 1]].id);
els = makeEls();
els.forEach(e => { e.style.display = visibleIdx.includes(e._ri) ? "" : "none"; });
sortTh = null;

// 5 ── all four formats agree on the row count
const bib = S.bibExport("search");
const bibEntries = (bib.match(/@misc\{NCT/g) || []).length;
const json = S.jsonExport("search");
S.downloadXLSX("search", "t.xlsx");
const xlsxRows = xlsxCaptured.aoa.length - 2;
check("BibTeX entries", bibEntries, csvRows);
check("JSON rows", json.rows.length, csvRows);
check("JSON export.rows_exported", json.export.rows_exported, csvRows);
check("JSON export.rows_total", json.export.rows_total, 100);
check("XLSX data rows", xlsxRows, csvRows);

// 6 ── provenance header in all four formats, with the active filter
const hdr = S.exportHeader("search", S.exportRows("search").rows);
check("header shows subset", hdr.includes("showing 7 of 100 rows"), true);
check("header shows query", hdr.includes('query: "melanoma"'), true);
check("CSV carries header", csv.split("\r\n")[1].includes('filter: ""alpha""'), true);
check("XLSX carries header", xlsxCaptured.aoa[0][0].includes('filter: "alpha"'), true);
check("BibTeX carries header", bib.startsWith("% Trialvera export"), true);
check("BibTeX header has filter", bib.split("\n")[0].includes('filter: "alpha"'), true);
check("JSON carries filters", json.export.filters.includes('filter: "alpha"'), true);

// empty view → the exact alert message, no file
els.forEach(e => { e.style.display = "none"; });
qfilterValue = "zzz-no-match";
check("empty view CSV blocked", S.csvExport("search"), null);
check("empty view BibTeX blocked", S.bibExport("search"), null);

console.log(failed ? "\n" + failed + " CHECK(S) FAILED" : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
