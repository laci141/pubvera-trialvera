// Slow-model hint test. Run: node tools/slow_model_hint_test.js
//
// Live 2026-11-24: deepseek-v4-pro gave no AI synthesis (60 s limit). The
// Model field must warn before the run when that model is typed or picked.
"use strict";
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let failed = 0;
const check = (label, ok) => { if (!ok) failed++; console.log((ok ? "PASS" : "FAIL") + "  " + label); };

const m = /const SLOW_MODELS=(\{[^\n]*\});/.exec(html);
check("SLOW_MODELS map exists", !!m);
const map = m ? JSON.parse(m[1]) : {};
check("deepseek-v4-pro has a warning", /may not answer within the 60-second AI limit/.test(map["deepseek-v4-pro"] || ""));
check("warning names the reliable alternative", /deepseek-flash/.test(map["deepseek-v4-pro"] || ""));
check("fast default deepseek-flash has no warning", !("deepseek-flash" in map));
check("hint reads SLOW_MODELS for the typed model", html.includes('hint.textContent=SLOW_MODELS[model.value.trim()]||"";'));
check("typing in Model refreshes the hint",
  html.includes('$("#llmModel").addEventListener("input",e=>{localStorage.setItem("ct_model",e.target.value);updateModelHint();});'));
console.log(failed ? failed + " FAILED" : "all passed");
process.exit(failed ? 1 : 0);
