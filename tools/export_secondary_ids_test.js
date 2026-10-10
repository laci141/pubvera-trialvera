// secondary_ids export test.
//
// Run: node tools/export_secondary_ids_test.js
//
// Live rows carry secondary_ids as [{"id":"..."}]. trialExportRow (CSV/Excel
// row builder) wrote nothing for an array of objects, so the column header
// existed but every cell was empty. This slices the REAL trialExportRow out of
// index.html and runs it in a vm sandbox.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("const TRIAL_COLS=");
const end = html.indexOf("\nconst isTrialRow=");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate TRIAL_COLS/trialExportRow in index.html");
  process.exit(1);
}
const sandbox = { __expose: {} };
vm.runInNewContext(html.slice(start, end) + "\n__expose.trialExportRow=trialExportRow;",
  sandbox, { filename: "trialExportRow.js" });
const trialExportRow = sandbox.__expose.trialExportRow;

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}
const cell = v => trialExportRow({ id: "NCT00000001", secondary_ids: v }).secondary_ids;

check("object array with ids", cell([{ id: "A" }, { id: "B" }]), "A; B");
check("empty array stays absent", cell([]), "");
check("scalar array unchanged", cell(["x", "y"]), "x; y");
check("object array without id writes nothing", cell([{ foo: "A" }]), undefined);
check("object array with empty id writes nothing", cell([{ id: "" }]), undefined);

if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
