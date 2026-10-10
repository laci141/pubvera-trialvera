// XLSX frozen header test: rows 1-2 (provenance caption + column header) stay put.
//
// Run: node tools/export_xlsx_freeze_test.js
//
// xlsx-js-style 1.2.0 cannot write a pane, so downloadXLSX writes the workbook
// to bytes, injects <pane .../> into xl/worksheets/sheet1.xml through the zip
// handler bundled in SheetJS (XLSX.CFB) and downloads the patched bytes. This
// slices the REAL freezeHeaderXml / freezeXlsxBytes / downloadXLSX out of
// index.html (no copies of the logic) and checks:
//   1. freezeHeaderXml on both <sheetView> forms, on input that already has a
//      pane and on input without a sheetView;
//   2. the fallback: when any step of the post-process throws, the unpatched
//      workbook goes out through XLSX.writeFile exactly as before;
//   3. end to end against the REAL xlsx-js-style 1.2.0 bundle: the downloaded
//      bytes hold state="frozen" + topLeftCell="A3", and everything else in the
//      file (cells, number formats, styles, autoFilter) is unchanged.
// Part 3 needs the bundle file (the repo has no node_modules). It is looked up in
// $XLSX_JS_STYLE_BUNDLE, then the local temp folder, and must hash to the SRI
// value in index.html (= byte-identical to what browsers run). Without it part 3
// prints SKIP and the run still passes, so CI (no node_modules) is not broken.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("Export suite (CSV");
const end = html.indexOf("// ── metaRow");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export-suite section in index.html");
  process.exit(1);
}
const suite = html.slice(html.indexOf("\n", start) + 1, end);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + " = " + JSON.stringify(actual) +
    (ok ? "" : "  (expected " + JSON.stringify(expected) + ")"));
}

const PANE = '<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>';
const NAMES = ["lastData", "registerView", "downloadXLSX", "freezeHeaderXml", "freezeXlsxBytes"];

// Fresh vm context per scenario. `XLSX` is a global of the context, as in the
// browser; `setup(sandbox)` may run the real bundle before the suite loads.
function makeContext(XLSXStub, bundleCode) {
  const downloads = [];
  const sandbox = {
    console, Date, TextDecoder, TextEncoder, Blob,
    alert: m => { throw new Error("alert: " + m); },
    window: { location: { origin: "http://localhost:8199" } },
    URL: { createObjectURL: b => { downloads.push(b); return "blob:test"; }, revokeObjectURL: () => {} },
    document: {
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ click: () => {} }),
      body: { appendChild: () => {}, removeChild: () => {} },
    },
    __expose: {},
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  if (bundleCode) vm.runInContext(bundleCode, sandbox, { filename: "xlsx.bundle.js" });
  else sandbox.XLSX = XLSXStub;
  // typeof guard: before the change freezeHeaderXml does not exist, and the
  // checks below must report FAIL lines rather than die on a ReferenceError.
  vm.runInContext(
    suite + "\n" + NAMES.map(n => `__expose[${JSON.stringify(n)}]=typeof ${n}==="undefined"?undefined:${n};`).join(""),
    sandbox, { filename: "export-suite.js" });
  const S = sandbox.__expose;
  const rows = [{ id: "NCT07534098", title: "T", status: "RECRUITING", phase: "PHASE2", enrollment: 120,
    sponsor: "A", start_date: "2027-04-01", primary_completion_date: "2027-04", completion_date: "2028-12-31",
    first_posted: "2026-08-21", last_update: "2026-08-21", sponsor_class: "INDUSTRY", has_results: false,
    source: "clinicaltrials.gov" }];
  S.lastData.search = { rows, query: "q", response: { command: "search", result: {} } };
  S.registerView("search", () => ({ rows, filters: [] }));
  return { sandbox, S, downloads };
}

// ── 1: freezeHeaderXml (pure) ──
const probe = makeContext({});
const freezeHeaderXml = probe.S.freezeHeaderXml || (() => "freezeHeaderXml is not defined");
const wrap = sv => '<worksheet><dimension ref="A1"/>' + sv + '<sheetData/></worksheet>';

