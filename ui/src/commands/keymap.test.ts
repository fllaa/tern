import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessions } from "../store/sessions";
import { DEFAULT_KEYMAP, dispatchKey, isBoundAccel } from "./keymap";
import { STATIC_COMMANDS } from "./registry";
import type { CommandContext } from "./types";

function resetStore() {
  useSessions.setState({ order: [], tabs: {}, panes: {}, activeId: null });
}

function noopCtx(): CommandContext {
  return {
    openHost: vi.fn(),
    openLocalShell: vi.fn(),
    connectHostPrompt: vi.fn(),
    focusSearch: vi.fn(),
    togglePalette: vi.fn(),
    closeActivePane: vi.fn(),
    selectRelativeTab: vi.fn(),
    selectTabByIndex: vi.fn(),
    selectTab: vi.fn(),
    renameActiveTab: vi.fn(),
    splitActive: vi.fn(),
    focusNextPane: vi.fn(),
    toggleBroadcast: vi.fn(),
    duplicateActivePane: vi.fn(),
  };
}

function keydown(init: {
  code: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent;
}

beforeEach(resetStore);

describe("DEFAULT_KEYMAP", () => {
  it("maps every entry to a defined static command", () => {
    const ids = new Set(STATIC_COMMANDS.map((c) => c.id));
    for (const { command } of DEFAULT_KEYMAP) expect(ids.has(command)).toBe(true);
  });

  it("has no duplicate accelerators", () => {
    const keys = DEFAULT_KEYMAP.map((b) => b.accel.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isBoundAccel", () => {
  it("claims bound chords and lets paste/copy fall through the seam", () => {
    expect(isBoundAccel({ key: "]" })).toBe(true);
    expect(isBoundAccel({ key: "w" })).toBe(true);
    expect(isBoundAccel({ key: "v" })).toBe(false); // paste stays with the shell path
    expect(isBoundAccel({ key: "c" })).toBe(false); // copy stays native
    expect(isBoundAccel(null)).toBe(false);
  });
});

describe("dispatchKey", () => {
  it("runs the mapped command and prevents default for a bound chord", () => {
    const ctx = noopCtx();
    const e = keydown({ metaKey: true, code: "KeyT" });
    expect(dispatchKey(e, ctx)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ctx.openLocalShell).toHaveBeenCalledTimes(1);
  });

  it("ignores an unbound chord", () => {
    const ctx = noopCtx();
    const e = keydown({ metaKey: true, code: "KeyJ" });
    expect(dispatchKey(e, ctx)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("swallows a bound-but-disabled command without running it", () => {
    const ctx = noopCtx(); // no active tab -> tab.close is disabled
    const e = keydown({ metaKey: true, code: "KeyW" });
    expect(dispatchKey(e, ctx)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ctx.closeActivePane).not.toHaveBeenCalled();
  });

  it("resolves the chord from code, not the shifted key glyph", () => {
    const ctx = noopCtx();
    useSessions.getState().openTab({ hostId: 1, title: "a" });
    useSessions.getState().openTab({ hostId: 2, title: "b" });
    // Ctrl+Shift+] arrives as key "}" but code "BracketRight"; must hit tab.next.
    const e = keydown({ ctrlKey: true, shiftKey: true, code: "BracketRight" });
    expect(dispatchKey(e, ctx)).toBe(true);
    expect(ctx.selectRelativeTab).toHaveBeenCalledWith(1);
  });
});
