// "Review next 60" test.
//
// Run: node tools/review_next_test.js
//
// Live 2026-11-24: a Limit-200 "psilocybin depression" search left 130 of 190
// rows "not reviewed" (among them the phase 3 COMP360 and Usona depression
// trials): one AI call labels at most 60 rows. The button repeats the search
// with review_offset and merges the labels. This slices the REAL helpers out
// of index.html and runs them in a vm sandbox with a fake fetch.
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
const escSrc = "function esc(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}";

const calls = [];
let reply = null;
const keyInput = { value: "sk-ant-test" };
const sandbox = {
  __expose: {}, calls,
  lastData: {},
  API_BASE: "",
  document: { getElementById: () => null },
  $: sel => (sel === "#llmKey" ? keyInput : { value: "anthropic" }),
  authHeaders: async () => ({}),
  httpError: async r => new Error("HTTP " + r.status),
  fetch: async (url, opts) => { calls.push({ url, opts }); return reply; },
};
vm.runInNewContext(escSrc + "\n" + relSrc +
  "\n__expose.f={buildRelIndex,relSummary,relNext,relBlock,mergeReview,reviewNext,REVIEW_BATCH};",
  sandbox, { filename: "review_next.js" });
const { buildRelIndex, relSummary, relNext, mergeReview, reviewNext, REVIEW_BATCH } = sandbox.__expose.f;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail === undefined ? "" : " = " + JSON.stringify(detail)));
}

const id = i => "NCT" + String(10000000 + i).padStart(8, "0");
const rows = Array.from({ length: 190 }, (_, i) => ({ id: id(i), title: "Psilocybin trial " + i }));
const first = { model: "claude-sonnet-5-5", generated_at: "2026-11-24T18:12:57Z", reviewed_to: 60,
  trial_relevance: rows.slice(0, 60).map(r => ({ id: r.id, relevance: "on_topic", reason: "Depression." })) };

function fresh() {
  sandbox.lastData.search = { rows, response: { llm_synthesis: first }, aiRel: buildRelIndex({ llm_synthesis: first }),
    req: { g: "search-discovery", body: { command: "search", query: "psilocybin depression", limit: 200, provider: "anthropic", model: "claude-sonnet-5-5" } },
    reviewedTo: 60, reviewPasses: [] };
  return sandbox.lastData.search;
}

check("batch size is 60", REVIEW_BATCH === 60);

let d = fresh();
let btn = relNext("search");
check("button offers the next 60 rows", btn.includes("Review next 60 trials (61–120 of 190)"), btn);
check("button uses delegated data-action, no inline handler", btn.includes('data-action="reviewNext"') && btn.includes('data-cmd="search"') && !/\son\w+=/.test(btn));
check("button is followed by a live status note", btn.includes('class="rel-next-note" role="status"'));
check("no button without an AI first pass", (sandbox.lastData.x = { rows, reviewedTo: 0 }, relNext("x")) === "");

// Merge: a second label for an already-labelled row never overwrites it.
const review = { model: "gpt-6.2-sol", generated_at: "2026-11-24T18:20:00Z", reviewed_to: 120,
  trial_relevance: [{ id: id(59), relevance: "off_topic", reason: "late duplicate" },
    ...rows.slice(60, 120).map(r => ({ id: r.id, relevance: "partial", reason: "Other condition." }))] };
const added = mergeReview(d, review, 60);
check("merge adds the 60 new labels", added === 60, added);
check("merge keeps the first label of a row", d.aiRel[id(59)].relevance === "on_topic", d.aiRel[id(59)]);
check("merge advances reviewedTo to the server's reviewed_to", d.reviewedTo === 120);
check("merge records the pass with model and time", d.reviewPasses.length === 1 && d.reviewPasses[0].from === 61 &&
  d.reviewPasses[0].to === 120 && d.reviewPasses[0].model === "gpt-6.2-sol", d.reviewPasses[0]);
