# ADR-0011: Terminal IPC transport — raw Tauri Channel (binary, coalesced)

- Status: Accepted
- Date: 2026-07-20

## Context

The terminal data path is the #1 architectural risk: russh output must reach
xterm.js at full throughput with backpressure, or the architecture wobbles.
Candidates: Tauri's event system (JSON + broadcast — explicitly not built for
throughput), a sidecar WebSocket server (extra socket, CSP hole, port
management), a custom protocol handler, or Tauri's `ipc::Channel`.

## Decision

Terminal bytes flow over **`tauri::ipc::Channel` with
`InvokeResponseBody::Raw`** — no JSON, no base64, no framing (ordering is
guaranteed by the Channel; xterm needs no message boundaries). Because payloads
≥ 1 KB travel via an internal fetch round-trip, the Rust side **coalesces**
output (~8–16 ms tick or 64 KB, whichever first) into fewer, larger frames.
Low-frequency control (open/resize/pause/events) is serde JSON via commands and
a separate typed channel — defined in `crates/proto`. **Terminal bytes never
appear in JSON.** Flow control: JS pending-byte watermarks drive
pause/resume commands; every link in the Rust chain is a bounded channel, so a
pause propagates through russh's window to the remote process.

## Consequences

- Good: zero serialization overhead on the hot path; backpressure end-to-end;
  the same path serves SSH and local PTYs.
- Bad / accepted cost: one fetch round-trip per coalesced frame (the price of
  webview IPC); benchmark thresholds — zero drops, echo p95 < 16 ms,
  ≥ 20 MB/s end-to-end, ≥ 80 MB/s Rust-side — gate this bet.
- Revisit when: Spike 2 numbers breach the escape-hatch gates (< 10 MB/s,
  echo p95 > 32 ms, reproducible drops, > 500 ms stalls) ⇒ investigate a wgpu
  Rust-native terminal. Spike 2 results feed this ADR at Phase 0 exit.
