// The tab model.
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
// Keeping the store to plain data is also what makes tab restore and these
// tests possible.

import { create } from "zustand";

export type TabId = string;

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

export interface Tab {
  id: TabId;
  hostId: number | null;
  title: string;
  conn: ConnState;
  /** Rust's session id, once `open_session` has answered. */
  rustSessionId: string | null;
  /** Why the tab is in `disconnected` or `error`. */
  detail?: string;
  exitCode?: number | null;
  /** Non-null only while reconnecting. */
  reconnect?: ReconnectInfo | null;
}

export interface SessionsState {
  order: TabId[];
  byId: Record<TabId, Tab>;
  activeId: TabId | null;

  openTab: (init: { hostId: number | null; title: string }) => TabId;
  closeTab: (id: TabId) => void;
  setActive: (id: TabId) => void;
  moveTab: (id: TabId, toIndex: number) => void;
  setConn: (id: TabId, conn: ConnState, detail?: string) => void;
  setReconnecting: (id: TabId, info: ReconnectInfo) => void;
  setRustSessionId: (id: TabId, sessionId: string | null) => void;
  setExit: (id: TabId, code: number | null) => void;
  renameTab: (id: TabId, title: string) => void;
}

let nextTabId = 0;
/** Monotonic, never reused — a recycled id would let a late event from a
 *  closed session land on whatever tab inherited its slot. */
export function newTabId(): TabId {
  nextTabId += 1;
  return `t-${nextTabId}`;
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

export const useSessions = create<SessionsState>((set, get) => ({
  order: [],
  byId: {},
  activeId: null,

  openTab: ({ hostId, title }) => {
    const id = newTabId();
    set((s) => ({
      order: [...s.order, id],
      byId: {
        ...s.byId,
        [id]: {
          id,
          hostId,
          title,
          conn: "idle",
          rustSessionId: null,
        },
      },
      activeId: id,
    }));
    return id;
  },

  closeTab: (id) => {
    const { order, byId, activeId } = get();
    if (!byId[id]) return;
    const next = activeId === id ? neighbourOf(order, id) : activeId;
    const remaining = { ...byId };
    delete remaining[id];
    set({
      order: order.filter((t) => t !== id),
      byId: remaining,
      activeId: next,
    });
  },

  setActive: (id) => {
    if (get().byId[id]) set({ activeId: id });
  },

  moveTab: (id, toIndex) => {
    const order = [...get().order];
    const from = order.indexOf(id);
    if (from === -1) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id);
    set({ order });
  },

  setConn: (id, conn, detail) => {
    set((s) => {
      const tab = s.byId[id];
      if (!tab) return s;
      // Any state other than `reconnecting` ends a reconnect, so its progress
      // must not linger and mislead the diagnostics view.
      return { byId: { ...s.byId, [id]: { ...tab, conn, detail, reconnect: null } } };
    });
  },

  setReconnecting: (id, info) => {
    set((s) => {
      const tab = s.byId[id];
      if (!tab) return s;
      return {
        byId: {
          ...s.byId,
          [id]: { ...tab, conn: "reconnecting", reconnect: info, detail: undefined },
        },
      };
    });
  },

  setRustSessionId: (id, sessionId) => {
    set((s) => {
      const tab = s.byId[id];
      if (!tab) return s;
      return { byId: { ...s.byId, [id]: { ...tab, rustSessionId: sessionId } } };
    });
  },

  setExit: (id, code) => {
    set((s) => {
      const tab = s.byId[id];
      if (!tab) return s;
      return {
        byId: {
          ...s.byId,
          [id]: { ...tab, conn: "disconnected", exitCode: code, rustSessionId: null },
        },
      };
    });
  },

  renameTab: (id, title) => {
    set((s) => {
      const tab = s.byId[id];
      if (!tab) return s;
      return { byId: { ...s.byId, [id]: { ...tab, title } } };
    });
  },
}));

/** Tabs in display order. */
export function tabsInOrder(s: SessionsState): Tab[] {
  return s.order.map((id) => s.byId[id]).filter(Boolean);
}