const sum = relSummary(null, d.aiRel);
check("summary counts the merged labels", sum.includes("first 120 trials") && sum.includes("60 on-topic · 60 partly related · 0 off-topic"), sum);
btn = relNext("search");
check("next button moves on to 121–180", btn.includes("(121–180 of 190)"), btn);
check("the pass is listed with model and time", btn.includes("Trials 61–120 reviewed by gpt-6.2-sol"), btn);

let threw = false;
try { mergeReview(d, { reviewed_to: 120, trial_relevance: [] }, 120); } catch (e) { threw = true; }
check("no progress from the server throws (the button cannot loop)", threw);

d.reviewedTo = 180;
btn = relNext("search");
check("last batch is sized to what is left", btn.includes("Review next 10 trials (181–190 of 190)"), btn);
d.reviewedTo = 190;
check("no button once every row is reviewed", !relNext("search").includes("rel-next\""), relNext("search"));

// reviewNext: request contract and error path, with a fake fetch.
const note = { textContent: "" };
const fakeBtn = { textContent: "🤖 Review next 60 trials (61–120 of 190)", disabled: false, parentNode: { querySelector: () => note } };
(async () => {
  d = fresh();
  reply = { ok: true, status: 200, json: async () => ({ llm_source: "llm:anthropic", llm_synthesis: review }) };
  await reviewNext("search", fakeBtn);
  const c = calls[0];
  const body = c && JSON.parse(c.opts.body);
  check("request goes to the same group endpoint", c && c.url === "/api/search-discovery", c && c.url);
  check("request repeats the search with review_offset 60", body && body.review_offset === 60 && body.query === "psilocybin depression" && body.limit === 200, body);
  check("key travels only in the header", c && c.opts.headers["X-LLM-Key"] === "sk-ant-test" && !JSON.stringify(body).includes("sk-ant"));
  check("provider header from the original run", c && c.opts.headers["X-LLM-Provider"] === "anthropic");
  check("answer merged into lastData", d.reviewedTo === 120 && Object.keys(d.aiRel).length === 120);

  // Error path: labels stay, the button comes back with its label.
  reply = { ok: true, status: 200, json: async () => ({ llm_error: "the model claude-sonnet-5-5 did not answer within 60 seconds" }) };
  // In the page refreshRel replaced the used button; here the fake one is reset.
  fakeBtn.disabled = false; fakeBtn.textContent = "🤖 Review next 60 trials (121–180 of 190)";
  await reviewNext("search", fakeBtn);
  check("failure keeps the labels so far", d.reviewedTo === 120 && Object.keys(d.aiRel).length === 120);
  check("failure re-enables the button with its label", !fakeBtn.disabled && fakeBtn.textContent.startsWith("🤖 Review next"));
  check("failure says what happened and that labels are kept", note.textContent.includes("did not answer within 60 seconds. The labels so far are kept."), note.textContent);

  // No key: nothing is sent.
  const before = calls.length;
  keyInput.value = "";
  await reviewNext("search", fakeBtn);
  check("no key: no request, a hint instead", calls.length === before && note.textContent.includes("Enter your AI key"), note.textContent);
  keyInput.value = "sk-ant-test";

  // Unknown command name from markup is ignored.
  let threwUnknown = false;
  try { await reviewNext("__proto__", fakeBtn); await reviewNext("nope", fakeBtn); } catch (e) { threwUnknown = true; }
  check("unknown data-cmd is ignored", calls.length === before && !threwUnknown);

  // Wiring in index.html.
  check("delegated click handler wires reviewNext", html.includes('else if(a==="reviewNext")reviewNext(b.dataset.cmd,b);'));
  check("panel renders the review block", html.includes("${relBlock(s,renderRelCmd)}"));
  check("run() keeps the request body for the review pass", html.includes("req:{g,body},reviewedTo:"));
  check("JSON export carries the review passes", html.includes("meta.ai.review_passes=d.reviewPasses"));
  check("JSON export carries the merged labels", html.includes("if(merged.length)meta.ai.trial_relevance=merged;"));
  check("CSV/Excel header names every review pass", html.includes('"AI review of trials "+p.from+"–"+p.to+": "'));

  console.log((failed ? failed + " FAILED" : "all passed"));
  process.exit(failed ? 1 : 0);
})();
