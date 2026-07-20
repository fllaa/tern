// Copy-on-select and paste protection.
//
// Paste protection exists because a terminal executes on newline. Pasting text
// that contains one runs it immediately, with no chance to read it first —
// which is how the "copy a command off a web page" trick turns into running
// something you never saw. Warning on multi-line paste is the standard
// mitigation and every serious terminal does it.

/** What a paste would do, decided without touching the DOM so it can be tested. */
export interface PasteAssessment {
  /** Lines the paste would submit — i.e. newlines, not visual wrapping. */
  lineCount: number;
  /** Whether the user should be asked before this reaches the shell. */
  needsConfirmation: boolean;
}

export interface PastePolicy {
  /** Warn at or above this many lines. 0 disables the warning entirely. */
  warnAtLines: number;
}

export const DEFAULT_PASTE_POLICY: PastePolicy = { warnAtLines: 2 };

/**
 * Count what a paste would actually submit.
 *
 * A single trailing newline is not a second command — it just submits the one
 * line above it, which is what pasting a command normally means. Counting it
 * would make every ordinary copy-a-command paste trigger the dialog, and a
 * warning that fires constantly is a warning nobody reads.
 */
export function assessPaste(
  text: string,
  policy: PastePolicy = DEFAULT_PASTE_POLICY,
): PasteAssessment {
  const trimmed = text.replace(/\r?\n$/, "");
  const lineCount = trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
  const needsConfirmation = policy.warnAtLines > 0 && lineCount >= policy.warnAtLines;
  return { lineCount, needsConfirmation };
}

/** A short preview for the warning dialog, so the user can see what they got. */
export function pastePreview(text: string, maxLines = 12): string[] {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more line(s)`];
}
