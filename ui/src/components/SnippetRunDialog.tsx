// Prompt for a snippet's variables, show exactly what will be sent, then send.
//
// The preview is the point: a snippet runs in a live shell (and, with broadcast
// on, in every pane at once), so the expanded text is shown before it goes
// anywhere rather than after.

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldControl, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import type { Snippet } from "../lib/snippets-ipc";
import { substitute, variablesIn } from "../lib/substitute";

export function SnippetRunDialog({
  snippet,
  context,
  broadcasting,
  onCancel,
  onRun,
}: {
  snippet: Snippet;
  /** Prefills for names the pane's host already answers: host, user, port. */
  context: Record<string, string>;
  /** The target tab is broadcasting, so this lands in every pane. */
  broadcasting: boolean;
  onCancel: () => void;
  onRun: (text: string) => void;
}) {
  const variables = useMemo(() => variablesIn(snippet.body), [snippet.body]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v.name, context[v.name] ?? v.fallback])),
  );
  const expanded = substitute(snippet.body, values);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{snippet.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {variables.map((v) => (
            <Field key={v.name}>
              <FieldLabel>{v.name}</FieldLabel>
              <FieldControl
                render={
                  <Input
                    value={values[v.name] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                    }
                  />
                }
              />
            </Field>
          ))}

          <Field>
            <FieldLabel>Will run</FieldLabel>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-field)] px-3 py-2 font-mono text-xs text-[var(--lilt-text)]">
              {expanded}
            </pre>
            {broadcasting && (
              <p className="text-xs text-[var(--lilt-warning-text,var(--lilt-danger-text))]">
                ⇉ Broadcast is on — this runs in every pane of the tab.
              </p>
            )}
          </Field>
        </div>

        <DialogFooter>
          <div className="ml-auto flex gap-3">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={() => onRun(expanded)}>Run</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
