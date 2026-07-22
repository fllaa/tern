import { describe, expect, it } from "vitest";

import { assessPaste, pastePreview } from "./clipboard";

describe("paste assessment", () => {
  it("does not warn on an ordinary single-line command", () => {
    expect(assessPaste("ls -la").needsConfirmation).toBe(false);
  });

  it("does not warn when the command has one trailing newline", () => {
    // This is what copying a command off a web page produces. Counting the
    // trailing newline as a second line would fire the dialog on essentially
    // every paste, and a warning that always fires is one nobody reads.
    expect(assessPaste("ls -la\n").needsConfirmation).toBe(false);
    expect(assessPaste("ls -la\r\n").needsConfirmation).toBe(false);
    expect(assessPaste("ls -la\n").lineCount).toBe(1);
  });

  it("warns when the paste would submit more than one command", () => {
    const a = assessPaste("cd /tmp\nrm -rf .");
    expect(a.lineCount).toBe(2);
    expect(a.needsConfirmation).toBe(true);
  });

  it("counts CRLF the same as LF", () => {
    expect(assessPaste("one\r\ntwo\r\nthree").lineCount).toBe(3);
  });

  it("treats an embedded newline mid-text as multi-line", () => {
    // The dangerous shape: text that looks like one command but carries a
    // newline in the middle.
    expect(assessPaste("echo hi\nrm -rf /").needsConfirmation).toBe(true);
  });

  it("an empty paste is not a command", () => {
    expect(assessPaste("").lineCount).toBe(0);
    expect(assessPaste("\n").lineCount).toBe(0);
    expect(assessPaste("").needsConfirmation).toBe(false);
  });

  it("a zero threshold disables the warning", () => {
    const a = assessPaste("a\nb\nc", { warnAtLines: 0 });
    expect(a.lineCount).toBe(3);
    expect(a.needsConfirmation).toBe(false);
  });

  it("respects a raised threshold", () => {
    const policy = { warnAtLines: 5 };
    expect(assessPaste("a\nb\nc", policy).needsConfirmation).toBe(false);
    expect(assessPaste("a\nb\nc\nd\ne", policy).needsConfirmation).toBe(true);
  });
});

describe("paste preview", () => {
  it("shows every line when the paste is short", () => {
    expect(pastePreview("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("truncates long pastes and says how much was hidden", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const preview = pastePreview(text, 5);
    expect(preview).toHaveLength(6);
    expect(preview[5]).toContain("15 more");
  });

  it("ignores a single trailing newline, matching the assessment", () => {
    expect(pastePreview("a\nb\n")).toEqual(["a", "b"]);
  });
});
