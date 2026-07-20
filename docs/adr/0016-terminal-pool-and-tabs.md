# ADR-0016: Terminal instances live outside React, stacked and visibility-toggled

- Status: Accepted
- Date: 2026-07-20

## Context

Phase 1 needs N concurrent sessions where Phase 0 had one. Two properties are
non-negotiable: scrollback must survive a tab switch, and the flow-control path
ADR-0011 benchmarked must keep working for every tab, not only the visible one.

A `Terminal` held in React state fails the first outright — reconciliation
destroys and rebuilds it, taking the scrollback with it.

## Decision

Terminals live in a **module-level map** (`ui/src/terminal/pool.ts`), outside
React. `TerminalMount` parents their host elements and toggles which is visible;
it never creates or destroys them. `store/sessions.ts` holds only serializable
tab data — no `Terminal`, no `TermSession`, no timer handles.

All terminals stay **in the document**, stacked, with `visibility: hidden` on
inactive tabs. Three arrangements were considered:

- `display: none` — rejected. `FitAddon` measures a `display:none` element as
  0×0 and computes garbage cols/rows, which then get pushed to the remote PTY.
- **Detaching** inactive tabs from the DOM — rejected for now. Appealing, since
  only one terminal is ever live, but whether xterm 6 tolerates a detached host
  element on its next render pass is unverified, and the tab model should not
  rest on an unverified assumption.
- `visibility: hidden` — chosen. Layout is preserved so `fit()` stays correct,
  nothing is ever detached, and WebGL cost is bounded by giving only the active
  tab a context (browsers cap them around 8–16, so one per tab would silently
  drop later tabs to the DOM renderer).

The detail that makes hidden tabs correct rather than merely convenient:
backpressure is driven by `term.write(bytes, callback)` — the **parser**, not
the renderer. A hidden terminal still parses and still fires its write
callbacks, so flow control behaves identically foreground or background.

Fallback: if memory pressure from many mounted terminals becomes real, detaching
inactive tabs is a change confined to `pool.ts` — and by then it can be measured
rather than assumed.

## Consequences

- Good: a tab switch is a visibility change. Scrollback, cursor position and
  in-flight output all survive because nothing is torn down.
- Good: the 100 Hz `TermSession.flow` object never enters the store, so the
  status bar polls it directly twice a second instead of re-rendering
  subscribers on every frame.
- Good: the tab reducer is plain data and unit-tested — neighbour selection on
  close, ids never reused, late events for closed tabs ignored.
- Bad / accepted cost: every open tab holds a full xterm instance and its
  scrollback buffer. At 10k lines each that is real memory, and there is no cap
  on tab count yet.
- Bad / accepted cost: WebGL is created and disposed on every tab switch. Cheap,
  but not free, and it means the renderer briefly differs mid-switch.
- Revisit when: tab counts get high enough for memory to matter, or a measured
  need justifies verifying the detached-host approach.
