# ADR-0018: Ordered auth fallback with one credential per host

- Status: Accepted
- Date: 2026-07-21

## Context

A host needs more than one way to authenticate. The concrete case that drives
this: a fleet where most boxes take an agent or key, but a few legacy ones only
take a password — the user wants "try my agent, then fall back to the password"
without maintaining two host entries. SSH itself supports offering methods in
sequence; the question is how Tern models the chain, how it stores the
credentials the chain needs, and how it avoids the failure modes of a naive
loop.

Two failure modes are specific enough to design against. First, every
authentication attempt counts against the server's `MaxAuthTries` (6 by
default), so a chain that blindly tries methods the server has already refused
can exhaust the budget before a viable method gets its turn. Second, a
credential written to the OS keyring that turns out to be wrong surfaces as an
authentication failure at connect time — far from the form where the typo
happened, and easy to misread as a server or network problem.

## Decision

**The chain is an ordered list of methods, tried until one succeeds, and it
skips a method the server has already refused to offer.** A rejection carries
the server's remaining-methods list; a later method absent from that list is
skipped rather than attempted, so a long chain does not squander
`MaxAuthTries`. The skip is deliberately conservative — it fires only against a
non-empty list that positively excludes the method — because the two mistakes
are asymmetric: wrongly skipping breaks a login that would have worked, while
wrongly attempting costs a single try. A *local* failure (no agent running, an
unreadable key file) never reached the server and does not end the chain; the
next method still runs, which is the entire point of a fallback.

**A host carries at most one credential-bearing method.** The chain may hold a
password *or* a key passphrase, never both, plus the agent (which needs no
secret). The single stored secret is keyed to the chain's credentialed method,
found by scanning the whole chain rather than reading the primary — so an
"agent, then password" host stores its password under the password account even
though the agent leads and needs nothing itself. Resolution applies that one
secret to whichever method in the chain needs it.

**Credentials are validated before they are stored.** Key import inspects the
file first — reporting format, algorithm and fingerprint without unlocking,
because an encrypted key is a normal input to describe, not an error — and a
passphrase is checked against the key before it reaches the keyring. A wrong
passphrase is caught as a form error, not deferred to a connect-time auth
failure.

Alternatives considered:

- **Per-method credentials (a child table, or multiple keyring accounts per
  host, each method with its own key path and secret).** Rejected for Phase 1.
  It is the general model and Phase 2 (multiple identities per host) will want
  it, but it costs a schema for per-step rows and a form that collects
  credentials per method. The one-credential rule covers the real chains people
  build — "agent/key, then password" — with a single secret and no new schema.
  The constraint lives in the UI (the fallback picker never offers a second
  credentialed method) and degrades safely if a chain from elsewhere breaks it:
  the resolver takes the first credentialed method deterministically.
- **A single `MaxAuthTries`-unaware loop.** Rejected: against a server that
  refuses password auth, an "agent, key, password" chain would burn a try
  proving what the server already announced, and on a box with a low limit that
  can lock out the method that would have worked.
- **Storing the passphrase and validating lazily at connect time.** Rejected:
  it reintroduces exactly the "wrong secret, mysterious failure far from the
  cause" problem the inspection step exists to remove.

## Consequences

- Good: "try my agent, then the saved password" is expressible, stored, and
  actually used — verified against a rig server that genuinely refuses
  passwords (`docker/openssh` publickey-only variant on :2224), which is the
  only place the skip branch executes.
- Good: a wrong key passphrase is a form error at add-host time. The inspection
  also names an unsupported format (e.g. `ssh-keygen -m PKCS8` PBKDF2-HMAC-SHA1,
  which `ssh-key` cannot decrypt) as a format limit rather than blaming the
  passphrase.
- Bad / accepted cost: a host cannot hold both a stored password and a stored
  key passphrase. Anyone who wants a chain with two distinct secrets waits for
  the Phase 2 per-identity model. The UI enforces the limit so it is a designed
  boundary, not a silent truncation.
- Bad / accepted cost: `secret_ref` in the schema is now a marker
  ("a credential is stored") rather than the authority on which account holds
  it — resolution derives the account from the chain, and delete clears both
  possible accounts by id so a credentialed-method change cannot strand a
  keyring entry.
- Bad / accepted cost: the Windows ssh-agent arm (named pipe + Pageant) is
  compiled only on Windows and cannot be type-checked on the dev machine —
  every russh crypto backend needs a C toolchain targeting Windows. CI's
  `windows-latest` leg is the first place it builds.
- Revisit when: multiple identities per host land (Phase 2), which replaces the
  one-credential rule with per-method credential storage and makes this ADR's
  central constraint obsolete.
