import { beforeEach, describe, expect, it } from "vitest";

import { collectPaneIds } from "./layout";
import { neighbourOf, relativeTab, tabAtIndex, useSessions } from "./sessions";

function reset() {
  useSessions.setState({ order: [], tabs: {}, panes: {}, activeId: null });
}

beforeEach(reset);

describe("neighbourOf", () => {
  it("prefers the tab to the right", () => {
    expect(neighbourOf(["a", "b", "c"], "b")).toBe("c");
  });

  it("falls back to the left when closing the last tab", () => {
    expect(neighbourOf(["a", "b", "c"], "c")).toBe("b");
  });

  it("returns null when the only tab closes", () => {
    expect(neighbourOf(["a"], "a")).toBeNull();
  });

  it("returns null for a tab that is not there", () => {
    expect(neighbourOf(["a", "b"], "zz")).toBeNull();
  });
});

describe("relativeTab", () => {
  it("steps forward and back in display order", () => {
    expect(relativeTab(["a", "b", "c"], "b", 1)).toBe("c");
    expect(relativeTab(["a", "b", "c"], "b", -1)).toBe("a");
  });

  it("wraps around at both ends", () => {
    expect(relativeTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(relativeTab(["a", "b", "c"], "a", -1)).toBe("c");
  });

  it("returns null with no tabs, and starts from the first when none active", () => {
    expect(relativeTab([], null, 1)).toBeNull();
    expect(relativeTab(["a", "b"], null, 1)).toBe("a");
  });
});

describe("tabAtIndex", () => {
  it("maps a 1-based position to a tab", () => {
    expect(tabAtIndex(["a", "b", "c"], 1)).toBe("a");
    expect(tabAtIndex(["a", "b", "c"], 3)).toBe("c");
  });

  it("returns null out of range", () => {
    expect(tabAtIndex(["a", "b"], 5)).toBeNull();
    expect(tabAtIndex([], 1)).toBeNull();
  });
});

describe("tab lifecycle", () => {
  it("opening a tab makes it active as a single-leaf pane", () => {
    const { tabId, paneId } = useSessions.getState().openTab({ hostId: 1, title: "web" });
    const s = useSessions.getState();
    expect(s.order).toEqual([tabId]);
    expect(s.activeId).toBe(tabId);
    expect(s.tabs[tabId].root).toEqual({ type: "leaf", paneId });
    expect(s.tabs[tabId].activePaneId).toBe(paneId);
    expect(s.panes[paneId].conn).toBe("idle");
    expect(s.panes[paneId].hostId).toBe(1);
  });

  it("closing the active tab activates a neighbour and drops its panes", () => {
    const a = useSessions.getState().openTab({ hostId: 1, title: "a" });
    const b = useSessions.getState().openTab({ hostId: 2, title: "b" });
    const c = useSessions.getState().openTab({ hostId: 3, title: "c" });

    useSessions.getState().setActive(b.tabId);
    useSessions.getState().closeTab(b.tabId);

    const s = useSessions.getState();
    expect(s.order).toEqual([a.tabId, c.tabId]);
    expect(s.activeId).toBe(c.tabId);
    expect(s.tabs[b.tabId]).toBeUndefined();
    expect(s.panes[b.paneId]).toBeUndefined();
  });

  it("tab and pane ids are never reused", () => {
    const a = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().closeTab(a.tabId);
    const b = useSessions.getState().openTab({ hostId: 1, title: "a" });
    expect(b.tabId).not.toBe(a.tabId);
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("closing the last tab leaves nothing active", () => {
    const a = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().closeTab(a.tabId);
    expect(useSessions.getState().activeId).toBeNull();
    expect(useSessions.getState().order).toEqual([]);
  });
});

describe("splitting panes", () => {
  it("splits the active pane and focuses the new one", () => {
    const { tabId, paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    const newPane = useSessions.getState().splitPane(tabId, paneId, "row", {
      hostId: 2,
      title: "b",
    });
    expect(newPane).toBeTruthy();
    const s = useSessions.getState();
    expect(collectPaneIds(s.tabs[tabId].root)).toEqual([paneId, newPane]);
    expect(s.tabs[tabId].activePaneId).toBe(newPane);
    expect(s.panes[newPane as string].hostId).toBe(2);
  });

  it("closing a pane collapses the split and refocuses", () => {
    const { tabId, paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    const newPane = useSessions.getState().splitPane(tabId, paneId, "row", {
      hostId: 2,
      title: "b",
    });
    useSessions.getState().closePane(tabId, newPane as string);
    const s = useSessions.getState();
    expect(s.tabs[tabId].root).toEqual({ type: "leaf", paneId });
    expect(s.tabs[tabId].activePaneId).toBe(paneId);
    expect(s.panes[newPane as string]).toBeUndefined();
  });

  it("closing the last pane closes the whole tab", () => {
    const { tabId, paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().closePane(tabId, paneId);
    const s = useSessions.getState();
    expect(s.tabs[tabId]).toBeUndefined();
    expect(s.panes[paneId]).toBeUndefined();
    expect(s.order).toEqual([]);
  });

  it("toggles broadcast on a tab", () => {
    const { tabId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    expect(useSessions.getState().tabs[tabId].broadcast).toBe(false);
    useSessions.getState().toggleBroadcast(tabId);
    expect(useSessions.getState().tabs[tabId].broadcast).toBe(true);
  });
});

describe("reordering", () => {
  it("moves a tab to a new index", () => {
    const a = useSessions.getState().openTab({ hostId: 1, title: "a" });
    const b = useSessions.getState().openTab({ hostId: 2, title: "b" });
    const c = useSessions.getState().openTab({ hostId: 3, title: "c" });
    useSessions.getState().moveTab(a.tabId, 2);
    expect(useSessions.getState().order).toEqual([b.tabId, c.tabId, a.tabId]);
  });
});

describe("pane connection state", () => {
  it("tracks the state machine and its reason", () => {
    const { paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().setConn(paneId, "connecting");
    expect(useSessions.getState().panes[paneId].conn).toBe("connecting");
    useSessions.getState().setConn(paneId, "error", "auth failed");
    expect(useSessions.getState().panes[paneId].detail).toBe("auth failed");
  });

  it("recording an exit clears the rust session id", () => {
    const { paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().setRustSessionId(paneId, "s-7");
    useSessions.getState().setExit(paneId, 0);
    const pane = useSessions.getState().panes[paneId];
    expect(pane.conn).toBe("disconnected");
    expect(pane.exitCode).toBe(0);
    expect(pane.rustSessionId).toBeNull();
  });

  it("state updates for a closed pane are ignored, not crashes", () => {
    const { tabId, paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().closeTab(tabId);
    expect(() => useSessions.getState().setConn(paneId, "connected")).not.toThrow();
    expect(() => useSessions.getState().setExit(paneId, 1)).not.toThrow();
    expect(useSessions.getState().panes[paneId]).toBeUndefined();
  });

  it("any non-reconnecting state clears reconnect progress", () => {
    const { paneId } = useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().setReconnecting(paneId, { attempt: 3, max: 10, dueAt: 9999 });
    expect(useSessions.getState().panes[paneId].conn).toBe("reconnecting");
    useSessions.getState().setConn(paneId, "connected");
    expect(useSessions.getState().panes[paneId].reconnect).toBeNull();
  });
});
