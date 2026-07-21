import { describe, expect, it } from "vitest";

import { isAppAccel, matchShortcut } from "./shortcuts";

describe("isAppAccel", () => {
  it("accepts Cmd (macOS) and Ctrl+Shift (elsewhere)", () => {
    expect(isAppAccel({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(isAppAccel({ metaKey: false, ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it("rejects a bare Ctrl — that belongs to readline", () => {
    // Ctrl+K is kill-line; hijacking it would break the shell.
    expect(isAppAccel({ metaKey: false, ctrlKey: true, shiftKey: false })).toBe(false);
  });
});

describe("matchShortcut", () => {
  it("maps the app chords to actions", () => {
    expect(
      matchShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "k" }),
    ).toBe("palette");
    expect(
      matchShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "F" }),
    ).toBe("search");
  });

  it("does not match a bare Ctrl chord", () => {
    expect(
      matchShortcut({ metaKey: false, ctrlKey: true, shiftKey: false, key: "k" }),
    ).toBeNull();
  });

  it("returns null for unmapped keys", () => {
    expect(
      matchShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "j" }),
    ).toBeNull();
  });
});
