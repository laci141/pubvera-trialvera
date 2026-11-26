// Recruiting AI relevance labels test.
//
// Run: node tools/recruiting_labels_test.js
//
// Live 2026-11-26: recruiting "long covid" with an AI key showed a summary but
// no AI relevance column, while the list held clear off-topic trials. The server
// now returns trial_relevance and reviewed_to for recruiting; this pins that the
// page renders the column and the step box for a recruiting result, and that
// "Review next" goes to the recruiting command in its own group. It slices the
// REAL helpers out of index.html and runs them in a vm sandbox.
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
const tableSrc = slice("function cellText(", "function nestedArrays(");
const escSrc = "function esc(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}";

const calls = [];
let reply = null;
const sandbox = {
  __expose: {}, calls,
  lastData: {},
  API_BASE: "",
  document: { getElementById: () => null },
  $: sel => (sel === "#llmKey" ? { value: "sk-test" } : { value: "deepseek" }),
  authHeaders: async () => ({}),
  httpError: async r => new Error("HTTP " + r.status),
  fetch: async (url, opts) => { calls.push({ url, opts }); return reply; },
  nctLink: () => "", urlLink: () => "",
  fmtStamp: s => s,
};
vm.runInNewContext(escSrc + "\n" + relSrc + "\n" + tableSrc +
  "\n__expose.f={buildRelIndex,relSteps,reviewNext,objTable,setRel:v=>{renderRel=v;}};",
  sandbox, { filename: "recruiting_labels.js" });
const { buildRelIndex, relSteps, reviewNext, objTable, setRel } = sandbox.__expose.f;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail === undefined ? "" : " = " + JSON.stringify(detail)));
}

const id = i => "NCT" + String(10000000 + i).padStart(8, "0");
const rows = Array.from({ length: 100 }, (_, i) => ({ id: id(i), title: "Long covid trial " + i, status: "RECRUITING" }));
const syn = { model: "deepseek-chat", reviewed_to: 60,
  trial_relevance: [{ id: id(0), relevance: "on_topic", reason: "Long COVID." },
    { id: id(1), relevance: "off_topic", reason: "Healthy volunteers." }] };
const response = { group: "recruiting-watch", command: "recruiting", llm_synthesis: syn };
const d = sandbox.lastData.recruiting = { rows, response, aiRel: buildRelIndex(response),
  req: { g: "recruiting-watch", body: { command: "recruiting", condition: "long covid", limit: 100, provider: "deepseek" } },
  reviewedTo: 60, reviewPasses: [] };

check("recruiting labels are indexed", !!d.aiRel && Object.keys(d.aiRel).length === 2);
setRel(d.aiRel);
const table = objTable(rows, rows);
check("recruiting table has the AI relevance column", table.includes("<th>AI relevance</th>"));
check("off-topic label shows in its row", /data-label="AI relevance">[^]*off-topic/.test(table));
const box = relSteps("recruiting");
check("recruiting result shows the step box", box.includes('class="rel-steps"'));
check("step box offers step 2 for trials 61–100", box.includes("check trials 61–100"));

(async () => {
  reply = { ok: true, json: async () => ({ llm_synthesis: { reviewed_to: 100, trial_relevance: [{ id: id(70), relevance: "partial", reason: "x" }] } }) };
  await reviewNext("recruiting", { textContent: "▶ Step 2", parentNode: { querySelector: () => null } });
  const c = calls[0], body = c && JSON.parse(c.opts.body);
  check("review request goes to the recruiting group", c && c.url === "/api/recruiting-watch", c && c.url);
  check("review request keeps command recruiting and sets review_offset 60", body && body.command === "recruiting" && body.review_offset === 60, body);
  check("review labels merged", !!d.aiRel[id(70)] && d.reviewedTo === 100);
  if (failed) { console.log(failed + " check(s) failed"); process.exit(1); }
  console.log("all recruiting label checks passed");
})();
