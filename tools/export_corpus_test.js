// Corpus + autofilter export test.
//
// Run: node tools/export_corpus_test.js
//
// Covers two defects:
//   1. the XLSX worksheet must carry an !autofilter spanning the column
//      header row (index 1) down to the last data row — never the caption;
//   2. every format must report the retrieved corpus size
//      (rows_total + filtered_count), including when nothing was filtered.
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

// ── fixture: 71 trials, all visible on screen ──
const ROWS = 71;
const trials = [];
for (let i = 0; i < ROWS; i++) {
  trials.push({
    id: "NCT" + String(20000000 + i),
    title: "obesity trial " + i,
    status: "RECRUITING", phase: "PHASE3", sponsor: "Sponsor " + i,
    enrollment: 500 - i, start_date: "2024-01-01", has_results: i % 2 === 0,
  });
}

const els = trials.map((t, i) => ({
  getAttribute: k => (k === "data-ri" ? String(i) : null),
  style: { display: "" },
}));
const scope = {
  querySelectorAll: sel => (sel === "[data-ri]" ? els : []),
  querySelector: sel => (sel === ".qfilter" ? { value: "" } : null),
};

const xlsxCaptured = {};
function colName(c) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = "";
  for (c = c + 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
}
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
  XLSX: {
    utils: {
      aoa_to_sheet: aoa => {
        xlsxCaptured.aoa = aoa;
        const ws = { "!ref": "A1:" + colName(aoa[1].length - 1) + aoa.length };
        xlsxCaptured.ws = ws;
        return ws;
      },
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
      encode_cell: ({ r, c }) => "R" + r + "C" + c,
      encode_range: ({ s, e }) => colName(s.c) + (s.r + 1) + ":" + colName(e.c) + (e.r + 1),
      book_new: () => ({}),
      book_append_sheet: () => {},
    },
    writeFile: () => {},
  },
  __expose: {},
};

const exposeNames = ["lastData", "registerView", "domViewProvider", "exportRows",
  "exportHeader", "csvExport", "bibExport", "jsonExport", "downloadXLSX"];
vm.runInNewContext(
  suite + "\n" + exposeNames.map(n => `__expose[${JSON.stringify(n)}]=${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}

function load(result) {
  S.lastData.search = {
    rows: trials, query: "obesity",
    response: { command: "search", result: result },
  };
  S.registerView("search", S.domViewProvider("search"));
}

// ── fixture A: 71 rows, 30 hidden by the relevance gate ──
load({ filtered_count: 30 });
S.downloadXLSX("search", "t.xlsx");
const aoa = xlsxCaptured.aoa;
const cols = aoa[1].length;
const af = xlsxCaptured.ws["!autofilter"];

check("XLSX has !autofilter", !!(af && af.ref), true);
// Must start at the column header (row 2 in 1-based A1 notation), not the caption.
check("autofilter starts at the header row, not the caption",
  /^[A-Z]+2:/.test(af.ref), true);
check("autofilter ends at the last data row and last column",
  af.ref.split(":")[1], colName(cols - 1) + aoa.length);
check("autofilter column count matches the sheet", cols, aoa[1].length);

const jsonA = S.jsonExport("search");
check("corpus with filtering", jsonA.export.corpus, { retrieved: 101, displayed: ROWS });
check("rows_total unchanged", jsonA.export.rows_total, ROWS);

// all three non-JSON formats must carry the retrieved count too
const hdrA = S.exportHeader("search", S.exportRows("search").rows);
check("header carries retrieved", hdrA.includes("101 retrieved"), true);
check("header keeps the hidden-count segment",
  hdrA.includes("30 off-topic trials hidden by relevance filter"), true);
check("CSV header carries retrieved",
  S.csvExport("search").split("\r\n")[1].includes("101 retrieved"), true);
check("XLSX caption carries retrieved", aoa[0][0].includes("101 retrieved"), true);
check("BibTeX comment carries retrieved",
  S.bibExport("search").split("\n")[0].includes("101 retrieved"), true);

// ── fixture B: 71 rows, nothing filtered — the block is PRESENT ──
load({});
const jsonB = S.jsonExport("search");
check("corpus without filtering is present",
  jsonB.export.corpus, { retrieved: ROWS, displayed: ROWS });
check("filtered_count still omitted at zero",
  "filtered_count" in jsonB.export, false);
S.downloadXLSX("search", "t2.xlsx");
check("XLSX caption carries retrieved (unfiltered)",
  xlsxCaptured.aoa[0][0].includes("71 retrieved"), true);
check("CSV header carries retrieved (unfiltered)",
  S.csvExport("search").split("\r\n")[1].includes("71 retrieved"), true);
check("BibTeX comment carries retrieved (unfiltered)",
  S.bibExport("search").split("\n")[0].includes("71 retrieved"), true);

console.log(failed ? "\n" + failed + " CHECK(S) FAILED" : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
