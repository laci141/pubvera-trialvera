// BibTeX polish test.
//
// Run: node tools/export_bibtex_polish_test.js
//
// The BibTeX note must show readable ClinicalTrials.gov labels instead of raw
// registry codes ("Phase: Not Applicable; Status: Not yet recruiting; ..."), and
// the title must be double-braced so classic BibTeX styles keep its case. This
// slices the REAL bibEsc/phaseLabel/statusLabel/toBibTeX out of index.html and
// runs them in a vm sandbox.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("function bibEsc(");
const end = html.indexOf("\n// Commands with no trial list");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate bibEsc/toBibTeX in index.html");
  process.exit(1);
}
const sandbox = { __expose: {} };
vm.runInNewContext(html.slice(start, end) +
  "\n__expose.toBibTeX=toBibTeX;" +
  "\n__expose.phaseLabel=typeof phaseLabel==='function'?phaseLabel:undefined;" +
  "\n__expose.statusLabel=typeof statusLabel==='function'?statusLabel:undefined;",
  sandbox, { filename: "toBibTeX.js" });
const { toBibTeX, phaseLabel, statusLabel } = sandbox.__expose;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (ok ? "" : "  (" + detail + ")"));
}
const bib = row => toBibTeX([Object.assign({ id: "NCT00000001", title: "T" }, row)]);
const noteLine = s => (s.match(/^\s*note\s*=.*$/m) || [null])[0];
const titleLine = s => (s.match(/^\s*title\s*=.*$/m) || [null])[0];

// ---- phaseLabel ----
const phaseCases = [
  ["NA", "Not Applicable"],
  ["EARLY_PHASE1", "Early Phase 1"],
  ["PHASE1", "Phase 1"],
  ["PHASE2", "Phase 2"],
  ["PHASE3", "Phase 3"],
  ["PHASE4", "Phase 4"],
  ["PHASE1/PHASE2", "Phase 1/Phase 2"],
  ["PHASE1, PHASE2", "Phase 1/Phase 2"],
  ["", ""],
  ["SOME_NEW_PHASE", "Some new phase"],
];
phaseCases.forEach(([code, want]) => {
  const got = typeof phaseLabel === "function" ? phaseLabel(code) : "phaseLabel missing";
  check("phaseLabel(" + JSON.stringify(code) + ")", got === want, JSON.stringify(got) + " != " + JSON.stringify(want));
});

// ---- statusLabel ----
const statusCases = [
  ["NOT_YET_RECRUITING", "Not yet recruiting"],
  ["RECRUITING", "Recruiting"],
  ["ENROLLING_BY_INVITATION", "Enrolling by invitation"],
  ["ACTIVE_NOT_RECRUITING", "Active, not recruiting"],
  ["SUSPENDED", "Suspended"],
  ["TERMINATED", "Terminated"],
  ["COMPLETED", "Completed"],
  ["WITHDRAWN", "Withdrawn"],
  ["UNKNOWN", "Unknown status"],
  ["AVAILABLE", "Available"],
  ["", ""],
  ["SOME_NEW_STATUS", "Some new status"],
];
statusCases.forEach(([code, want]) => {
  const got = typeof statusLabel === "function" ? statusLabel(code) : "statusLabel missing";
  check("statusLabel(" + JSON.stringify(code) + ")", got === want, JSON.stringify(got) + " != " + JSON.stringify(want));
});

// ---- toBibTeX note ----
let b = bib({ phase: "NA", status: "NOT_YET_RECRUITING", last_update: "2026-09-08" });
check("note readable (NA / NOT_YET_RECRUITING / last_update)",
  /^\s*note\s*=\s*\{Phase: Not Applicable; Status: Not yet recruiting; Last updated: 2026-09-08\}\s*$/m.test(b),
  noteLine(b));
check("no backslash-underscore in the entry", !b.includes("\\_"), b);

b = bib({ phase: "PHASE2", status: "RECRUITING", first_posted: "2012-10-02", last_update: "2025-03-04" });
check("note has all four parts in order",
  /^\s*note\s*=\s*\{Phase: Phase 2; Status: Recruiting; First posted: 2012-10-02; Last updated: 2025-03-04\}\s*$/m.test(b),
  noteLine(b));

b = bib({ status: "RECRUITING", last_update: "2025-03-04" });
check("row without phase -> no Phase: part", !/Phase:/.test(b) && /Status: Recruiting/.test(b), noteLine(b));

b = bib({ phases: ["PHASE1", "PHASE2"], status: "COMPLETED" });
check("phases array -> Phase 1/Phase 2",
  /Phase: Phase 1\/Phase 2; Status: Completed/.test(b), noteLine(b));

b = bib({});
check("row with nothing -> no note line", noteLine(b) === null, noteLine(b));

// ---- toBibTeX title ----
b = bib({ title: "Comparing Glycemic Outcomes in Type 2 Diabetes" });
check("title double-braced, case kept",
  /^\s*title\s*=\s*\{\{Comparing Glycemic Outcomes in Type 2 Diabetes\}\},?\s*$/m.test(b), titleLine(b));

b = bib({ title: "A&B 50% x_y {z} study" });
check("special chars still escaped inside double braces",
  /^\s*title\s*=\s*\{\{A\\&B 50\\% x\\_y z study\}\},?\s*$/m.test(b), titleLine(b));

b = bib({ title: "" });
check("missing title -> double-braced placeholder",
  /^\s*title\s*=\s*\{\{Untitled clinical trial\}\},?\s*$/m.test(b), titleLine(b));

if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
