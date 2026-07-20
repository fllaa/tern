# ADR-0004: SFTP — russh-sftp

- Status: Accepted
- Date: 2026-07-20

## Context

Phase 3 needs an SFTP client. It should reuse the already-authenticated SSH
session rather than opening separate connections by default.

## Decision

We use **russh-sftp**, running the SFTP subsystem on the existing russh session.
Optional parallel connections for throughput are a Phase 3 decision, not a
default.

## Consequences

- Good: one connection, one auth, one host-key trust decision; consistent with
  the pure-Rust stack.
- Bad / accepted cost: young ecosystem compared to libssh2's SFTP; resume/rename
  edge cases must be tested against both OpenSSH and dropbear.
- Revisit when: Phase 3 hits throughput or resume gaps that the crate can't
  express.
