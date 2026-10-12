// BibTeX year test.
//
// Run: node tools/export_bibtex_year_test.js
//
// The BibTeX year must come from the registration (first posted) date, then the
// last update date, and never from start_date (a future year for trials that
// have not started). This slices the REAL bibEsc/toBibTeX out of index.html and
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
vm.runInNewContext(html.slice(start, end) + "\n__expose.toBibTeX=toBibTeX;",
  sandbox, { filename: "toBibTeX.js" });
const toBibTeX = sandbox.__expose.toBibTeX;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (ok ? "" : "  (" + detail + ")"));
}
const bib = row => toBibTeX([Object.assign({ id: "NCT00000001", title: "T" }, row)]);
const yearLine = s => (s.match(/^\s*year\s*=.*$/m) || [null])[0];

let b = bib({ first_posted: "2012-10-02", start_date: "2031-01-01" });
check("first_posted wins over future start_date", /year\s*=\s*\{2012\}/.test(b), yearLine(b));

b = bib({ last_update: "2025-03-04", start_date: "2031-01-01" });
check("last_update fallback", /year\s*=\s*\{2025\}/.test(b), yearLine(b));

b = bib({ start_date: "2031-01-01" });
check("neither -> no year line", yearLine(b) === null, yearLine(b));

const ud = b.match(/urldate\s*=\s*\{([^}]*)\}/);
check("urldate present, YYYY-MM-DD", !!ud && /^\d{4}-\d{2}-\d{2}$/.test(ud[1]), ud && ud[1]);

b = bib({ first_posted: "2012-10-02", last_update: "2025-03-04", status: "RECRUITING" });
check("note has First posted", b.includes("First posted: 2012-10-02"), b);
check("note has Last updated", b.includes("Last updated: 2025-03-04"), b);
check("note keeps status", /note\s*=\s*\{[^}]*Status: Recruiting/.test(b), b);

b = bib({});
check("note omits dates when absent", !/First posted|Last updated/.test(b), b);

if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