check("self-closing <sheetView/> gets the exact pane inside sheetView",
  freezeHeaderXml(wrap('<sheetViews><sheetView workbookViewId="0"/></sheetViews>')),
  wrap('<sheetViews><sheetView workbookViewId="0">' + PANE + '</sheetView></sheetViews>'));
check("open/close <sheetView> gets the pane as first child",
  freezeHeaderXml(wrap('<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1"/></sheetView></sheetViews>')),
  wrap('<sheetViews><sheetView workbookViewId="0">' + PANE + '<selection activeCell="A1"/></sheetView></sheetViews>'));
const withPane = wrap('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" state="frozen"/></sheetView></sheetViews>');
check("input that already has <pane is unchanged", freezeHeaderXml(withPane), withPane);
const noView = wrap("");
check("input without sheetView is unchanged", freezeHeaderXml(noView), noView);
const onlyViews = '<worksheet><sheetViews></sheetViews></worksheet>';
check("<sheetViews> alone is not mistaken for <sheetView>", freezeHeaderXml(onlyViews), onlyViews);
check("only the first sheetView is patched",
  freezeHeaderXml('<sheetViews><sheetView workbookViewId="0"/><sheetView workbookViewId="1"/></sheetViews>'),
  '<sheetViews><sheetView workbookViewId="0">' + PANE + '</sheetView><sheetView workbookViewId="1"/></sheetViews>');

