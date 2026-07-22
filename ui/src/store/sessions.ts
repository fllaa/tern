// The tab + pane model.
//
// Hard rule: nothing in this store is non-serializable. No Terminal, no
// TermSession, no timer handles. Those live in module-level maps
// (`terminal/pool.ts`, `session/controller.ts`) for two reasons:
//
//   * `TermSession.flow` mutates on every frame — hundreds of times a second
//     under load. Routing that through Zustand would re-render subscribers at
//     100 Hz for a status line that only needs updating twice a second.
//   * A Terminal in React state gets torn down and rebuilt on reconciliation,
//     which destroys scrollback. Scrollback surviving a tab switch is the whole
//     point of a tabbed terminal.
//
// A tab is a *layout of panes*, not a single terminal: `Tab.root` is a tree
// (see `layout.ts`) whose leaves are `Pane`s, each its own session. The pool
// and controller are keyed by `PaneId` — that id is the join across
// store ↔ controller ↔ pool.

import { create } from "zustand";
import {
  collectPaneIds,
  type LayoutNode,
  leaf,
  type NodeId,
  neighbourPane,
  removeLeaf,
  type SplitDir,
  setSizes,
  splitLeaf,
} from "./layout";

export type TabId = string;
export type PaneId = string;

export type ConnState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

/** Live reconnect progress, shown while `conn === "reconnecting"`. */
export interface ReconnectInfo {
  attempt: number;
  /** The configured ceiling, or 0 for unlimited. */
  max: number;
  /** When this attempt fires, for a countdown. Epoch millis. */
  dueAt: number;
}

/** One terminal/session — the connection-bearing leaf of a tab's tree. */
export interface Pane {
  id: PaneId;
  hostId: number | null;
  title: string;
  conn: ConnState;
  /** Rust's session id, once `open_session` has answered. */
  rustSessionId: string | null;
  /** Why the pane is in `disconnected` or `error`. */
  detail?: string;
  exitCode?: number | null;
  /** Non-null only while reconnecting. */
  reconnect?: ReconnectInfo | null;
}

/** A tab: a layout of panes with one focused, optionally broadcasting input. */
export interface Tab {
  id: TabId;
  root: LayoutNode;
  activePaneId: PaneId;
  /** Fan keystrokes from the focused pane to every pane in this tab. */
  broadcast: boolean;
}

export interface SessionsState {
  order: TabId[];
  tabs: Record<TabId, Tab>;
  panes: Record<PaneId, Pane>;
  activeId: TabId | null;

  openTab: (init: { hostId: number | null; title: string }) => {
    tabId: TabId;
    paneId: PaneId;
  };
  closeTab: (id: TabId) => void;
  splitPane: (
    tabId: TabId,
    target: PaneId,
    dir: SplitDir,
    init: { hostId: number | null; title: string },
  ) => PaneId | null;
  closePane: (tabId: TabId, paneId: PaneId) => void;
  setActive: (id: TabId) => void;
  setActivePane: (tabId: TabId, paneId: PaneId) => void;
  setSplitSizes: (tabId: TabId, nodeId: NodeId, sizes: number[]) => void;
  toggleBroadcast: (tabId: TabId) => void;
  moveTab: (id: TabId, toIndex: number) => void;

  setConn: (paneId: PaneId, conn: ConnState, detail?: string) => void;
  setReconnecting: (paneId: PaneId, info: ReconnectInfo) => void;
  setRustSessionId: (paneId: PaneId, sessionId: string | null) => void;
  setExit: (paneId: PaneId, code: number | null) => void;
  renamePane: (paneId: PaneId, title: string) => void;
}

let nextTabId = 0;
/** Monotonic, never reused — a recycled id would let a late event from a closed
 *  session land on whatever tab inherited its slot. */
export function newTabId(): TabId {
  nextTabId += 1;
  return `t-${nextTabId}`;
}

let nextPaneId = 0;
/** Monotonic, never reused — same reasoning as tab ids, at pane granularity. */
export function newPaneId(): PaneId {
  nextPaneId += 1;
  return `p-${nextPaneId}`;
}

/**
 * Which tab should take focus when `closing` goes away.
 *
 * Pure and exported so the behaviour is testable directly: prefer the tab to
 * the right (matching how every editor does it), fall back to the left, and
 * return null when the last tab closes.
 */
export function neighbourOf(order: TabId[], closing: TabId): TabId | null {
  const idx = order.indexOf(closing);
  if (idx === -1) return null;
  return order[idx + 1] ?? order[idx - 1] ?? null;
}

/**
 * The tab `delta` steps from `active` in display order, wrapping at both ends.
 * With no active tab it lands on the first. Returns null only when there are no
 * tabs. Pure and exported for direct testing, like `neighbourOf`.
 */
export function relativeTab(
  order: TabId[],
  active: TabId | null,
  delta: number,
): TabId | null {
  const len = order.length;
  if (len === 0) return null;
  const from = active ? order.indexOf(active) : -1;
  // No active tab (or an unknown one): relative navigation lands on the first.
  if (from === -1) return order[0];
  return order[(((from + delta) % len) + len) % len];
}

/**
 * The tab at a 1-based position, or null if out of range. "Select the last
 * tab" is the caller's job — pass `order.length`.
 */
