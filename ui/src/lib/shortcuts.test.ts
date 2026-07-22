import { describe, expect, it } from "vitest";

import { accelLabel, eventAccel, isAppAccel, normalizeChord } from "./shortcuts";

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

describe("normalizeChord", () => {
  it("reads the physical key, not the shifted glyph", () => {
    // The regression this guards: with Ctrl+Shift held, a digit's `key` is its
    // shifted symbol ("!"), but its `code` is stable — so accelerators use code.
    expect(normalizeChord({ code: "KeyK" })).toBe("k");
    expect(normalizeChord({ code: "Digit1" })).toBe("1");
    expect(normalizeChord({ code: "BracketRight" })).toBe("]");
    expect(normalizeChord({ code: "BracketLeft" })).toBe("[");
  });

  it("returns null for a key with no accelerator token", () => {
    expect(normalizeChord({ code: "ShiftLeft" })).toBeNull();
  });
});

describe("eventAccel", () => {
  it("extracts the chord for an app-accel event, keyed by code", () => {
    expect(
      eventAccel({ metaKey: true, ctrlKey: false, shiftKey: false, code: "KeyK" }),
    ).toEqual({ key: "k" });
    // Ctrl+Shift+] — the browser reports key "}", but the token is from code.
    expect(
      eventAccel({ metaKey: false, ctrlKey: true, shiftKey: true, code: "BracketRight" }),
    ).toEqual({ key: "]" });
  });

  it("is null for a bare Ctrl chord (readline territory)", () => {
    expect(
      eventAccel({ metaKey: false, ctrlKey: true, shiftKey: false, code: "KeyK" }),
    ).toBeNull();
  });
});

describe("accelLabel", () => {
  it("includes the uppercased key regardless of platform", () => {
    expect(accelLabel({ key: "k" })).toContain("K");
    expect(accelLabel({ key: "]" })).toContain("]");
  });
});
