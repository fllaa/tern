# ADR-0012: Hosts and settings live in a new `core-store` crate

- Status: Accepted
- Date: 2026-07-20

## Context

ADR-0009 chose rusqlite but said nothing about *where* the storage layer
lives. The dev plan's tree (§2) and CONTRIBUTING both put SQLite inside
`core-vault`, described as "storage + crypto". Phase 1 is the first phase that
needs either, so the placement has to be settled now — after outside
contributions land, moving a crate is a much larger conversation.

## Decision

We put hosts, folders, tags and settings in a new **`crates/core-store`**, and
narrow `core-vault` to secrets only (OS keyring now, vault crypto in Phase 5).

`core-store` depends on neither `core-ssh` nor `core-vault`: it returns
records, and the desktop layer maps them onto `SessionConfig` and resolves
credentials. That keeps the core crates a DAG with no cross-edges.

Two things deliberately stay out of it. **Secrets**: `hosts.secret_ref` holds
an OS-keyring account string, never a credential. **Host keys**: Tern's own
known_hosts file is the sole authority (ADR-0013) — mirroring it into SQLite
would create a second source of truth for a security decision, with no
performance argument to justify it and no way to display hashed entries anyway.

If this proves wrong, merging two path-dependency crates is a mechanical
change; splitting a crate that has grown two unrelated reasons to change is not.

## Consequences

- Good: Phase 5's vault work lands in a crate that has no plaintext host
  records in it, and the store is testable with no secret plumbing at all —
  `Store::open_in_memory()` needs no keyring, no filesystem, no runtime.
- Good: connection state and storage stay independently reviewable. The
  security-sensitive code is in a crate that does not do SQL.
- Bad / accepted cost: deviates from the dev plan's tree and CONTRIBUTING,
  both of which are amended alongside this ADR. One more crate in the
  workspace, and `bundled` SQLite adds ~30–60s to cold builds on all three
  OSes (already accepted in ADR-0009).
- Revisit when: the store and the vault turn out to need the same
  transaction — i.e. when sync (Phase 5) has to write host records and
  crypto state atomically.
