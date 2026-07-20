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
# stderr goes to a log we print on failure — a panicking floor assert must not
# vanish into /dev/null.
if ! cargo run --release -p tern-core-ssh --example bench_sink >/tmp/bench-core.out 2>/tmp/bench-core.err; then
  echo "bench_sink failed:" >&2
  cat /tmp/bench-core.err >&2
  exit 1
fi
core_json=$(tail -1 /tmp/bench-core.out)
echo "$core_json"

echo "== xterm-headless parse path =="
if ! cargo run --release -p tern-core-ssh --example bench_sink -- --emit-raw 2>/tmp/bench-raw.err \
  | bun scripts/bench-xterm-headless.mjs >/tmp/bench-headless.out; then
  echo "headless consumer failed:" >&2
  cat /tmp/bench-raw.err >&2
  cat /tmp/bench-headless.out >&2 || true
  exit 1
fi
headless_json=$(tail -1 /tmp/bench-headless.out)
echo "$headless_json"

printf '{"core":%s,"headless":%s}\n' "$core_json" "$headless_json" >bench-results.json
echo "wrote bench-results.json"
