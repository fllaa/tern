# ADR-0020: A tab is a tree of panes, joined to the pool by PaneId

- Status: Accepted
- Date: 2026-07-22

## Context

Phase 2 adds split panes: one tab shows several terminals at once, laid out and
resizable. ADR-0016 keyed everything — store tab record, `TermSession`, pooled
`Terminal` — by a single `TabId`, because a tab *was* one terminal. Splitting
breaks that identity: a tab now owns many terminals, each its own session, so
the terminal identity and the tab identity must come apart.

Two ADR-0016 invariants still have to hold, now per pane: scrollback survives a
tab switch, and the flow-control path keeps working for every terminal on
screen, not just the focused one.

## Decision

**`PaneId` becomes the join key.** The pool (`terminal/pool.ts`) and the session
controller (`session/controller.ts`) are keyed by `PaneId`; a `Pane` carries
what a `Tab` used to (host, title, conn state, rust session id). A `Tab` is now a
thin container: a **layout tree** (`store/layout.ts`) whose leaves are panes and
whose internal nodes are splits along one axis, plus the focused `activePaneId`
and a `broadcast` flag. The store holds `tabs` and a flat `panes` map, so a
per-pane connection update is the same one-line reducer it always was.

The tree helpers (`splitLeaf`, `removeLeaf`, `collectPaneIds`, `neighbourPane`)
are pure and unit-tested, like `neighbourOf` before them.

**Rendering is layered.** `TerminalMount` mounts *every* tab as an absolutely
positioned layer and toggles `visibility` on the whole layer — the direct
generalization of ADR-0016's stacked, `visibility:hidden` tabs from one host to
a whole nested tree. Inside a layer, `renderNode` walks the tree into nested
`ResizablePanelGroup`s (react-resizable-panels v4), and each leaf parents its
pooled host and runs its own `ResizeObserver`. A single-leaf tab short-circuits
to just the leaf, so an unsplit tab is byte-for-byte what it was before.

Why mount all tabs rather than only the active tree: a background
`visibility:hidden` layer is still laid out, so its panes measure real
dimensions and a tab switch stays a flip, not a re-measure. Rendering only the
active tree reintroduces the ADR-0017 first-paint gap (a freshly mounted group
measures 0, `defaultSize` is dropped) on *every* switch.

**WebGL is rationed, not per-tab.** ADR-0016 gave the one active tab a context;
a split tab wants several at once, against the browser's ~8–16 cap.
`pool.reconcileRenderers(visible)` takes the active tab's panes focused-first and
grants WebGL to the first `MAX_WEBGL` (8); the rest, and every background-tab
pane, fall to the DOM renderer (ADR-0005's documented fallback). The focused
pane is always within the cap; a single-pane tab always gets WebGL.

## Consequences

- Good: split/close/focus and broadcast are pure store operations over the tree;
  the flat `panes` map keeps per-pane connection reducers unchanged, and the
  "ids never reused / late events for closed keys ignored" invariants carry over
  at pane granularity.
- Good: an unsplit tab renders exactly as before — same DOM, same geometry, same
  single WebGL context — so ADR-0016/0017 behaviour is preserved for the common
  case.
- Good: broadcast is a frontend fan-out (`collectPaneIds` → `controller.write`);
  the backend's per-session writers already tolerate concurrent writes, so no
  Rust change was needed.
- Bad / accepted cost: ADR-0016's per-tab xterm-in-memory cost is now per
  *pane*. A tab with four panes holds four scrollback buffers, and there is
  still no cap on tab or pane count.
- Bad / accepted cost: panes beyond `MAX_WEBGL` render on the DOM renderer while
  visible, so a heavily split tab mixes renderers. Acceptable — the focused pane
  is always accelerated, and the flow-line surfaces which renderer a pane is on.
- Bad / accepted cost: split sizes persist to the store on user drag, but a
  library relayout on structure change redistributes evenly rather than
  preserving a prior drag. Fine for v1.
- Revisit when: memory from many panes matters (detaching background layers,
  the ADR-0016 escape hatch, still applies), or directional pane navigation and
  drag-to-reorder-panes are wanted (next/prev cycling ships now).
