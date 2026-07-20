# ADR-0009: Local storage — SQLite via rusqlite

- Status: Accepted
- Date: 2026-07-20

## Context

Hosts, folders/tags, snippets, connection history, and the transfer queue need
durable, queryable local storage with zero ops burden.

## Decision

We use **rusqlite** with the `bundled` SQLite (no system dependency), one
database file in the app data directory. Schema migrations are plain numbered
SQL applied at startup. Secrets never live here (see ADR-0008) — only
references into the keyring/vault.

## Consequences

- Good: boring, proven, fast; trivially backed up; bundled build keeps the
  3-OS story uniform.
- Bad / accepted cost: bundled SQLite adds compile time and binary size;
  concurrent writers need care (single app process makes this manageable).
- Revisit when: sync (Phase 5) demands per-record versioning the schema fights.
