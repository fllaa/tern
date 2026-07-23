// Snippet manager: the CRUD surface for the command library.
//
// One dialog holds both the list and the editor. Snippets are short, and a
// separate edit dialog for a name plus a body would be two dialogs deep for
// what is really one screen.

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";

import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  type Snippet,
  updateSnippet,
} from "../lib/snippets-ipc";
import { variablesIn } from "../lib/substitute";

export function SnippetsDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  /** The library changed; the palette's snippet group needs reloading. */
  onChanged: () => void;
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  /** The snippet being edited, or null while composing a new one. */
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnippets(await listSnippets());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reset = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setBody("");
  };

  const load = (s: Snippet) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description ?? "");
    setBody(s.body);
  };

  const variables = useMemo(() => variablesIn(body), [body]);
  const canSave = !busy && !!name.trim() && !!body.trim();

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const desc = description.trim() || null;
      if (editing) {
        await updateSnippet({ ...editing, name: name.trim(), body, description: desc });
      } else {
        await createSnippet({ name: name.trim(), body, description: desc });
      }
      reset();
      await refresh();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Snippet) => {
    setError("");
    try {
      await deleteSnippet(s.id);
      if (editing?.id === s.id) reset();
      await refresh();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Snippets</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex max-h-72 min-w-0 flex-col gap-1 overflow-y-auto">
            {snippets.length === 0 ? (
              <p className="text-sm text-[var(--lilt-text-subtle)]">
                No snippets yet — write one alongside.
              </p>
            ) : (
              snippets.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-2 rounded-[var(--radius-control-sm)] px-2 py-1.5 text-sm ${
                    editing?.id === s.id
                      ? "bg-[var(--lilt-surface-2)]"
                      : "hover:bg-[var(--lilt-surface-2)]"
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                    onClick={() => load(s)}
                  >
                    <span className="w-full truncate">{s.name}</span>
                    {s.description && (
                      <span className="w-full truncate text-xs text-[var(--lilt-text-subtle)]">
                        {s.description}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${s.name}`}
                    className="shrink-0 rounded px-1 text-[var(--lilt-text-subtle)] opacity-0 transition-opacity hover:text-[var(--lilt-danger)] group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => void remove(s)}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-3">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <FieldControl
                render={<Input value={name} onChange={(e) => setName(e.target.value)} />}
              />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <FieldControl
                render={
                  <Input
                    placeholder="Optional"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                }
              />
            </Field>
            <Field>
              <FieldLabel>Body</FieldLabel>
              <FieldControl
                render={
                  <Textarea
                    className="min-h-28 font-mono text-sm"
                    placeholder="systemctl restart {{unit}}"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                }
              />
              <p className="text-xs text-[var(--lilt-text-subtle)]">
                {"{{name}} prompts for a value; {{name:default}} prompts with one."}{" "}
                Plaintext — never put a password here.
              </p>
              {variables.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {variables.map((v) => (
                    <Badge key={v.name} variant="default">
                      {v.name}
                    </Badge>
                  ))}
                </div>
              )}
            </Field>
          </div>
        </div>

        {error && <p className="text-xs text-[var(--lilt-danger-text)]">{error}</p>}

        <DialogFooter>
          {editing && (
            <Button variant="secondary" onClick={reset}>
              New snippet
            </Button>
          )}
          <div className="ml-auto flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button disabled={!canSave} onClick={() => void save()}>
              {editing ? "Save" : "Add snippet"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
