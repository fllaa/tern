# ADR-0015: `~/.ssh/config` import — hand-rolled, subset, preview-first

- Status: Accepted
- Date: 2026-07-20

## Context

The dev plan calls ssh_config import a "disproportionate adoption lever" — it
is the difference between an empty host list and someone's whole fleet on first
run. It is also the feature most able to eat a schedule: ssh_config is a small
language with a long tail (`Match`, `Include` graphs, `%h`-style tokens, dozens
of keywords), and every one of them is a rabbit hole with no product
differentiation at the bottom.

## Decision

Import is a **subset, one-way, non-authoritative bulk-add with a preview**, and
the parser is **hand-rolled** in `crates/core-store/src/ssh_config/`.

What bounds the scope is a promise rather than a boundary: anything we do not
understand is **listed**, never silently dropped. The preview dialog shows every
unsupported keyword with its file and line, so the user can see exactly what did
not come across and fix it by hand.

Hand-rolled because the obvious crate is unavailable and the hard part is not
delegable either way. `ssh2-config` carries an unconditional `git2`
*build*-dependency; `git2` pulls `libgit2-sys`, which reaches `libssh2-sys` and
`openssl-sys` — both on `deny.toml`'s ban list, with `[graph] all-features =
true` forcing the optional features on. The pure-Rust fork `ssh2-config-rs`
clears the ban but drags the `gix` tree into the cargo-deny surface for a
single-maintainer crate. And **no crate handles `Match`**, which is the one
construct that can silently corrupt an import.

`Match` is handled by ending the current stanza. Not evaluating `Match` is a
limitation; silently attributing the directives *inside* one to the preceding
`Host` would be a correctness bug producing hosts that point somewhere the user
never configured, with no error anywhere. `Include` is followed with a depth cap
and a visit set, so a cycle warns rather than hangs.

Two phases: `scan` reads and reports and writes nothing, so Cancel genuinely
cancels; `apply` upserts on `source_alias`, so re-importing after editing the
file updates rather than duplicating.

Fallback: if the subset proves too thin, widening the keyword table is additive.

## Consequences

- Good: no dependency, no ban-list exception, and total control over the
  `Match`/`Include` handling we would have had to write regardless.
- Good: resolution follows OpenSSH's own semantics — every stanza whose
  patterns match, in file order, first value wins — so `Host *.legacy` reaches
  only `*.legacy` hosts and negation (`!old.legacy`) is honoured.
- Good: idempotent by alias, and it never touches hand-made hosts because the
  lookup is scoped to `source = 'ssh_config'`. A user's rename of an imported
  host survives re-import.
- Bad / accepted cost: we own a parser for a format we do not control. Mitigated
  by fixtures covering quoting, `=` separators, comments, wildcards, negation,
  `Include`, cycles and `Match`, plus a check against a real config.
- Bad / accepted cost: `Match` blocks and `%h`-style tokens are not supported,
  so a config that leans on them imports partially. It says so, per row.
- Revisit when: users report the unsupported list more often than anything else,
  or a maintained pure-Rust parser appears that clears `deny.toml`.
