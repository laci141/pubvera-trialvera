// trial_flags_test.js — guards the "No results posted" and "Stale" row flags.
//
// The flags are computed from each row's own registry fields against a clock,
// so every case here passes a fixed `now` (2026-11-25 12:00 UTC) and no result
// depends on the day the suite runs.
//
//   F1 "No results posted": COMPLETED or TERMINATED, has_results === false, and
//      the primary completion period (completion date as fallback) ended at
//      least one calendar year ago. A partial date counts from the end of its
//      period, so "2025-12" is not a year old until 2027-01-01.
//   F2 "Stale": an ongoing status whose last_update period ended more than two
//      years ago. UNKNOWN and finished trials never get it.
//   F3 The legend lists only the flags present in the rows, in a fixed order.
//   F4 objTable wires both: the flag after the status pill and the legend above
//      the table, for the main (exportable) array only.
//   F5 Only classes and a title attribute are emitted (the CSP forbids inline
//      style attributes), and the title text is escaped.
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
function sliceConst(name) {
  const start = html.indexOf("const " + name + "=");
  if (start < 0) return "";
  const end = html.indexOf(";\n", start);
  return end < 0 ? "" : html.slice(start, end + 1);
}

const escLine = (html.match(/^const esc=.*;$/m) || [""])[0];
const parts = [escLine, sliceConst("FLAG_ONGOING"), sliceConst("FLAG_TEXT")]
  .concat(["periodEnd", "yearsAfter", "trialFlagKeys", "flagBadge", "trialFlags", "flagLegend"].map(sliceFunction));
check("helpers found", parts.every(p => p !== ""));

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(parts.join("\n") +
  "\nthis.trialFlagKeys=trialFlagKeys;this.trialFlags=trialFlags;this.flagLegend=flagLegend;this.periodEnd=periodEnd;", sandbox);
const { trialFlagKeys, trialFlags, flagLegend, periodEnd } = sandbox;
const NOW = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
const keys = o => (typeof trialFlagKeys === "function" ? Array.from(trialFlagKeys(o, NOW)).join(",") : "missing");

// periodEnd
const iso = d => (d ? d.toISOString().slice(0, 10) : "null");
check("P1 day ends the next day", iso(periodEnd && periodEnd("2025-11-13")) === "2025-11-14");
check("P2 month ends on the 1st of the next month", iso(periodEnd && periodEnd("2025-12")) === "2026-01-01");
check("P3 year ends on 1 January of the next year", iso(periodEnd && periodEnd("2024")) === "2025-01-01");
check("P4 free text is not a date", periodEnd && periodEnd("November 2025") === null);
check("P5 empty is not a date", periodEnd && periodEnd("") === null);

// F1 No results posted
check("F1a completed, no results, a year past primary completion", keys({ status: "COMPLETED", has_results: false, primary_completion_date: "2025-11-13" }) === "nores");
check("F1b exactly on the one-year mark counts", keys({ status: "COMPLETED", has_results: false, primary_completion_date: "2025-11-24" }) === "nores");
const MIDNIGHT = new Date(Date.UTC(2026, 10, 25));
check("F1k the instant the year ends already counts", typeof trialFlagKeys === "function" &&
  Array.from(trialFlagKeys({ status: "COMPLETED", has_results: false, primary_completion_date: "2025-11-24" }, MIDNIGHT)).join(",") === "nores");
check("F1c one day short of a year does not", keys({ status: "COMPLETED", has_results: false, primary_completion_date: "2025-11-25" }) === "");
check("F1d a month date counts from the end of the month", keys({ status: "COMPLETED", has_results: false, primary_completion_date: "2025-12" }) === "");
check("F1e terminated falls back to completion_date", keys({ status: "TERMINATED", has_results: false, completion_date: "2020-03" }) === "nores");
check("F1f results posted: no flag", keys({ status: "COMPLETED", has_results: true, primary_completion_date: "2020-01" }) === "");
check("F1g has_results missing: no flag", keys({ status: "COMPLETED", primary_completion_date: "2020-01" }) === "");
check("F1h no completion date: no flag", keys({ status: "COMPLETED", has_results: false }) === "");
check("F1i withdrawn is not flagged", keys({ status: "WITHDRAWN", has_results: false, primary_completion_date: "2020-01" }) === "");
check("F1j lowercase status still matches", keys({ status: "completed", has_results: false, primary_completion_date: "2020-01" }) === "nores");

// F2 Stale
check("F2a recruiting, last update over two years ago", keys({ status: "RECRUITING", last_update: "2024-11-20" }) === "stale");
check("F2b last update under two years ago", keys({ status: "RECRUITING", last_update: "2025-01" }) === "");
check("F2c suspended counts as ongoing", keys({ status: "SUSPENDED", last_update: "2022-05-01" }) === "stale");
check("F2d UNKNOWN is left to its own status pill", keys({ status: "UNKNOWN", last_update: "2019-01-01" }) === "");
check("F2e completed trials are not stale", keys({ status: "COMPLETED", has_results: true, last_update: "2019-01-01" }) === "");
check("F2f no last update: no flag", keys({ status: "RECRUITING" }) === "");
check("F2g both flags can never meet on one row", keys({ status: "COMPLETED", has_results: false, primary_completion_date: "2019-01", last_update: "2019-02" }) === "nores");

// F3 legend
const legend = typeof flagLegend === "function" ? flagLegend([
  { status: "RECRUITING", last_update: "2020-01" },
  { status: "COMPLETED", has_results: false, primary_completion_date: "2020-01" }], NOW) : "";
check("F3a legend lists both, No results posted first", legend.indexOf("No results posted") > 0 && legend.indexOf("No results posted") < legend.indexOf("Stale"));
check("F3b legend is empty when no row is flagged", typeof flagLegend === "function" && flagLegend([{ status: "RECRUITING", last_update: "2026-10-01" }], NOW) === "");
const onlyStale = typeof flagLegend === "function" ? flagLegend([{ status: "RECRUITING", last_update: "2020-01" }], NOW) : "";
check("F3c legend leaves out flags no row has", onlyStale.indexOf("Stale") > 0 && onlyStale.indexOf("No results posted") < 0);

// F4 wiring in objTable
const obj = sliceFunction("objTable");
check("F4a status cell appends trialFlags for the main array", /statusBadge\(o\[c\]\)\+\(isMain\?trialFlags\(o\):""\)/.test(obj));
check("F4b legend sits above the table for the main array", /return `\$\{isMain&&cols\.includes\("status"\)\?flagLegend\(shown\):""\}<table>/.test(obj));

// F5 CSP and escaping
const badge = typeof trialFlags === "function" ? trialFlags({ status: "RECRUITING", last_update: "2020-01" }, NOW) : "";
check("F5a badge has classes and a title, no style attribute", /class="u-flag u-flag-stale" title="/.test(badge) && !/style=/.test(badge));
check("F5b CSS classes exist", /\.u-flag\{/.test(html) && /\.u-flag-nores\{/.test(html) && /\.u-flag-stale\{/.test(html));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
