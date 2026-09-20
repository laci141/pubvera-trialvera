#!/usr/bin/env bash
# vendor-cli.sh — cross-compile the clinical-trials CLI to a linux/amd64 binary
# at bin/clinical-trials-pp-cli-linux, which the Dockerfile copies into the image.
#
# The default source path is specific to one workstation. That is acceptable
# because the check below refuses to run against a path that does not hold the
# CLI, so a wrong machine gets an error naming the path it tried, not a silent
# build from the wrong source. PP_LIBRARY_ROOT exists so a different machine can
# be configured once for every pubvera repo instead of editing each script.
#
# Resolution order: explicit argument, then PP_LIBRARY_ROOT, then the default.
#
# The branch matters. There are two monorepo clones on this workstation and they
# sit on different branches; a binary vendored from a feature branch is
# indistinguishable from a correct one. The script prints the branch it is
# building from before it builds — read that line every time. The earlier
# instruction to check out feat/clinical-trials was removed rather than updated:
# naming a branch in a comment goes stale silently, while the printed line is
# always current.
#
# USAGE (from the trialvera repo, Git Bash):
#   ./vendor-cli.sh
#   ./vendor-cli.sh "/c/Users/LACI/printing-press-library/library/health/clinical-trials"
#   PP_LIBRARY_ROOT="/path/to/printing-press-library" ./vendor-cli.sh
set -euo pipefail
PP_ROOT="${PP_LIBRARY_ROOT:-/c/Users/LACI/printing-press-library}"
CLI_SRC="${1:-$PP_ROOT/library/health/clinical-trials}"
OUT="bin/clinical-trials-pp-cli-linux"
if [ ! -f "$CLI_SRC/go.mod" ] || [ ! -d "$CLI_SRC/cmd" ]; then
  echo "ERROR: CLI source not found at: $CLI_SRC" >&2
  echo "" >&2
  echo "Expected a directory holding go.mod, cmd/ and internal/. Either:" >&2
  echo "  - pass the path:   ./vendor-cli.sh \"/path/to/library/health/clinical-trials\"" >&2
  echo "  - or set the root: PP_LIBRARY_ROOT=\"/path/to/printing-press-library\"" >&2
  exit 1
fi
echo "Vendoring from: $CLI_SRC"
( cd "$CLI_SRC" && git rev-parse --abbrev-ref HEAD && git log --oneline -1 -- . )
rm -rf cli-src && mkdir -p cli-src
cp "$CLI_SRC/go.mod" "$CLI_SRC/go.sum" cli-src/
cp -r "$CLI_SRC/cmd" "$CLI_SRC/internal" cli-src/
echo "Cross-compiling -> $OUT"
mkdir -p bin
( cd cli-src && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "../$OUT" ./cmd/clinical-trials-pp-cli )
command -v file >/dev/null && file "$OUT" || true
ls -la "$OUT"