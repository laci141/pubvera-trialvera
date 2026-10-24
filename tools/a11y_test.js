// Accessibility source test (A1-A19): programmatic labels, tile keyboard
// access, and the modal dialog contract (role, focus, Escape, Tab trap).
//
// Run: node tools/a11y_test.js
//
// Source check only: index.html is read as text and asserted on. It does NOT
// drive a browser, so real focus movement and screen reader output are not
// verified here.
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// sliceFunction returns the text of "function <name>(...){ ... }" (plain brace
// depth count) or "" when it is missing.
function sliceFunction(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return "";
}

// A1-A4: the four hero fields have a programmatic name.
["heroQuery", "llmKey", "llmProvider", "llmModel"].forEach(function (id, i) {
  const tag = new RegExp("<(?:input|select)[^>]* id=\"" + id + "\"[^>]*>").exec(html);
  const labelled = new RegExp("<label[^>]* for=\"" + id + "\"").test(html) ||
    (tag !== null && /\baria-label=/.test(tag[0]));
  check("A" + (i + 1) + "  #" + id + " has a label for= or an aria-label", labelled);
});

// A5: visually hidden helper class.
check("A5  .sr-only class exists with the clip pattern",
  /\.sr-only\s*\{[^}]*clip:\s*rect\(0[^}]*\}/.test(html));
check("A6  the hero labels use class sr-only",
  /<label\b[^>]*\bclass="sr-only"[^>]*\bfor="heroQuery"|<label\b[^>]*\bfor="heroQuery"[^>]*\bclass="sr-only"/.test(html));

// A7-A9: dialog semantics on the modal.
const modalTag = (/<div\b[^>]*\bid="modal"[^>]*>/.exec(html) || [""])[0];
check("A7  #modal has role=\"dialog\"", /\brole="dialog"/.test(modalTag));
check("A8  #modal has aria-modal=\"true\"", /\baria-modal="true"/.test(modalTag));
const lb = /\baria-labelledby="([^"]+)"/.exec(modalTag);
check("A9  #modal aria-labelledby points to a heading id built in openGroup",
  lb !== null && sliceFunction("openGroup").indexOf("id=\"" + lb[1] + "\"") >= 0);

// A10-A12: tiles are keyboard operable.
const bentoStart = html.indexOf("// ---- build bento ----");
const bentoEnd = html.indexOf("// ---- modal ----");
const bento = bentoStart >= 0 && bentoEnd > bentoStart ? html.slice(bentoStart, bentoEnd) : "";
check("A10 tiles get role=\"button\" and tabindex=\"0\"",
  /role["',\s]+button/.test(bento) && /tabindex["',\s]+0/i.test(bento));
const kd = /addEventListener\("keydown"[\s\S]*?\}\);/.exec(bento);
check("A11 tile keydown handles Enter and Space and calls openGroup",
  kd !== null && kd[0].indexOf('if(e.key==="Enter"||e.key===" ")') >= 0 && /openGroup\(/.test(kd[0]));
check("A12 tile keydown calls preventDefault for Space", kd !== null && /preventDefault\(\)/.test(kd[0]));
check("A13 tiles have a :focus-visible outline", /\.card:focus-visible\s*\{[^}]*outline:/.test(html));

// A14-A17: modal focus management.
const modalStart = html.indexOf("// ---- modal ----");
const modalEnd = html.indexOf("window.__close=closeModal;");
const modalCode = modalStart >= 0 && modalEnd > modalStart ? html.slice(modalStart, modalEnd) : "";
const open = sliceFunction("openGroup");
const close = sliceFunction("closeModal");
check("A14 openGroup remembers document.activeElement and moves focus in",
  /document\.activeElement/.test(modalCode) && /\.focus\(\)/.test(open));
check("A15 closeModal restores focus when the opener is still in the document",
  /document\.contains\(/.test(close) && /\.focus\(\)/.test(close));
check("A16 modal handles Escape and leaves an open export menu to its own handler",
  /"Escape"/.test(modalCode) && /\.dl-menu:not\(\[hidden\]\)/.test(modalCode) && /closeModal\(\)/.test(modalCode));
check("A17 modal traps Tab and Shift+Tab (shiftKey, wraps focus)",
  /"Tab"/.test(modalCode) && /shiftKey/.test(modalCode));

// A18-A19: dynamic modal fields.
const render = sliceFunction("renderFields");
const labels = render.match(/<label[^>]*>/g) || [];
check("A18 every label built in renderFields has for=", labels.length > 0 && labels.every(l => /\bfor=/.test(l)));
check("A19 the Command label in openGroup has for=\"cmdSel\"", /<label\b[^>]*\bfor="cmdSel"/.test(open));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
