import { beforeEach, describe, expect, it } from "vitest";

import { neighbourOf, relativeTab, tabAtIndex, useSessions } from "./sessions";

function reset() {
  useSessions.setState({ order: [], byId: {}, activeId: null });
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
  it("opening a tab makes it active", () => {
    const id = useSessions.getState().openTab({ hostId: 1, title: "web" });
    const s = useSessions.getState();
    expect(s.order).toEqual([id]);
    expect(s.activeId).toBe(id);
    expect(s.byId[id].conn).toBe("idle");
  });

  it("closing the active tab activates a neighbour", () => {
    const { openTab, closeTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    const b = openTab({ hostId: 2, title: "b" });
    const c = openTab({ hostId: 3, title: "c" });

    useSessions.getState().setActive(b);
    closeTab(b);

    const s = useSessions.getState();
    expect(s.order).toEqual([a, c]);
    expect(s.activeId).toBe(c);
    expect(s.byId[b]).toBeUndefined();
  });

  it("closing an inactive tab leaves the active one alone", () => {
    const { openTab, closeTab, setActive } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    const b = openTab({ hostId: 2, title: "b" });
    setActive(a);

    closeTab(b);
    expect(useSessions.getState().activeId).toBe(a);
  });

  it("closing the last tab leaves nothing active", () => {
    const { openTab, closeTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    closeTab(a);
    expect(useSessions.getState().activeId).toBeNull();
    expect(useSessions.getState().order).toEqual([]);
  });

  it("tab ids are never reused", () => {
    // A recycled id would let a late event from a closed session land on
    // whatever tab inherited its slot.
    const { openTab, closeTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    closeTab(a);
    const b = openTab({ hostId: 1, title: "a" });
    expect(b).not.toBe(a);
  });

  it("closing an unknown tab is a no-op", () => {
    const { openTab, closeTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    closeTab("nonexistent");
    expect(useSessions.getState().order).toEqual([a]);
  });
});

describe("reordering", () => {
  it("moves a tab to a new index", () => {
    const { openTab, moveTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    const b = openTab({ hostId: 2, title: "b" });
    const c = openTab({ hostId: 3, title: "c" });

    moveTab(a, 2);
    expect(useSessions.getState().order).toEqual([b, c, a]);
  });

  it("clamps an out-of-range index rather than dropping the tab", () => {
    const { openTab, moveTab } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    const b = openTab({ hostId: 2, title: "b" });

    moveTab(a, 99);
    expect(useSessions.getState().order).toEqual([b, a]);
    moveTab(a, -5);
    expect(useSessions.getState().order).toEqual([a, b]);
  });
});

describe("connection state", () => {
  it("tracks the state machine and its reason", () => {
    const { openTab, setConn } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });

    setConn(a, "connecting");
    expect(useSessions.getState().byId[a].conn).toBe("connecting");

    setConn(a, "error", "auth failed");
    expect(useSessions.getState().byId[a].conn).toBe("error");
    expect(useSessions.getState().byId[a].detail).toBe("auth failed");
  });

  it("recording an exit clears the rust session id", () => {
    // A stale id would let write/resize target a session Rust has dropped.
    const { openTab, setRustSessionId, setExit } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    setRustSessionId(a, "s-7");
    expect(useSessions.getState().byId[a].rustSessionId).toBe("s-7");

    setExit(a, 0);
    const tab = useSessions.getState().byId[a];
    expect(tab.conn).toBe("disconnected");
    expect(tab.exitCode).toBe(0);
    expect(tab.rustSessionId).toBeNull();
  });

  it("state updates for a closed tab are ignored, not crashes", () => {
    // Events arrive asynchronously and can outlive the tab that caused them.
    const { openTab, closeTab, setConn, setExit } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    closeTab(a);

    expect(() => setConn(a, "connected")).not.toThrow();
    expect(() => setExit(a, 1)).not.toThrow();
    expect(useSessions.getState().byId[a]).toBeUndefined();
  });
});

describe("reconnect state", () => {
  it("setReconnecting moves the tab into reconnecting with progress", () => {
    const { openTab, setReconnecting } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    setReconnecting(a, { attempt: 2, max: 10, dueAt: 1234 });

    const tab = useSessions.getState().byId[a];
    expect(tab.conn).toBe("reconnecting");
    expect(tab.reconnect).toEqual({ attempt: 2, max: 10, dueAt: 1234 });
  });

  it("any non-reconnecting state clears the reconnect progress", () => {
    // Left dangling, the old attempt/countdown would keep showing after the
    // session reconnected or gave up.
    const { openTab, setReconnecting, setConn } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    setReconnecting(a, { attempt: 3, max: 10, dueAt: 9999 });

    setConn(a, "connected");
    expect(useSessions.getState().byId[a].reconnect).toBeNull();
  });

  it("reconnecting a closed tab is ignored rather than a crash", () => {
    const { openTab, closeTab, setReconnecting } = useSessions.getState();
    const a = openTab({ hostId: 1, title: "a" });
    closeTab(a);
    expect(() => setReconnecting(a, { attempt: 1, max: 5, dueAt: 0 })).not.toThrow();
  });
});
