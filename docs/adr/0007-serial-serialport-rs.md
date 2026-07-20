# ADR-0007: Serial — serialport-rs, telnet kept minimal

- Status: Accepted
- Date: 2026-07-20

## Context

v1 scope includes serial consoles (network-gear use case) and a minimal telnet
client. Phase 4 work; the bet is recorded now.

## Decision

We use **serialport-rs** for cross-platform serial (port enumeration,
baud/parity/flow control) and hand-roll a minimal telnet client (RFC 854 +
option negotiation NOPs) — the console use case needs nothing more.

## Consequences

- Good: mature, maintained crate; no C dependency.
- Bad / accepted cost: exotic USB-serial adapters may need quirks handling;
  telnet stays deliberately feature-poor.
- Revisit when: Phase 4 testing against real routers/switches surfaces gaps.
