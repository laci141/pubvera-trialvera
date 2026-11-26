// Dockerfile apk upgrade test (OpenSSL CVEs fixed in 3.5.9-r1, zlib CVE-2026-4738).
//
// Run: node tools/dockerfile_apk_upgrade_test.js [path/to/Dockerfile]
//
// Asserts on the final stage (after the last FROM), comment lines skipped:
//   exactly one line contains "apk upgrade"; it has --no-cache, zlib,
//   libcrypto3 and libssl3; no "apk upgrade" without a package name; that
//   line comes before the USER line; the final stage has a USER line.
"use strict";
const fs = require("fs");
const path = require("path");

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const file = process.argv[2] || path.join(__dirname, "..", "Dockerfile");
let src = fs.readFileSync(file, "utf8");
if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
src = src.split(CR + LF).join(LF);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const lines = src.split(LF);
let lastFrom = -1;
lines.forEach((l, i) => {
  if (l.trim().startsWith("FROM ")) lastFrom = i;
});
check("Dockerfile has a FROM line", lastFrom >= 0);

const stage = lines.slice(lastFrom + 1).filter((l) => !l.trim().startsWith("#"));
const upgradeIdx = [];
stage.forEach((l, i) => {
  if (l.includes("apk upgrade")) upgradeIdx.push(i);
});
let userIdx = -1;
stage.forEach((l, i) => {
  if (l.trim().startsWith("USER ")) userIdx = i;
});

check("final stage has exactly one apk upgrade line (found " + upgradeIdx.length + ")", upgradeIdx.length === 1);
const line = upgradeIdx.length ? stage[upgradeIdx[0]] : "";
const after = line.split("apk upgrade")[1] || "";
const args = after.split("&&")[0].split(" ").filter((t) => t !== "");
check("apk upgrade uses --no-cache", args.includes("--no-cache"));
check("apk upgrade names zlib", args.includes("zlib"));
check("apk upgrade names libcrypto3", args.includes("libcrypto3"));
check("apk upgrade names libssl3", args.includes("libssl3"));
let bare = false;
stage.forEach((l) => {
  l.split("apk upgrade").slice(1).forEach((rest) => {
    const pkgs = rest.split("&&")[0].split(" ").filter((t) => t !== "" && !t.startsWith("-"));
    if (pkgs.length === 0) bare = true;
  });
});
check("no apk upgrade without a package name", !bare);
check("final stage has a USER line", userIdx >= 0);
check("apk upgrade line comes before USER", upgradeIdx.length === 1 && userIdx > upgradeIdx[0]);

if (failed) {
  console.log(failed + " check(s) failed");
  process.exit(1);
}
console.log("all checks passed");
