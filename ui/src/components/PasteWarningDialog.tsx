// Multi-line paste confirmation.
//
// A terminal executes on newline, so pasted text containing one runs
// immediately with no chance to read it first. Showing exactly what is about to
// be submitted is the point — a warning without the content would just be an
// obstacle to click through.

import { Button } from "@/components/ui/button";

import { pastePreview } from "../terminal/clipboard";

export function PasteWarningDialog({
  text,
  lineCount,
  onConfirm,
  onCancel,
}: {
  text: string;
  lineCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const lines = pastePreview(text);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-[var(--radius-dialog)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] text-sm text-[var(--lilt-text)]">
        <header className="px-5 pt-4">
          <h2 className="font-display text-base font-medium">Paste {lineCount} lines?</h2>
          <p className="mt-1 text-[var(--lilt-text-muted)]">
            This paste contains newlines, so the shell will run each line as soon as it
            arrives.
          </p>
        </header>

        <pre className="mx-5 my-3 min-h-0 flex-1 overflow-auto rounded-[var(--radius-control-sm)] bg-[var(--lilt-field)] p-3 font-mono text-xs leading-5 text-[var(--lilt-text)]">
          {lines.join("\n")}
        </pre>

        <footer className="flex justify-end gap-2 border-t border-[var(--lilt-border)] px-5 py-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Paste anyway</Button>
        </footer>
      </div>
    </div>
  );
}
