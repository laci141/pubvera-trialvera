// Runtime zlib upgrade test (CVE-2026-4738).
//
// Run: node tools/runtime_zlib_test.js
//
// The running trialvera container reported zlib-1.3.2-r1 (apk list -I zlib,
// 2026-11-12) in the alpine:3.24 runtime image; the fix is 1.4-r0. This static
// check reads the Dockerfile and asserts, on the runtime stage only (the
// lines from the last FROM to the end):
//   (a) the final stage (after the last FROM) is alpine:3.24;
//   (b) the final stage has a RUN line that upgrades zlib by name
//       ("apk upgrade --no-cache zlib" or "apk add --no-cache --upgrade zlib");
//   (c) that RUN line comes before the USER line (root is needed for apk);
//   (d) no "apk upgrade" anywhere without a package name;
//   (e) the check is anchored to the last FROM: the same Dockerfile with the
//       zlib upgrade moved into a build stage must not satisfy (b).
// Unlike the Recallis original there is no hash pin of the build stages: CI
// runs the PR merge commit, so such a pin breaks whenever main moves.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8").replace(/\r/g, "");

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const zlibUpgrade = /\bapk\s+(upgrade\s+--no-cache\s+zlib|add\s+--no-cache\s+--upgrade\s+zlib)\b/;

// Returns { fromLine, runIdx, userIdx } for the stage after the last FROM.
function finalStageInfo(text) {
  const lines = text.split("\n");
  let lastFrom = -1;
  lines.forEach((l, i) => {
    if (/^FROM\s/.test(l)) lastFrom = i;
  });
  if (lastFrom < 0) return null;
  // Join backslash continuations so a multi-line RUN is one instruction.
  const stage = lines.slice(lastFrom).join("\n").replace(/\\\n/g, " ").split("\n");
  return {
    fromLine: lines[lastFrom],
    runIdx: stage.findIndex((l) => /^RUN\s/.test(l) && zlibUpgrade.test(l)),
    userIdx: stage.findIndex((l) => /^USER\s/.test(l)),
  };
}

const info = finalStageInfo(src);
if (!info) {
  console.error("FAIL: no FROM line in Dockerfile - refusing to pass silently");
  process.exit(1);
}

check("(a) final stage is alpine:3.24 (found: " + info.fromLine + ")", /^FROM alpine:3\.24\s*$/.test(info.fromLine));
check("(b) final stage has a RUN that upgrades zlib by name", info.runIdx >= 0);
check("(c) zlib upgrade RUN is before USER (RUN at " + info.runIdx + ", USER at " + info.userIdx + ")", info.runIdx >= 0 && info.userIdx > info.runIdx);

const bareUpgrade = src.replace(/\\\n/g, " ").split("\n").filter((l) => /\bapk\s+upgrade\b/.test(l) && /\bapk\s+upgrade(\s+--?[\w-]+)*\s*(&&|;|$)/.test(l));
check("(d) no apk upgrade without a package name (found " + bareUpgrade.length + ")", bareUpgrade.length === 0);

// (e) Synthetic Dockerfile: the zlib upgrade sits in a build stage and the
// runtime stage lacks it. Only a check scoped to the last FROM rejects it.
const misplaced = [
  "FROM golang:1.27-alpine AS builder",
  "RUN apk upgrade --no-cache zlib",
  "FROM alpine:3.24",
  "RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app",
  "USER app",
  "",
].join("\n");
const misInfo = finalStageInfo(misplaced);
check("(e) a zlib upgrade only in a build stage is not accepted", misInfo !== null && misInfo.runIdx < 0);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all runtime zlib checks pass");
