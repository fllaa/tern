#!/usr/bin/env bun
// Consumes raw coalesced frames on stdin (from `bench_sink --emit-raw`) and
// feeds them to @xterm/headless with the same watermark flow control the real
// UI uses. Measures the parse cost — the dominant JS-side cost — without a
// GPU or webview. stdin pause/resume gives real pipe backpressure, so the
// whole chain (SSH window included) is exercised.
//
// Floor: >= 30 MB/s parsed (no compositor contention, so it should beat the
// in-app number). Exit 1 on breach.

import { Terminal } from "@xterm/headless";

const HIGH = 384 * 1024;
const LOW = 64 * 1024;

const term = new Terminal({
  cols: 120,
  rows: 40,
  scrollback: 1000,
  allowProposedApi: true,
});

let pending = 0;
let maxPending = 0;
let parsed = 0;
let received = 0;
let newlines = 0;
let pauses = 0;
let paused = false;
let started = null;

process.stdin.on("data", (chunk) => {
  if (started === null) started = performance.now();
  received += chunk.length;
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlines++;
  pending += chunk.length;
  if (pending > maxPending) maxPending = pending;
  if (!paused && pending > HIGH) {
    paused = true;
    pauses++;
    process.stdin.pause();
  }
  term.write(chunk, () => {
    pending -= chunk.length;
    parsed += chunk.length;
    if (paused && pending < LOW) {
      paused = false;
      process.stdin.resume();
    }
  });
});

process.stdin.on("end", () => {
  const finish = () => {
    if (pending > 0) {
      setTimeout(finish, 50);
      return;
    }
    const wall = performance.now() - (started ?? performance.now());
    const mbps = wall > 0 ? parsed / 1048576 / (wall / 1000) : 0;
    const out = {
      parsed_bytes: parsed,
      received_bytes: received,
      newlines,
      wall_ms: Math.round(wall),
      parsed_mbps: Number(mbps.toFixed(2)),
      max_pending: maxPending,
      pauses,
      floor_30mbps: mbps >= 30,
    };
    console.log(JSON.stringify(out));
    process.exit(mbps >= 30 ? 0 : 1);
  };
  finish();
});