// ── 2: fallback with a minimal XLSX stub whose post-process steps throw ──
function stubXLSX(overrides) {
  const calls = { writeFile: [] };
  const colName = c => { let s = ""; for (c = c + 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s; return s; };
  const encode_cell = ({ r, c }) => colName(c) + (r + 1);
  const X = {
    utils: {
      aoa_to_sheet: aoa => ({ A1: { t: "s", v: "x" }, "!ref": "A1:A" + aoa.length }),
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
      encode_cell,
      encode_range: ({ s, e }) => encode_cell(s) + ":" + encode_cell(e),
      book_new: () => ({ marker: "wb" }),
      book_append_sheet: () => {},
    },
    writeFile: (wb, name) => calls.writeFile.push([wb.marker, name]),
    write: () => new ArrayBuffer(8),
    CFB: { read: () => ({}), find: () => ({ content: new Uint8Array(1) }), write: () => new Uint8Array(1) },
  };
  Object.assign(X, overrides);
  return { X, calls };
}
function runStub(label, overrides) {
  const { X, calls } = stubXLSX(overrides);
  const ctx = makeContext(X);
  if (!ctx.S.downloadXLSX) { check(label + ": downloadXLSX exists", false, true); return; }
  ctx.S.downloadXLSX("search", "t.xlsx");
  check(label + " -> unpatched workbook via XLSX.writeFile, no patched download",
    [calls.writeFile, ctx.downloads.length], [[["wb", "t.xlsx"]], 0]);
}
runStub("XLSX.write throws", { write: () => { throw new Error("boom"); } });
runStub("CFB.read throws", { CFB: { read: () => { throw new Error("boom"); } } });
runStub("sheet1.xml missing", { CFB: { read: () => ({}), find: () => null } });
runStub("CFB.write throws", {
  CFB: { read: () => ({}), find: () => ({ content: new TextEncoder().encode('<sheetView workbookViewId="0"/>') }),
    write: () => { throw new Error("boom"); } } });

// ── 3: end to end against the real xlsx-js-style 1.2.0 bundle ──
const bundlePath = process.env.XLSX_JS_STYLE_BUNDLE ||
  "C:/Users/LACI/tmp-xlsx-check/node_modules/xlsx-js-style/dist/xlsx.bundle.js";
const sriWanted = (/xlsx-js-style@1\.2\.0\/dist\/xlsx\.bundle\.js"\s+integrity="sha384-([^"]+)"/.exec(html) || [])[1];

(async () => {
  if (!fs.existsSync(bundlePath)) {
    console.log("SKIP  end-to-end against the real bundle: " + bundlePath + " not found (set XLSX_JS_STYLE_BUNDLE)");
  } else {
    const code = fs.readFileSync(bundlePath, "utf8");
    const sri = crypto.createHash("sha384").update(fs.readFileSync(bundlePath)).digest("base64");
    check("bundle file hashes to the SRI value in index.html", sri, sriWanted);

    // patched run: the real post-process
    // writeFile is recorded, never executed (it needs a browser); on code without the
    // post-process it is the path taken, which then shows up as FAIL lines below.
    const a = makeContext(null, code);
    const XLSX = a.sandbox.XLSX;
    let aWriteFile = null;
    a.sandbox.XLSX = Object.assign(Object.create(XLSX), { writeFile: (wb, name) => { aWriteFile = name; } });
    a.S.downloadXLSX("search", "real.xlsx");
    check("patched run downloads exactly one blob and does not use XLSX.writeFile", [a.downloads.length, aWriteFile], [1, null]);
    if (a.downloads.length !== 1) {
      console.log("\n" + failed + " CHECK(S) FAILED (no patched download, remaining end-to-end checks need it)");
      process.exit(1);
    }
    const patched = new Uint8Array(await a.downloads[0].arrayBuffer());

    // unpatched run: force the fallback, then write the workbook it handed to writeFile
    const b = makeContext(null, code);
    const realX = b.sandbox.XLSX;
    let fallbackName = null, firstWrite = null;
    b.sandbox.XLSX = Object.assign(Object.create(realX), {
      CFB: Object.assign({}, realX.CFB, { write: () => { throw new Error("boom"); } }),
      // The first write of a workbook is what the patched run also starts from. (A second
      // write of the same workbook dedupes styles differently, so it is not the baseline.)
      write: (...args) => { const r = realX.write(...args); firstWrite = firstWrite || new Uint8Array(r).slice(); return r; },
      writeFile: (wb, name) => { fallbackName = name; },
    });
    b.S.downloadXLSX("search", "real.xlsx");
    check("fallback run: no blob, writeFile called with the file name", [b.downloads.length, fallbackName], [0, "real.xlsx"]);
    const plain = firstWrite;

    const part = (bytes, p) => new TextDecoder().decode(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: "array" }), p).content);
    const sheetP = part(patched, "/xl/worksheets/sheet1.xml"), sheetU = part(plain, "/xl/worksheets/sheet1.xml");
    check("downloaded bytes are a zip", String.fromCharCode(patched[0], patched[1]), "PK");
    check("sheet1.xml has state=\"frozen\"", sheetP.includes('state="frozen"'), true);
    check("sheet1.xml has topLeftCell=\"A3\"", sheetP.includes('topLeftCell="A3"'), true);
    check("pane sits inside <sheetView>",
      sheetP.includes('<sheetViews><sheetView workbookViewId="0">' + PANE + '</sheetView></sheetViews>'), true);
    check("unpatched sheet1.xml has no pane", sheetU.includes("<pane"), false);
    check("sheet1.xml identical apart from the pane",
      sheetP.replace(PANE, "").replace(/<sheetView workbookViewId="0"><\/sheetView>/, '<sheetView workbookViewId="0"/>'), sheetU);
    check("autoFilter A2:R3 kept", (/<autoFilter[^>]*>/.exec(sheetP) || [])[0], '<autoFilter ref="A2:R3"/>');
    check("styles.xml (date numFmt, header style) identical",
      part(patched, "/xl/styles.xml") === part(plain, "/xl/styles.xml") && /yyyy-mm-dd/.test(part(patched, "/xl/styles.xml")), true);
    const names = bytes => XLSX.CFB.read(bytes, { type: "array" }).FullPaths.slice().sort();
    check("same zip entries", names(patched), names(plain));
    const cells = bytes => {
      const ws = XLSX.read(bytes, { type: "array", cellNF: true }).Sheets.Trialvera;
      return Object.keys(ws).sort().map(k => [k, JSON.stringify(ws[k])]);
    };
    check("XLSX.read of the patched file returns the same cells (t, v, z) as the unpatched one",
      cells(patched), cells(plain));
    check("patched file: start date is still a date-formatted number",
      (c => [c.t, c.v, c.z])(XLSX.read(patched, { type: "array", cellNF: true }).Sheets.Trialvera.I3), ["n", 46478, "yyyy-mm-dd"]);
  }
  console.log(failed ? "\n" + failed + " CHECK(S) FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})();