export function tabAtIndex(order: TabId[], oneBased: number): TabId | null {
  return order[oneBased - 1] ?? null;
}

function makePane(init: { hostId: number | null; title: string }): Pane {
  return {
    id: newPaneId(),
    hostId: init.hostId,
    title: init.title,
    conn: "idle",
    rustSessionId: null,
  };
}

export const useSessions = create<SessionsState>((set, get) => ({
  order: [],
  tabs: {},
  panes: {},
  activeId: null,

  openTab: ({ hostId, title }) => {
    const tabId = newTabId();
    const pane = makePane({ hostId, title });
    set((s) => ({
      order: [...s.order, tabId],
      tabs: {
        ...s.tabs,
        [tabId]: {
          id: tabId,
          root: leaf(pane.id),
          activePaneId: pane.id,
          broadcast: false,
        },
      },
      panes: { ...s.panes, [pane.id]: pane },
      activeId: tabId,
    }));
    return { tabId, paneId: pane.id };
  },

  closeTab: (id) => {
    const { order, tabs, panes, activeId } = get();
    const tab = tabs[id];
    if (!tab) return;
    const next = activeId === id ? neighbourOf(order, id) : activeId;
    const remainingTabs = { ...tabs };
    delete remainingTabs[id];
    const remainingPanes = { ...panes };
    for (const pid of collectPaneIds(tab.root)) delete remainingPanes[pid];
    set({
      order: order.filter((t) => t !== id),
      tabs: remainingTabs,
      panes: remainingPanes,
      activeId: next,
    });
  },

  splitPane: (tabId, target, dir, init) => {
    const tab = get().tabs[tabId];
    if (!tab) return null;
    const pane = makePane(init);
    set((s) => ({
      tabs: {
        ...s.tabs,
        [tabId]: {
          ...tab,
          root: splitLeaf(tab.root, target, pane.id, dir),
          activePaneId: pane.id,
        },
      },
      panes: { ...s.panes, [pane.id]: pane },
    }));
    return pane.id;
  },

  closePane: (tabId, paneId) => {
    const { tabs, panes } = get();
    const tab = tabs[tabId];
    if (!tab) return;
    const nextRoot = removeLeaf(tab.root, paneId);
    if (!nextRoot) {
      // The tab's last pane — close the whole tab (which cleans up its panes).
      get().closeTab(tabId);
      return;
    }
    const nextActive =
      tab.activePaneId === paneId
        ? (neighbourPane(tab.root, paneId) ?? collectPaneIds(nextRoot)[0])
        : tab.activePaneId;
    const remainingPanes = { ...panes };
    delete remainingPanes[paneId];
    set({
      tabs: { ...tabs, [tabId]: { ...tab, root: nextRoot, activePaneId: nextActive } },
      panes: remainingPanes,
    });
  },

  setActive: (id) => {
    if (get().tabs[id]) set({ activeId: id });
  },

  setActivePane: (tabId, paneId) => {
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab || !s.panes[paneId]) return s;
      return {
        activeId: tabId,
        tabs: { ...s.tabs, [tabId]: { ...tab, activePaneId: paneId } },
      };
    });
  },

  setSplitSizes: (tabId, nodeId, sizes) => {
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      return {
        tabs: { ...s.tabs, [tabId]: { ...tab, root: setSizes(tab.root, nodeId, sizes) } },
      };
    });
  },

  toggleBroadcast: (tabId) => {
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...tab, broadcast: !tab.broadcast } } };
    });
  },

  moveTab: (id, toIndex) => {
    const order = [...get().order];
    const from = order.indexOf(id);
    if (from === -1) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id);
    set({ order });
  },

  setConn: (paneId, conn, detail) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      // Any state other than `reconnecting` ends a reconnect, so its progress
      // must not linger and mislead the diagnostics view.
      return {
        panes: { ...s.panes, [paneId]: { ...pane, conn, detail, reconnect: null } },
      };
    });
  },

  setReconnecting: (paneId, info) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return {
        panes: {
          ...s.panes,
          [paneId]: { ...pane, conn: "reconnecting", reconnect: info, detail: undefined },
        },
      };
    });
  },

  setRustSessionId: (paneId, sessionId) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return { panes: { ...s.panes, [paneId]: { ...pane, rustSessionId: sessionId } } };
    });
  },

  setExit: (paneId, code) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return {
        panes: {
          ...s.panes,
          [paneId]: {
            ...pane,
            conn: "disconnected",
            exitCode: code,
            rustSessionId: null,
          },
        },
      };
    });
  },

  renamePane: (paneId, title) => {
    set((s) => {
      const pane = s.panes[paneId];
      if (!pane) return s;
      return { panes: { ...s.panes, [paneId]: { ...pane, title } } };
    });
  },
}));

/** Tabs in display order. */
export function tabsInOrder(s: SessionsState): Tab[] {
  return s.order.map((id) => s.tabs[id]).filter(Boolean);
}

/** The focused pane of a tab, or null if the tab is unknown. */
export function activePaneOf(s: SessionsState, tabId: TabId): Pane | null {
  const tab = s.tabs[tabId];
  return tab ? (s.panes[tab.activePaneId] ?? null) : null;
}
