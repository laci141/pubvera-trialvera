// safety_export_terms_test.js — guards the FDA safety export fixes of 2026-11-25.
//
// Run: node tools/safety_export_terms_test.js
//
//   S1 "153 rows" / "153 retrieved" / "Analysis of 153 records" sat next to
//      total_reports 144: a safety row is a reaction TERM and one FAERS report
//      lists several, so a reader took 153 for the number of reports. The unit
//      is spelled out and the report count is stated in the header, the BibTeX
//      note and (as row_unit) the JSON envelope.
//   S2 Every analysis BibTeX had the SAME cite key and title whatever the query
//      (trialvera_safety_2026), so psilocybin and aspirin collided in Zotero and
//      Mendeley. The key and title now carry the query; entries get an urldate.
//   S3 The JSON export named the AI model but dropped what it said. The summary,
//      key points, caveats and the disclaimer now travel in export.ai.
//   S4 The safety view showed an "All phases" menu although FAERS rows have no
//      phase. The menu is left out there and stays everywhere else.
//   S5 The screen said "153 rows · safety" and "153 / 153 rows" while the files
//      said reaction terms; the result line and the live counter use the unit.
//
// Fixtures follow the real psilocybin export (153 reaction terms, 144 reports).
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
  fmtStamp: s => String(s),
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({}) },
  __expose: {},
};
const names = ["lastData", "exportHeader", "csvExport", "bibExport", "jsonExport", "bibSlug", "rowUnit"];
vm.runInNewContext(
  suite + "\n" + names.map(n => `__expose[${JSON.stringify(n)}]=${n};`).join(""),
  sandbox, { filename: "export-suite.js" });
const S = sandbox.__expose;

// metaRow alone, as the other export tests extract it.
const mStart = html.indexOf("function metaRow(");
const mEnd = html.indexOf("\n}\n", mStart) + 3;
if (mStart < 0 || mEnd < 3) { console.error("FAIL: could not locate metaRow"); process.exit(1); }
const mctx = { esc: s => String(s) };
vm.runInNewContext(html.slice(mStart, mEnd) + "\n__m=metaRow;", mctx, { filename: "metaRow.js" });

