# ADR-0006: Local PTY — portable-pty

- Status: Accepted
- Date: 2026-07-20

## Context

Local shell tabs (bash/zsh/PowerShell) need a cross-platform PTY, including
ConPTY on Windows — historically the hardest part.

## Decision

We use **portable-pty** (extracted from WezTerm; 0.9.x at time of writing).
Its readers/writers are blocking, so `core-pty` bridges them to tokio with
dedicated threads and bounded channels — giving the same backpressure semantics
as the SSH path (a paused consumer fills the kernel PTY buffer and blocks the
child process).

## Consequences

- Good: WezTerm-proven ConPTY handling; identical downstream data path
  (`term-stream`) for SSH and local shells.
- Bad / accepted cost: three OS threads per local tab (reader, writer, waiter);
  acceptable for the expected tab counts.
- Revisit when: thread-per-tab overhead shows up in profiles, or portable-pty
  maintenance stalls.

## Phase 0 spike finding (2026-07-20)

`ConPTY` withholds child output until the hosting terminal answers its Device
Status Report handshake (`ESC[6n` → reply `ESC[row;colR`). xterm.js answers
automatically, so the app path just works once input is wired; anything
consuming a `ConPTY` without a terminal (tests, future headless features) must
reply itself or reads hang. Smoke tests encode this; unix legs unaffected.
