// ~/.ssh/config import preview.
//
// The preview is the feature, not decoration around it. Bulk-adding hosts from
// a file the user did not write for us is exactly where silent
// misinterpretation hurts, so: every candidate is shown with what would happen
// to it, everything we could not model is listed, and nothing is written until
// the user says so.

import { useCallback, useEffect, useState } from "react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-neutral-700 bg-neutral-900 text-sm text-neutral-100">
        <header className="border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-medium">Import from ssh_config</h2>
          <p className="mt-0.5 font-mono text-[10px] text-neutral-500">
            {scan?.source ?? "reading…"}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="text-red-400">{error}</p>}

          {scan && scan.candidates.length === 0 && !error && (
            <p className="py-6 text-center text-neutral-500">
              No importable hosts found.
            </p>
          )}

          {scan && scan.candidates.length > 0 && (
            <ul className="space-y-1">
              {scan.candidates.map((c) => (
                <li key={c.alias}>
                  <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-neutral-800">
                    <input
                      type="checkbox"
                      checked={chosen.has(c.alias)}
                      onChange={() => toggle(c.alias)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-neutral-100">{c.alias}</span>
                      <span className="ml-2 text-[11px] text-neutral-500">
                        {c.username ? `${c.username}@` : ""}
                        {c.hostname}
                        {c.port === 22 ? "" : `:${c.port}`} · {c.auth}
                        {c.proxyJump ? ` · via ${c.proxyJump}` : ""}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                        c.disposition === "update"
                          ? "bg-amber-950 text-amber-300"
                          : "bg-neutral-800 text-neutral-400"
                      }`}
                    >
                      {c.disposition === "update" ? "updates existing" : "new"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {scan && scan.warnings.length > 0 && (
            <details className="mt-4 rounded border border-neutral-800 bg-neutral-950 p-3">
              <summary className="cursor-pointer text-[11px] text-neutral-400">
                {scan.warnings.length} thing
                {scan.warnings.length === 1 ? "" : "s"} not imported
              </summary>
              <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-neutral-500">
                {scan.warnings.map((w) => (
                  <li key={`${w.kind}-${w.file}-${w.line}`}>{describeWarning(w)}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-neutral-800 px-5 py-3">
          <span className="text-[11px] text-neutral-500">
            {newCount} new, {updateCount} updated
          </span>
          <button
            type="button"
            className="ml-auto rounded px-3 py-1.5 text-neutral-300 hover:bg-neutral-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-neutral-200 px-3 py-1.5 font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            disabled={busy || chosen.size === 0}
            onClick={() => void commit()}
          >
            Import {chosen.size}
          </button>
        </footer>
      </div>
    </div>
  );
}
