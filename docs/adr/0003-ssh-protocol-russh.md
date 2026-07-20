# ADR-0003: SSH protocol — russh

- Status: Accepted
- Date: 2026-07-20

## Context

The SSH transport is the heart of the product. Options: `russh` (pure Rust,
async, actively maintained), `ssh2` (libssh2 bindings — C dependency, blocking
API), or shelling out to OpenSSH (no session control, no portability story).

## Decision

We use **russh** (0.62.x at time of writing) for all SSH transport. Its bounded
per-channel delivery buffer (`Config::channel_buffer_size`) gives us end-to-end
backpressure — a stalled consumer drains the SSH window and blocks the remote
process — which the Phase 0 throughput spike depends on. The session API stays
behind our own `core-ssh` types so the transport is swappable. Fallback: `ssh2`
if auth edge cases bite; `deny.toml` bans `libssh2-sys`/`openssl-sys` so
adopting the fallback is a conscious, ADR-gated change.

## Consequences

- Good: pure-Rust supply chain; async fits the tokio core; backpressure for free.
- Bad / accepted cost: no GSSAPI and some rare auth methods missing — some
  enterprise users are blocked (documented limitation). Windows agent
  (named pipe / Pageant) needs custom wiring in Phase 1.
- Revisit when: an auth-method gap blocks a meaningful user cohort, or russh
  maintenance stalls. Spike results feed this ADR at Phase 0 exit.
