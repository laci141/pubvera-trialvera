// CSV formula-injection guard test.
//
// Run: node tools/csv_formula_test.js
//
// Titles, sponsors and conditions come from ClinicalTrials.gov, so a cell that
// starts with "=" (or +, -, @, their full-width forms, tab or CR) must reach
// Excel as text. This slices the REAL humanizeHeader/toCSV out of index.html
// and runs them in a vm sandbox.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("const HEADER_LABELS=");
const end = html.indexOf("\n// exportHeader is the provenance line");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate humanizeHeader/toCSV in index.html");
  process.exit(1);
}
const sandbox = { __expose: {} };
vm.runInNewContext(html.slice(start, end) + "\n__expose.toCSV=toCSV;",
  sandbox, { filename: "toCSV.js" });
const toCSV = sandbox.__expose.toCSV;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (ok ? "" : "  (" + detail + ")"));
}

// Minimal RFC 4180 parser (CRLF row separator, as toCSV writes it).
function parse(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; }
    else f += c;
  }
  row.push(f); rows.push(row);
  return rows;
}

// rows[0] = sep=, rows[1] = header, rows[2] = data.
const firstData = v => parse(toCSV([{ A: v }]).replace(/^\uFEFF/, ""))[2][0];

function prefixed(label, list) {
  list.forEach(s => {
    const got = firstData(s);
    check(label + " prefixed " + JSON.stringify(s), got === "'" + s, "got " + JSON.stringify(got));
  });
}

// a) classic starters, tab and CR
prefixed("a)", ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1", "\r=1"]);
// b) leading space / newline before the starter
prefixed("b)", [" =1+1", "\n=1+1"]);
// c) full-width starters
prefixed("c)", ["\uFF1D1+1", "\uFF0B1+1", "\uFF0D1+1", "\uFF20SUM(A1)"]);

// d) numbers and strictly numeric strings unchanged
[5, -33, "-5", "3.14", "-0.5"].forEach(v => {
  const got = firstData(v);
  check("d) unchanged " + JSON.stringify(v), got === String(v), "got " + JSON.stringify(got));
});

// e) ordinary text unchanged
["Smith J", "a=b", " plain"].forEach(s => {
  const got = firstData(s);
  check("e) unchanged " + JSON.stringify(s), got === s, "got " + JSON.stringify(got));
});

// f) prefixed AND RFC 4180 quoted, round-trips
["=1,2", '=a"b'].forEach(s => {
  const raw = toCSV([{ A: s }]);
  const want = "\"'" + s.replace(/"/g, '""') + '"';
  check("f) quoted " + JSON.stringify(s), raw.endsWith("\r\n" + want), "tail " + JSON.stringify(raw.slice(-12)));
  check("f) round-trip " + JSON.stringify(s), firstData(s) === "'" + s, "got " + JSON.stringify(firstData(s)));
});

// g) array: guard applies to the joined string
(() => {
  const got = firstData(["=1+1", "x"]);
  check("g) array prefixed", got === "'=1+1; x", "got " + JSON.stringify(got));
})();

// h) BOM + sep=, booleans and null
(() => {
  const out = toCSV([{ A: true, B: false, C: null }]);
  check("h) BOM then sep=,", out.charCodeAt(0) === 0xFEFF && out.slice(1).split("\r\n")[0] === "sep=,",
    JSON.stringify(out.slice(0, 8)));
  const p = parse(out.slice(1));
  check("h) true/false/null -> Yes/No/\"\"", JSON.stringify(p[2]) === '["Yes","No",""]', "got " + JSON.stringify(p[2]));
})();

if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
