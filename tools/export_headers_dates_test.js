// Export polish test: readable headers + real XLSX dates.
//
// Run: node tools/export_headers_dates_test.js
//
// Extra columns after the 13 fixed trial columns used to keep their raw JSON
// keys (sponsor_class, last_update, ...) in CSV and XLSX, and the XLSX stored
// ISO dates as text so Excel date filters did not work. This slices the REAL
// export suite out of index.html (humanizeHeader, isoDateToSerial, toCSV,
// downloadXLSX, ...) and runs it in a vm sandbox with a recording XLSX stub.
//
// Frozen header rows are NOT tested: xlsx-js-style 1.2.0 cannot write a pane
// (measured: "!freeze", "!views", "!panes" all produce no <pane> element), so
// the feature was not implemented. See the comment above wb in downloadXLSX.
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

// ── minimal XLSX stub that keeps real cell objects, so t/v/z can be asserted ──
const captured = {};
function colName(c) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = "";
  for (c = c + 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
}
const encode_cell = ({ r, c }) => colName(c) + (r + 1);
const XLSX = {
  utils: {
    aoa_to_sheet: aoa => {
      const ws = {};
      let maxC = 0;
      aoa.forEach((row, r) => row.forEach((v, c) => {
        if (c > maxC) maxC = c;
        ws[encode_cell({ r, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v: String(v) };
      }));
      ws["!ref"] = "A1:" + colName(maxC) + aoa.length;
      captured.aoa = aoa; captured.ws = ws;
      return ws;
    },
    decode_range: ref => {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
      const num = s => s.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      return { s: { r: +m[2] - 1, c: num(m[1]) }, e: { r: +m[4] - 1, c: num(m[3]) } };
    },
    encode_cell,
    encode_range: ({ s, e }) => encode_cell(s) + ":" + encode_cell(e),
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFile: () => {},
};

const sandbox = {
  console, Date, XLSX,
  alert: m => { throw new Error("alert: " + m); },
  window: { location: { origin: "http://localhost:8199" } },
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({}),
  },
  __expose: {},
};
// typeof guard: before the change these names do not exist, and the checks
// below must report FAIL lines rather than die on a ReferenceError.
const names = ["lastData", "registerView", "csvExport", "downloadXLSX", "toCSV",
  "humanizeHeader", "isoDateToSerial"];
vm.runInNewContext(
  suite + "\n" + names.map(n => `__expose[${JSON.stringify(n)}]=typeof ${n}==="undefined"?undefined:${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;
const humanizeHeader = S.humanizeHeader || (() => undefined);
const isoDateToSerial = S.isoDateToSerial || (() => undefined);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}

// ── humanizeHeader ──
check("humanizeHeader sponsor_class", humanizeHeader("sponsor_class"), "Sponsor class");
check("humanizeHeader last_update", humanizeHeader("last_update"), "Last updated");
check("humanizeHeader first_posted", humanizeHeader("first_posted"), "First posted");
check("humanizeHeader has_results", humanizeHeader("has_results"), "Has results");
check("humanizeHeader secondary_ids", humanizeHeader("secondary_ids"), "Secondary IDs");
check("humanizeHeader source", humanizeHeader("source"), "Source");
check("humanizeHeader sponsor_trials", humanizeHeader("sponsor_trials"), "Sponsor trials");
check("humanizeHeader unknown key with underscores", humanizeHeader("some_odd_key"), "Some odd key");
check("humanizeHeader single word", humanizeHeader("score"), "Score");
check("humanizeHeader fixed label unchanged (NCT ID)", humanizeHeader("NCT ID"), "NCT ID");
check("humanizeHeader fixed label unchanged (Primary completion date)",
  humanizeHeader("Primary completion date"), "Primary completion date");

// ── isoDateToSerial ──
check("serial 2027-04-01", isoDateToSerial("2027-04-01"), 46478);
check("serial 2026-08-21", isoDateToSerial("2026-08-21"), 46255);
check("serial 2024-02-29 (leap day) is one after 2024-02-28",
  isoDateToSerial("2024-02-29") - isoDateToSerial("2024-02-28"), 1);
check("partial YYYY-MM not converted", isoDateToSerial("2027-04"), null);
check("partial YYYY not converted", isoDateToSerial("2027"), null);
check("empty not converted", isoDateToSerial(""), null);
check("impossible 2026-02-30 not converted", isoDateToSerial("2026-02-30"), null);
check("month 13 not converted", isoDateToSerial("2026-13-01"), null);
check("trailing text not converted", isoDateToSerial("2027-04-01T00:00"), null);
check("non-string not converted", isoDateToSerial(46478), null);
check("undefined not converted", isoDateToSerial(undefined), null);

// ── end to end through the real csvExport / downloadXLSX ──
const trial = {
  id: "NCT07534098", title: "A trial", status: "RECRUITING", phase: "PHASE2", sponsor: "Acme",
  enrollment: 120, start_date: "2027-04-01", primary_completion_date: "2027-04",
  completion_date: "2028-12-31", first_posted: "2026-08-21", last_update: "2026-08-21",
  sponsor_class: "INDUSTRY", has_results: false, source: "clinicaltrials.gov",
  secondary_ids: [{ id: "X-1" }],
};
const risk = { score: 7, level: "HIGH", sponsor_trials: 12, name: "factor", detail: "text", points: 3 };
function load(rows) {
  S.lastData.search = { rows, query: "q", response: { command: "search", result: {} } };
  S.registerView("search", () => ({ rows, filters: [] }));
}
const T_HEADERS = ["NCT ID", "Title", "Status", "Phase", "Conditions", "Interventions", "Enrollment",
  "Sponsor", "Start date", "Primary completion date", "Completion date", "Country", "URL",
  "First posted", "Last updated", "Sponsor class", "Has results", "Source", "Secondary IDs"];
const R_HEADERS = ["Score", "Level", "Sponsor trials", "Name", "Detail", "Points"];

load([trial]);
S.downloadXLSX("search", "t.xlsx");
const aoa = captured.aoa, ws = captured.ws;
check("XLSX trial header row", aoa[1], T_HEADERS);
const csvLines = S.csvExport("search").split("\r\n");
check("CSV trial header row equals XLSX header row", csvLines[2], T_HEADERS.join(","));
const col = h => colName(T_HEADERS.indexOf(h)) + "3"; // data row = sheet row 3
const cell = h => ws[col(h)];
check("Start date is a number", cell("Start date").t + ":" + cell("Start date").v, "n:46478");
check("Start date has yyyy-mm-dd format", cell("Start date").z, "yyyy-mm-dd");
check("Completion date is a number", cell("Completion date").t, "n");
check("First posted is a number", cell("First posted").v, 46255);
check("Last updated is a number", cell("Last updated").v, 46255);
check("Last updated has yyyy-mm-dd format", cell("Last updated").z, "yyyy-mm-dd");
check("partial Primary completion date stays text", [cell("Primary completion date").t, cell("Primary completion date").v], ["s", "2027-04"]);
check("partial date gets no number format", cell("Primary completion date").z, undefined);
check("Enrollment stays numeric without date format", [cell("Enrollment").t, cell("Enrollment").v, cell("Enrollment").z], ["n", 120, undefined]);
check("non-date text column untouched", [cell("Sponsor class").t, cell("Sponsor class").v], ["s", "INDUSTRY"]);
check("CSV keeps ISO text for dates", csvLines[3].includes(",2027-04-01,") && csvLines[3].includes(",2026-08-21,"), true);

load([risk]);
S.downloadXLSX("search", "r.xlsx");
check("XLSX risk header row", captured.aoa[1], R_HEADERS);
check("CSV risk header row", S.csvExport("search").split("\r\n")[2], R_HEADERS.join(","));

console.log(failed ? "\n" + failed + " CHECK(S) FAILED" : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
