// ~/.ssh/config import preview.
//
// The preview is the feature, not decoration around it. Bulk-adding hosts from
// a file the user did not write for us is exactly where silent
// misinterpretation hurts, so: every candidate is shown with what would happen
// to it, everything we could not model is listed, and nothing is written until
// the user says so.

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  describeWarning,
  importSshConfig,
  type SshConfigScan,
  scanSshConfig,
} from "../lib/hosts-ipc";

export function SshConfigImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (created: number, updated: number) => void;
}) {
  const [scan, setScan] = useState<SshConfigScan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void scanSshConfig()
      .then((s) => {
        setScan(s);
        // Pre-select everything: the common case is "yes, all of it", and the
        // per-row checkboxes are there for the exceptions.
        setChosen(new Set(s.candidates.map((c) => c.alias)));
      })
      .catch((err) => setError(String(err)));
  }, []);

  const toggle = useCallback((alias: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) {
        next.delete(alias);
      } else {
        next.add(alias);
      }
      return next;
    });
  }, []);

  const commit = useCallback(async () => {
    setBusy(true);
    try {
      const result = await importSshConfig([...chosen]);
      onImported(result.created, result.updated);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [chosen, onImported]);

  const newCount =
    scan?.candidates.filter((c) => c.disposition === "new" && chosen.has(c.alias))
      .length ?? 0;
  const updateCount =
    scan?.candidates.filter((c) => c.disposition === "update" && chosen.has(c.alias))
      .length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,42rem)] flex-col">
        <DialogHeader>
          <DialogTitle>Import from ssh_config</DialogTitle>
          <p className="mt-1 font-mono text-[11px] text-[var(--lilt-text-subtle)]">
            {scan?.source ?? "reading…"}
          </p>
        </DialogHeader>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {error && <p className="text-sm text-[var(--lilt-danger-text)]">{error}</p>}

          {scan && scan.candidates.length === 0 && !error && (
            <p className="py-6 text-center text-sm text-[var(--lilt-text-subtle)]">
              No importable hosts found.
            </p>
          )}

          {scan && scan.candidates.length > 0 && (
            <ul className="space-y-1">
              {scan.candidates.map((c, i) => {
                const rowId = `ssh-import-${i}`;
                return (
                  <li key={c.alias}>
                    <label
                      htmlFor={rowId}
                      className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-control-sm)] px-2 py-1.5 hover:bg-[var(--lilt-surface-2)]"
                    >
                      <Checkbox
                        id={rowId}
                        checked={chosen.has(c.alias)}
                        onCheckedChange={() => toggle(c.alias)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-sm text-[var(--lilt-text)]">{c.alias}</span>
                        <span className="ml-2 text-[11px] text-[var(--lilt-text-subtle)]">
                          {c.username ? `${c.username}@` : ""}
                          {c.hostname}
                          {c.port === 22 ? "" : `:${c.port}`} · {c.auth}
                          {c.proxyJump ? ` · via ${c.proxyJump}` : ""}
                        </span>
                      </span>
                      <Badge variant={c.disposition === "update" ? "warning" : "outline"}>
                        {c.disposition === "update" ? "updates existing" : "new"}
                      </Badge>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {scan && scan.warnings.length > 0 && (
            <details className="mt-4 rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-surface-2)] p-3">
              <summary className="cursor-pointer text-xs text-[var(--lilt-text-muted)]">
                {scan.warnings.length} thing
                {scan.warnings.length === 1 ? "" : "s"} not imported
              </summary>
              <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-[var(--lilt-text-subtle)]">
                {scan.warnings.map((w) => (
                  <li key={`${w.kind}-${w.file}-${w.line}`}>{describeWarning(w)}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <DialogFooter>
          <span className="text-xs text-[var(--lilt-text-subtle)]">
            {newCount} new, {updateCount} updated
          </span>
          <Button variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || chosen.size === 0} onClick={() => void commit()}>
            Import {chosen.size}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
