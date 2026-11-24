// Per-trial AI relevance + analysis timestamp test.
//
// Run: node tools/ai_relevance_test.js
//
// Live 2026-11-24: an "intermittent fasting" search kept two cilostazol trials
// (condition "Intermittent Claudication"). The model now labels each trial it
// saw; this slices the REAL helpers out of index.html and runs them in a vm
// sandbox: the index built from llm_synthesis, the table chip, the panel
// summary line, the exact local timestamp, and the two export columns.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark, a);
  if (a < 0 || b <= a) { console.error("FAIL: could not locate " + startMark); process.exit(1); }
  return html.slice(a, b);
}
const relSrc = slice("let renderRel=null;", "\n// AI synthesis panel: rendered at the TOP");
const rowSrc = slice("const TRIAL_COLS=", "\nconst isTrialRow=");
const escSrc = "function esc(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}";
const sandbox = { __expose: {} };
vm.runInNewContext(escSrc + "\n" + relSrc + "\n" + rowSrc +
  "\n__expose.f={buildRelIndex,relChip,relSummary,fmtStamp,trialExportRow};",
  sandbox, { filename: "ai_relevance.js" });
const { buildRelIndex, relChip, relSummary, fmtStamp, trialExportRow } = sandbox.__expose.f;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail === undefined ? "" : " = " + JSON.stringify(detail)));
}

const syn = { trial_relevance: [
  { id: "NCT00602407", relevance: "off_topic", reason: "Cilostazol under fasting conditions, not dietary fasting." },
  { id: "NCT04283942", relevance: "on_topic", reason: "Intermittent calorie restriction." },
  { id: "NCT02696421", relevance: "partial", reason: "Ramadan fasting <energy>." },
  { id: "bogus", relevance: "on_topic", reason: "x" },
  { id: "NCT11111111", relevance: "maybe", reason: "x" },
] };
const rel = buildRelIndex({ llm_synthesis: syn });

check("index keeps the 3 valid entries", rel && Object.keys(rel).length === 3, rel && Object.keys(rel));
check("no synthesis -> null index", buildRelIndex({}) === null);
check("empty list -> null index", buildRelIndex({ llm_synthesis: { trial_relevance: [] } }) === null);

const off = relChip("NCT00602407", rel);
check("off-topic chip class + label", off.includes('class="ai-rel ai-rel-off_topic"') && off.includes("🤖 off-topic"), off);
check("chip shows the reason", off.includes("not dietary fasting"));
check("reason is escaped", relChip("NCT02696421", rel).includes("&lt;energy&gt;"));
check("unlabelled trial says not reviewed", relChip("NCT99999999", rel).includes("not reviewed"));

const sum = relSummary(syn);
check("summary counts", sum.includes("first 3 trials") && sum.includes("1 on-topic · 1 partly related · 1 off-topic"), sum);
check("summary empty without labels", relSummary({}) === "");

const stamp = fmtStamp("2026-11-24T16:12:05Z");
check("timestamp shape YYYY-MM-DD HH:MM (UTC±hh:mm)", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/.test(stamp), stamp);
check("bad timestamp passes through", fmtStamp("nope") === "nope");

const rowOff = trialExportRow({ id: "NCT00602407", title: "t" }, rel);
check("export: AI relevance column", rowOff["AI relevance"] === "off-topic", rowOff["AI relevance"]);
check("export: AI relevance reason column", rowOff["AI relevance reason"].startsWith("Cilostazol"), rowOff["AI relevance reason"]);
const rowNone = trialExportRow({ id: "NCT99999999", title: "t" }, rel);
check("export: unlabelled row says not reviewed", rowNone["AI relevance"] === "not reviewed" && rowNone["AI relevance reason"] === "");
const rowNoAI = trialExportRow({ id: "NCT00602407", title: "t" });
check("export: no AI run adds no columns", !("AI relevance" in rowNoAI) && !("AI relevance reason" in rowNoAI));

// The table, panel header and both exports must use these helpers.
check("objTable adds the AI relevance column", html.includes('<td data-label="AI relevance">${relChip(o.id,rel)}</td>'));
check("panel header shows the analysis time", html.includes('" · analysed "+esc(fmtStamp(s.generated_at))'));
check("JSON export carries model + generated_at", html.includes("meta.ai={source:d.response.llm_source||\"\",model:syn.model,generated_at:syn.generated_at||\"\"}"));
check("CSV/Excel header names the model and time", html.includes('parts.push("AI: "+syn.model+(syn.generated_at?" analysed "+fmtStamp(syn.generated_at):""))'));

console.log((failed ? failed + " FAILED" : "all passed"));
process.exit(failed ? 1 : 0);
