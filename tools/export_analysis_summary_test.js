// export_analysis_summary_test.js — guards two provenance defects in the exports
// of analyses that have no trial list.
//
// Run: node tools/export_analysis_summary_test.js
//
//   A1 The FDA safety export said `source: "ClinicalTrials.gov"` in the JSON
//      envelope, in the CSV/XLSX/BibTeX provenance header and in the BibTeX
//      note, although its numbers are FAERS adverse-event counts. Trial lists
//      keep ClinicalTrials.gov.
//   A2 The JSON export kept only the row array. Velocity lost the recent/prior
//      totals and growth percentages its per-year rows were summarised into
//      (so a file showed 9 year buckets but not "+24%" or the windows behind it),
//      and safety lost total_reports and the drug-name resolution. Those siblings
//      of the rows now travel in export.summary. Trial lists get no summary.
//
// Fixtures have the shape of the real result objects (printing-press-library
// velocity.go and safety.go) and of the exports measured on 2026-11-25.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("Export suite (CSV");
const end = html.indexOf("// ── metaRow");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export-suite section in index.html");
  process.exit(1);
}
const suite = html.slice(html.indexOf("\n", start) + 1, end);

const sandbox = {
  console, Date,
  alert: () => {},
  window: { location: { origin: "http://localhost:8199" } },
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({}) },
  __expose: {},
};
const names = ["lastData", "exportHeader", "csvExport", "bibExport", "jsonExport", "analysisSummary"];
vm.runInNewContext(
  suite + "\n" + names.map(n => `__expose[${JSON.stringify(n)}]=${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;

let ran = 0, failed = 0;
function check(label, ok) {
  ran++; if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const velocity = {
  query: "long covid", sample_size: 400, window_years: 3,
  recent_trials: 221, prior_trials: 178, trial_growth_pct: 24,
  recent_enrollment: 52000, prior_enrollment: 41000, enrollment_growth_pct: 27,
  by_year: [{ year: 2016, trials: 1, enrollment: 6000 }, { year: 2019, trials: 2, enrollment: 360 }],
  note: "Counts are over a sample.",
};
const safety = {
  query: "psilocybin", normalized_name: "psilocybin", resolved: true,
  searched_as: "psilocybin", total_reports: 412,
  top_reactions: [{ reaction: "drug diversion", count: 72 }, { reaction: "drug abuse", count: 27 }],
};

function load(key, result, rows) {
  S.lastData[key] = { rows, query: "q", response: { command: key, result } };
  return S.jsonExport(key);
}

const vj = load("velocity", velocity, velocity.by_year);
const sj = load("safety", safety, safety.top_reactions);

// A1 source
check("A1a safety JSON source is FDA FAERS", sj.export.source === "FDA FAERS");
check("A1b velocity JSON source stays ClinicalTrials.gov", vj.export.source === "ClinicalTrials.gov");
const sRows = safety.top_reactions;
check("A1c safety header names FAERS", S.exportHeader("safety", sRows).includes("source: FDA FAERS") && !S.exportHeader("safety", sRows).includes("source: ClinicalTrials.gov"));
check("A1d velocity header keeps ClinicalTrials.gov", S.exportHeader("velocity", velocity.by_year).includes("source: ClinicalTrials.gov"));
const sb = S.bibExport("safety");
check("A1e safety BibTeX credits FAERS, not the registry", sb.includes("data from FDA FAERS") && !sb.includes("registry data from ClinicalTrials.gov"));
check("A1f velocity BibTeX keeps the registry note", S.bibExport("velocity").includes("registry data from ClinicalTrials.gov"));

// A2 summary
check("A2a velocity summary carries the totals", same(
  [vj.export.summary.recent_trials, vj.export.summary.prior_trials, vj.export.summary.trial_growth_pct, vj.export.summary.window_years, vj.export.summary.sample_size],
  [221, 178, 24, 3, 400]));
check("A2b velocity summary carries enrollment growth and the note",
  vj.export.summary.enrollment_growth_pct === 27 && vj.export.summary.note === "Counts are over a sample.");
check("A2c velocity summary leaves the rows out", !("by_year" in vj.export.summary));
check("A2d velocity rows are still the year buckets", same(vj.rows, velocity.by_year));
check("A2e safety summary carries total_reports and the resolution",
  sj.export.summary.total_reports === 412 && sj.export.summary.resolved === true && sj.export.summary.normalized_name === "psilocybin");
check("A2f safety summary leaves the reactions out", !("top_reactions" in sj.export.summary));

// Zero and false are values: a drug with no FAERS reports is an honest zero
// ("resolved": false, "total_reports": 0), not a missing field.
const zero = load("safety", { query: "nodrug", resolved: false, total_reports: 0, top_reactions: [{ reaction: "x", count: 0 }] }, [{ reaction: "x", count: 0 }]);
check("A2g zero and false survive in the summary",
  zero.export.summary.total_reports === 0 && zero.export.summary.resolved === false);

// Trial lists, factor-style results and drug comparisons get no summary
const trials = [{ id: "NCT00000001", title: "t", status: "RECRUITING" }];
check("A3a trial list: no summary", S.analysisSummary({ count: 1, total_matching: 9 }, trials) === null);
const factors = [{ id: "NCT00000001", name: "status", points: 0 }];
check("A3b factor rows carry a trial id: no summary", S.analysisSummary({ id: "NCT00000001", score: 0 }, factors) === null);
check("A3c drug comparison with a scalar sibling: no summary", S.analysisSummary({ drug_a: {}, drug_b: {}, query: "a vs b" }, [{ drug: "a" }, { drug: "b" }]) === null);
check("A3d no rows: no summary", S.analysisSummary(velocity, []) === null && S.analysisSummary(velocity, null) === null);
check("A3e only objects and arrays: no summary", S.analysisSummary({ rows: [{ a: 1 }] }, [{ a: 1 }]) === null);
check("A3f search JSON export has no summary key",
  !("summary" in load("search", { count: 1, filtered_count: 0 }, trials).export));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
