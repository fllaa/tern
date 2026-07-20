#!/usr/bin/env bash
# CI-runnable slice of the Phase 0 throughput benchmark — no webview needed.
#   1. bench_sink: SSH -> pump -> coalescer -> sink; integrity + >=80 MB/s floor
#   2. bench_sink --emit-raw | @xterm/headless consumer: parse floor >=30 MB/s
# The coalescer unit tests already run in ci.yml. Full end-to-end (webview)
# numbers come from dev-machine runs committed to docs/bench/results/.
#
# Writes bench-results.json at the repo root for artifact upload.
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/sshd-rig.sh up
bun install --frozen-lockfile >/dev/null

echo "== core path (bench_sink) =="
core_json=$(cargo run --release -p tern-core-ssh --example bench_sink 2>/dev/null | tail -1)
echo "$core_json"

echo "== xterm-headless parse path =="
headless_json=$(cargo run --release -p tern-core-ssh --example bench_sink -- --emit-raw 2>/dev/null \
  | bun scripts/bench-xterm-headless.mjs)
echo "$headless_json"

printf '{"core":%s,"headless":%s}\n' "$core_json" "$headless_json" >bench-results.json
echo "wrote bench-results.json"
