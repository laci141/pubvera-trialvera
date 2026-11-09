// Error cards are announced: every errorHTML() result is role="alert".
//
// Run: node tools/error_alert_test.js
//
// A failed command replaces the contents of #res with the markup errorHTML()
// builds. #res is not a live region (it also receives whole result tables, which
// must not be read out), so a screen reader user heard nothing: the Run button
// seemed to do nothing. role="alert" on the card root makes the browser announce
// exactly that card. This runs the REAL errorHTML() in a vm for every branch:
//   E1 each branch returns one root element that carries role="alert";
//   E2 the role appears once per result and the card keeps exactly one heading;
//   E3 the message text is still escaped (no markup from a server message);
//   E4 the Clear button is still offered for an error that reached a server and
//      still not for one that did not (a network failure has no status);
//   E5 the sign-in button in the 401 card is still there.
// A function that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

function sliceFunction(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return "";
}

const errSrc = sliceFunction("errorHTML");
const resetSrc = sliceFunction("resetsAtText");
const escLine = (html.match(/^const esc=.*;$/m) || [""])[0];
check("errorHTML found", errSrc !== "");
check("resetsAtText found", resetSrc !== "");
check("esc helper found", escLine !== "");

function build(win) {
  const sandbox = { window: win };
  vm.createContext(sandbox);
  vm.runInContext(escLine + "\n" + resetSrc + "\n" + errSrc + "\nthis.errorHTML = errorHTML;", sandbox);
  return sandbox.errorHTML;
}
const signedOut = { pubveraAuth: { enabled: true } };
const noScript = { pubveraAuth: { unavailable: true } };

const cases = [
  ["401 sign-in unavailable", noScript, { status: 401 }],
  ["401 sign-in required", signedOut, { status: 401 }],
  ["403 app locked", signedOut, { status: 403, data: { reason: "app_locked" } }],
  ["403 quota used up", signedOut, { status: 403, data: { resets_at: "2026-12-01T00:00:00Z" } }],
  ["503 temporarily unavailable", signedOut, { status: 503, data: { error: "all slots busy" } }],
  ["500 generic", signedOut, { status: 500, message: "HTTP 500" }],
  ["network failure (no status)", signedOut, { message: "Failed to fetch" }],
];

for (const [label, win, err] of cases) {
  const errorHTML = errSrc && resetSrc && escLine ? build(win) : null;
  const out = errorHTML ? errorHTML(err) : "";
  const root = out.match(/^<div class="(errcard|rcard)"([^>]*)>/);
  check("E1 " + label + ": root element has role=\"alert\"", !!root && / role="alert"/.test(root[2]));
  check("E2 " + label + ": one role=\"alert\" and one heading",
    (out.match(/role="alert"/g) || []).length === 1 && (out.match(/<h[1-6][\s>]/g) || []).length === 1);
}

const errorHTML = errSrc && resetSrc && escLine ? build(signedOut) : null;
const evil = errorHTML ? errorHTML({ status: 500, message: "<img src=x onerror=alert(1)>" }) : "";
check("E3 a server message is escaped", evil !== "" && evil.indexOf("<img") < 0 && evil.indexOf("&lt;img") >= 0);
check("E4 an error with a status keeps the Clear button", errorHTML !== null && /data-action="clear"/.test(errorHTML({ status: 500, message: "x" })));
check("E4 a network failure has no Clear button", errorHTML !== null && !/data-action="clear"/.test(errorHTML({ message: "Failed to fetch" })));
check("E5 the 401 card keeps the sign-in button", errorHTML !== null && /data-action="signIn"/.test(errorHTML({ status: 401 })));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
