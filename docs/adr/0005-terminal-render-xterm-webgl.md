# ADR-0005: Terminal rendering — xterm.js 6 + WebGL addon, DOM fallback

- Status: Accepted
- Date: 2026-07-20

## Context

The terminal emulator/renderer is the most user-visible component. Options:
xterm.js in the webview (proven at VS Code/Tabby scale), or a Rust-native
renderer (wgpu) — a very large lift. Note: xterm.js 6 **removed the canvas
renderer**; the fallback story is now the DOM renderer, not canvas.

## Decision

We use **@xterm/xterm 6** with **@xterm/addon-webgl**, falling back to the DOM
renderer when WebGL is unavailable or its context is lost (relevant on some
WebKitGTK/Linux setups). Flow control follows the documented xterm idiom:
pending-byte watermarks with `write()` callbacks driving pause/resume of the
Rust producer. The escape hatch — a wgpu-based Rust terminal — is only
triggered by the Phase 0 benchmark gates (see ADR-0011).

## Consequences

- Good: battle-tested parser/renderer; WebGL performance on the platforms that
  matter; smallest possible Phase 0.
- Bad / accepted cost: JS-side parse cost bounds throughput (documented band
  5–35 MB/s); DOM fallback is slow on huge outputs; renderer lives across the
  IPC boundary.
- Revisit when: benchmark gates fail (end-to-end < 10 MB/s, echo p95 > 32 ms,
  reproducible drops, or UI stalls > 500 ms).

## Phase 0 spike results (2026-07-20, xterm 6 + WebGL on Apple Silicon)

91–98 MB/s end-to-end parsed on a 100 MB `cat` (well above the upper end of
xterm's documented 5–35 MB/s band thanks to large coalesced writes), echo p95
5–7 ms, max UI stall 56 ms, zero loss everywhere. 72.8 MB/s through
`@xterm/headless` in CI. No escape-hatch gate tripped — the wgpu path stays
dormant. Full numbers: `docs/bench/phase0-results.md`.