let ran = 0, failed = 0;
function check(label, ok) {
  ran++; if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const year = String(new Date().getFullYear());
const reactions = [];
for (let i = 0; i < 153; i++) reactions.push({ reaction: "term " + i, count: i === 0 ? 72 : 1 });
const safetyResult = { query: "psilocybin", normalized_name: "Psilocybin", resolved: true, searched_as: "Psilocybin", total_reports: 144, top_reactions: reactions };
const synthesis = {
  model: "claude-sonnet-5-5", generated_at: "2026-11-25T16:27:51Z",
  summary: "The tool returned 144 adverse-event reports.",
  key_points: ["Total reports: 144.", "Top term: drug diversion (72)."],
  caveats: ["Counts are reports, not rates."],
  not_advice: "It does not recommend starting or stopping any treatment.",
};
function load(key, query, result, rows, syn) {
  S.lastData[key] = { rows, query, response: { command: key, result, llm_source: syn ? "llm:anthropic" : undefined, llm_synthesis: syn || undefined } };
}

// ── S1 ──
load("safety", "psilocybin", safetyResult, reactions, synthesis);
const h = S.exportHeader("safety", reactions);
check("S1a header says 153 reaction terms", h.includes(" · 153 reaction terms · "));
check("S1b header states 144 reports", h.includes(" · 144 reports · "));
check("S1c header no longer says 153 rows or 153 retrieved", !/153 rows/.test(h) && !/153 retrieved/.test(h));
check("S1d filtered view reads 'showing 10 of 153 reaction terms'", S.exportHeader("safety", reactions.slice(0, 10)).includes("showing 10 of 153 reaction terms"));
check("S1e CSV first line carries both numbers", S.csvExport("safety").includes("153 reaction terms") && S.csvExport("safety").includes("144 reports"));
check("S1f singular forms", S.rowUnit("safety", 1) === "reaction term" && S.rowUnit("safety", 2) === "reaction terms");
load("safety", "x", { total_reports: 1, top_reactions: [{ reaction: "a", count: 1 }] }, [{ reaction: "a", count: 1 }]);
check("S1g one term, one report", S.exportHeader("safety", [{ reaction: "a", count: 1 }]).includes(" · 1 reaction term · 1 report · "));
load("safety", "nodrug", { total_reports: 0, top_reactions: [{ reaction: "a", count: 0 }] }, [{ reaction: "a", count: 0 }]);
check("S1h zero reports is stated, not dropped", S.exportHeader("safety", [{ reaction: "a", count: 0 }]).includes(" · 0 reports · "));
const velRows = [{ year: 2019, trials: 2 }, { year: 2020, trials: 3 }];
load("velocity", "long covid", { query: "long covid", trial_growth_pct: 24 }, velRows);
const vh = S.exportHeader("velocity", velRows);
check("S1i velocity keeps '2 rows' and 'retrieved'", vh.includes(" · 2 rows · ") && vh.includes("2 retrieved") && !vh.includes("reaction"));
load("safety", "psilocybin", safetyResult, reactions, synthesis);
const sj = S.jsonExport("safety");
check("S1j JSON names the row unit", sj.export.row_unit === "reaction term");
check("S1k JSON keeps rows_exported 153 and total_reports 144", sj.export.rows_exported === 153 && sj.export.summary.total_reports === 144);
load("velocity", "long covid", { query: "long covid" }, velRows);
check("S1l velocity JSON has no row_unit", !("row_unit" in S.jsonExport("velocity").export));

// ── S2 ──
load("safety", "psilocybin", safetyResult, reactions, synthesis);
const bib = S.bibExport("safety");
check("S2a cite key carries the query", bib.includes("@misc{trialvera_safety_psilocybin_" + year + ","));
check("S2b title carries the query", bib.includes("title        = {FDA safety signals: psilocybin}"));
check("S2c urldate is an ISO date", /urldate\s+=\s+\{\d{4}-\d{2}-\d{2}\}/.test(bib));
check("S2d note counts terms and reports", bib.includes("note         = {Analysis of 153 reaction terms from 144 reports; data from FDA FAERS}"));
check("S2e note no longer says 153 records", !bib.includes("153 records"));
load("safety", "aspirin", Object.assign({}, safetyResult, { total_reports: 9 }), reactions, null);
const bib2 = S.bibExport("safety");
const keyOf = b => (b.match(/@misc\{([^,]+),/) || [])[1];
check("S2f two queries, two different cite keys", keyOf(bib) !== keyOf(bib2) && keyOf(bib2) === "trialvera_safety_aspirin_" + year);
check("S2g slug is ASCII and strips accents", S.bibSlug("Ibuprofen & Caffeine") === "ibuprofen_caffeine" && S.bibSlug("Ünïcode Drüg") === "unicode_drug");
check("S2h slug is capped and has no trailing underscore", S.bibSlug("a".repeat(39) + " b") === "a".repeat(39) && S.bibSlug("x".repeat(80)).length === 40);
check("S2i empty or non-Latin query leaves the key without a slug", S.bibSlug("") === "" && S.bibSlug("日本") === "" && S.bibSlug(null) === "");
load("safety", "", Object.assign({}, safetyResult), reactions, null);
check("S2j no query: key and title keep their old shape", keyOf(S.bibExport("safety")) === "trialvera_safety_" + year && S.bibExport("safety").includes("title        = {FDA safety signals}"));
load("safety", "ibuprofen & caffeine", safetyResult, reactions, null);
check("S2k query is BibTeX-escaped in the title", S.bibExport("safety").includes("title        = {FDA safety signals: ibuprofen \\& caffeine}"));
load("velocity", "long covid", { query: "long covid" }, velRows);
check("S2l velocity key and title carry the query too", keyOf(S.bibExport("velocity")) === "trialvera_velocity_long_covid_" + year && S.bibExport("velocity").includes(": long covid}"));
check("S2m velocity note keeps '2 records' and the registry", S.bibExport("velocity").includes("Analysis of 2 records; registry data from ClinicalTrials.gov"));

// ── S3 ──
load("safety", "psilocybin", safetyResult, reactions, synthesis);
const ai = S.jsonExport("safety").export.ai;
check("S3a summary text is in the JSON", ai.summary === synthesis.summary);
check("S3b key points and caveats are in the JSON", JSON.stringify(ai.key_points) === JSON.stringify(synthesis.key_points) && JSON.stringify(ai.caveats) === JSON.stringify(synthesis.caveats));
check("S3c disclaimer travels with the text", typeof ai.disclaimer === "string" && ai.disclaimer.startsWith("AI-generated summary") && ai.disclaimer.endsWith(synthesis.not_advice));
check("S3d model, source and time are still there", ai.model === "claude-sonnet-5-5" && ai.source === "llm:anthropic" && ai.generated_at === "2026-11-25T16:27:51Z");
const bare = Object.assign({}, synthesis); delete bare.not_advice; delete bare.key_points; delete bare.caveats;
load("safety", "psilocybin", safetyResult, reactions, bare);
const ai2 = S.jsonExport("safety").export.ai;
check("S3e missing lists are left out, default disclaimer used", !("key_points" in ai2) && !("caveats" in ai2) && typeof ai2.disclaimer === "string" && ai2.disclaimer.endsWith("Informational only — not medical advice."));
load("safety", "psilocybin", safetyResult, reactions, null);
check("S3f no AI run: no ai block", !("ai" in S.jsonExport("safety").export));

// ── S4 ──
const safetyBar = mctx.__m("153 rows · safety", "safety", "trialvera-safety.json");
check("S4a safety toolbar has no phase menu", !safetyBar.includes("phasefilter") && !safetyBar.includes("All phases"));
check("S4b safety toolbar keeps the text filter and the Export menu", safetyBar.includes('class="qfilter"') && safetyBar.includes("dl-trigger"));
["search", "risk", "velocity", "sponsors"].forEach(k => {
  const bar = mctx.__m("5 rows · " + k, k, "trialvera-" + k + ".json");
  check("S4c " + k + " toolbar keeps the phase menu", bar.includes('class="phasefilter"') && bar.includes("All phases"));
});

// ── S5: the on-screen counts use the same unit as the files ──
const qStart = html.indexOf("function refreshQCount(");
const qEnd = html.indexOf("\n}\n", qStart) + 3;
const rStart = html.indexOf("function resultMetaRow(");
const rEnd = html.indexOf("\n}\n", rStart) + 3;
if (qStart < 0 || rStart < 0) { console.error("FAIL: could not locate refreshQCount/resultMetaRow"); process.exit(1); }
vm.runInNewContext(html.slice(mStart, mEnd) + "\n" + html.slice(qStart, qEnd) + "\n" + html.slice(rStart, rEnd) +
  "\nvar esc=s=>String(s);__expose.refreshQCount=refreshQCount;__expose.resultMetaRow=resultMetaRow;", sandbox, { filename: "counts.js" });
function counter(key, n, hidden) {
  const rows = Array.from({ length: n }, (_, i) => ({ style: { display: i < hidden ? "none" : "" } }));
  const qc = { textContent: "" };
  const wrap = key ? { getAttribute: a => (a === "data-exportkey" ? key : null) } : null;
  S.refreshQCount({ querySelectorAll: sel => (sel === "[data-ri]" ? rows : []),
    querySelector: sel => (sel === ".qcount" ? qc : sel === "[data-exportkey]" ? wrap : null) });
  return qc.textContent;
}
check("S5a safety counter reads '153 / 153 reaction terms'", counter("safety", 153, 0) === " · 153 / 153 reaction terms");
check("S5b velocity counter keeps 'rows'", counter("velocity", 9, 2) === " · 7 / 9 rows");
check("S5c no wrapper keeps 'rows'", counter(null, 3, 0) === " · 3 / 3 rows");
load("safety", "psilocybin", safetyResult, reactions, null);
const top = S.resultMetaRow("safety");
check("S5d safety result line says '153 reaction terms · safety'", top.includes(">153 reaction terms · safety<"));
load("velocity", "long covid", { query: "long covid" }, velRows);
check("S5e velocity result line keeps '2 rows · velocity'", S.resultMetaRow("velocity").includes(">2 rows · velocity<"));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
