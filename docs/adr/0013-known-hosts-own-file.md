# ADR-0013: Tern owns its known_hosts; `~/.ssh/known_hosts` is read-only

- Status: Accepted
- Date: 2026-07-20

## Context

Phase 0 had TOFU as an in-flight callback answered by a `window.confirm()`,
with nothing written to disk — every connect was first contact. Phase 1 needs
real persistence, which forces the question of whether Tern shares the file
every other SSH tool on the machine depends on.

## Decision

Tern keeps its **own OpenSSH-format known_hosts** in its app config directory
and offers a one-way, **read-only import** of `~/.ssh/known_hosts`. It never
writes the user's file. Trusting a host in Tern therefore does not make the
`ssh` CLI trust it — an accepted loss of convenience, in exchange for never
being able to corrupt a security-critical shared file. New entries are written
unhashed by default (this is our file; unhashed is far easier to support),
behind a `known_hosts.hash` setting.

Entry *parsing* comes from `ssh-key`, which already handles `|1|` hashed
names, `[host]:port`, comma-separated patterns, and the
`@cert-authority`/`@revoked` markers. **Matching and the verdict are ours.**
Notably we do not use russh's own `known_hosts`: it matches only exact and
hashed names — no `*`/`?` wildcards, which real files use — and it mis-parses
marker lines badly enough that `@revoked` shifts the field positions, never
matches, and presents a revoked key as merely *unknown*, i.e. a friendly
first-contact prompt for a key an administrator explicitly revoked.

Four verdicts, and keeping them distinct is the point. `Trusted` connects
silently, because a client that prompts every time trains users to accept
without reading. `Unknown` prompts and records on accept. `Changed` and
`Revoked` refuse, and `Changed` **never offers "trust anyway" in the same
flow** — recovery is an explicit `remove_known_host` followed by a reconnect,
which then presents as ordinary first contact. That two-step friction is the
entire security value.

Fallback: if users demand shared trust, an opt-in "also write `~/.ssh`" toggle
is additive.

## Consequences

- Good: Tern cannot corrupt the file `ssh`, `scp`, `rsync` and git depend on.
  Import means an existing setup is not re-prompted from scratch.
- Good: `Changed` carries the recorded fingerprint and file:line, so the UI can
  show expected vs offered rather than a bare refusal.
- Bad / accepted cost: trust is not shared with the CLI, and users who accept a
  key in Tern will be prompted again by `ssh`. Two files can disagree. We also
  own ~150 lines of matching logic instead of borrowing it — mitigated by
  fixtures generated with real `ssh-keygen -H`, so the tests check agreement
  with OpenSSH rather than with our own encoder.
- Revisit when: users report the split-trust friction more often than they
  report anything else, or russh's known_hosts grows wildcard and marker
  support.
