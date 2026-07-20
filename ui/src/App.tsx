// M1 product shell: a real host list backed by SQLite, connecting through
// Target::SavedHost so no credential crosses the IPC boundary.
//
// Deliberately plain markup. The LiltUI product shell — sidebar tree, tabs,
// command palette — lands in the next milestone; this exists so the store,
// keyring auth, and host-key trust can be exercised end to end first.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChangedKey,
  ChangedKeyDialog,
  FirstContactDialog,
} from "./components/HostKeyDialog";
import { SshConfigImportDialog } from "./components/SshConfigImport";
import { type TerminalReady, TerminalView } from "./components/TerminalView";
import {
  type AuthKind,
  createHost,
  deleteHost,
  type Host,
  importKnownHosts,
  listHosts,
  removeKnownHost,
} from "./lib/hosts-ipc";
import { type HostKeyPrompt, TermSession } from "./lib/ipc";
import { useSessionStore } from "./store/session";

interface Draft {
  name: string;
  hostname: string;
  port: string;
  username: string;
  auth: AuthKind;
  keyPath: string;
  secret: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  hostname: "",
  port: "22",
  username: "",
  auth: "agent",
  keyPath: "",
  secret: "",
};

export default function App() {
  const status = useSessionStore((s) => s.status);
  const setStatus = useSessionStore((s) => s.setStatus);

  const [hosts, setHosts] = useState<Host[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeHost, setActiveHost] = useState<Host | null>(null);
  const [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [changed, setChanged] = useState<ChangedKey | null>(null);
  const [importing, setImporting] = useState(false);

  const readyRef = useRef<TerminalReady | null>(null);
  const sessionRef = useRef<TermSession | null>(null);
  // The prompt is answered from a dialog, so the connect's decision has to
  // travel back out of React state to the promise `TermSession.open` awaits.
  const decideRef = useRef<((accept: boolean) => void) | null>(null);

  const refresh = useCallback(async (q: string) => {
    try {
      setHosts(await listHosts({ query: q || null }));
    } catch (err) {
      setNotice(`could not load hosts: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh(query);
  }, [query, refresh]);

  const connect = useCallback(
    async (host: Host) => {
      const ready = readyRef.current;
      if (!ready || sessionRef.current) return;
      setStatus("connecting");
      setNotice("");
      try {
        const session = await TermSession.open(
          ready.term,
          {
            // No credential here — the id is enough, and Rust resolves the
            // secret from the keyring.
            target: { kind: "saved_host", host_id: host.id },
            cols: ready.term.cols,
            rows: ready.term.rows,
          },
          (ev) => {
            if (ev.event === "exited") {
              sessionRef.current = null;
              setActiveHost(null);
              setStatus("idle");
              setNotice(`session ended (code ${ev.code ?? "?"})`);
            } else if (ev.event === "disconnected") {
              sessionRef.current = null;
              setActiveHost(null);
              setStatus("error");
              setNotice(`disconnected: ${ev.reason}`);
            } else if (ev.event === "host_key_changed") {
              setChanged(ev);
            } else if (ev.event === "host_key_revoked") {
              setNotice(
                `host key for ${ev.host}:${ev.port} is revoked (${ev.known_hosts_path}:${ev.known_hosts_line})`,
              );
            } else if (ev.event === "error") {
              setStatus("error");
              setNotice(ev.message);
            }
          },
          (ev) =>
            new Promise<boolean>((resolve) => {
              decideRef.current = resolve;
              setPrompt(ev);
            }),
        );
        sessionRef.current = session;
        setActiveHost(host);
        setStatus("connected");
        void refresh(query);
      } catch (err) {
        setStatus("error");
        setNotice(`connect failed: ${String(err)}`);
      }
    },
    [query, refresh, setStatus],
  );

  const disconnect = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    setActiveHost(null);
    if (s) await s.close().catch(() => {});
    setStatus("idle");
  }, [setStatus]);

  const answerPrompt = useCallback((accept: boolean) => {
    decideRef.current?.(accept);
    decideRef.current = null;
    setPrompt(null);
  }, []);

  const forgetChangedKey = useCallback(async () => {
    if (!changed) return;
    try {
      const n = await removeKnownHost(changed.host, changed.port);
      setNotice(
        n > 0
          ? `forgot ${n} key(s) for ${changed.host} — reconnect to verify the new one`
          : `no stored key found for ${changed.host}`,
      );
    } catch (err) {
      setNotice(`could not forget key: ${String(err)}`);
    }
    setChanged(null);
  }, [changed]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    try {
      await createHost(
        {
          name: draft.name || draft.hostname,
          hostname: draft.hostname,
          port: Number(draft.port) || 22,
          username: draft.username,
          auth: draft.auth,
          keyPath: draft.auth === "key_file" ? draft.keyPath || null : null,
        },
        draft.secret || undefined,
      );
      setDraft(null);
      void refresh(query);
    } catch (err) {
      setNotice(`could not save host: ${String(err)}`);
    }
  }, [draft, query, refresh]);

  const onTerminalReady = useCallback((ready: TerminalReady) => {
    readyRef.current = ready;
  }, []);
  const onInput = useCallback((data: string) => {
    void sessionRef.current?.writeText(data);
  }, []);
  const onResize = useCallback((cols: number, rows: number) => {
    void sessionRef.current?.resize(cols, rows);
  }, []);

  const field = "rounded bg-neutral-800 px-2 py-1 text-xs outline-none";
  const btn =
    "rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600 disabled:opacity-40";

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="text-sm font-medium tracking-wide">Tern</span>
          <button
            type="button"
            className={`${btn} ml-auto`}
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            + host
          </button>
        </div>
        <input
          className={`${field} m-2 rounded`}
          placeholder="search hosts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {hosts.length === 0 && (
            <li className="px-1 py-3 text-xs text-neutral-500">
              No hosts yet. Add one, or import your <code>~/.ssh/known_hosts</code> below.
            </li>
          )}
          {hosts.map((h) => (
            <li key={h.id}>
              <div
                className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-neutral-900 ${
                  activeHost?.id === h.id ? "bg-neutral-900" : ""
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onDoubleClick={() => void connect(h)}
                  onClick={() => void connect(h)}
                  disabled={status === "connecting" || !!sessionRef.current}
                >
                  <div className="truncate text-neutral-100">{h.name}</div>
                  <div className="truncate text-[10px] text-neutral-500">
                    {h.username ? `${h.username}@` : ""}
                    {h.hostname}
                    {h.port === 22 ? "" : `:${h.port}`} · {h.auth}
                    {h.hasSecret ? " 🔑" : ""}
                  </div>
                </button>
                <button
                  type="button"
                  className="hidden text-neutral-500 hover:text-red-400 group-hover:block"
                  title="Delete host"
                  onClick={() => {
                    void deleteHost(h.id).then(() => refresh(query));
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${btn} mx-2`}
          onClick={() => setImporting(true)}
        >
          import ~/.ssh/config
        </button>
        <button
          type="button"
          className={`${btn} m-2`}
          onClick={() => {
            void importKnownHosts()
              .then((r) =>
                setNotice(
                  `imported ${r.imported} of ${r.total} known_hosts entries ` +
                    `(${r.duplicates} already known, ${r.malformed} malformed)`,
                ),
              )
              .catch((err) => setNotice(`import failed: ${String(err)}`));
          }}
        >
          import ~/.ssh/known_hosts
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-sm">
          <span className="text-xs text-neutral-400">
            {activeHost ? activeHost.name : "no session"} · {status}
          </span>
          <button
            type="button"
            className={`${btn} ml-auto`}
            disabled={status !== "connected"}
            onClick={() => void disconnect()}
          >
            disconnect
          </button>
        </header>
        <main className="min-h-0 flex-1">
          <TerminalView onReady={onTerminalReady} onInput={onInput} onResize={onResize} />
        </main>
        {notice && (
          <footer className="shrink-0 border-t border-neutral-800 px-3 py-1 font-mono text-[10px] text-neutral-400">
            {notice}
          </footer>
        )}
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm">
            <h2 className="mb-3 text-base font-medium">New host</h2>
            <div className="space-y-2">
              <input
                className={`${field} w-full`}
                placeholder="name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <div className="flex gap-2">
                <input
                  className={`${field} min-w-0 flex-1`}
                  placeholder="hostname"
                  value={draft.hostname}
                  onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
                />
                <input
                  className={`${field} w-16`}
                  placeholder="port"
                  value={draft.port}
                  onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                />
              </div>
              <input
                className={`${field} w-full`}
                placeholder="username"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
              <select
                className={`${field} w-full`}
                value={draft.auth}
                onChange={(e) => setDraft({ ...draft, auth: e.target.value as AuthKind })}
              >
                <option value="agent">ssh-agent</option>
                <option value="key_file">private key</option>
                <option value="password">password</option>
              </select>
              {draft.auth === "key_file" && (
                <input
                  className={`${field} w-full`}
                  placeholder="path to private key"
                  value={draft.keyPath}
                  onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })}
                />
              )}
              {draft.auth !== "agent" && (
                <input
                  className={`${field} w-full`}
                  type="password"
                  placeholder={draft.auth === "password" ? "password" : "key passphrase"}
                  value={draft.secret}
                  onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                />
              )}
              <p className="text-[10px] text-neutral-500">
                Secrets go to the OS keychain, never to the database.
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setDraft(null)}>
                cancel
              </button>
              <button
                type="button"
                className={btn}
                disabled={!draft.hostname}
                onClick={() => void saveDraft()}
              >
                save
              </button>
            </div>
          </div>
        </div>
      )}

      {prompt && <FirstContactDialog prompt={prompt} onDecide={answerPrompt} />}
      {importing && (
        <SshConfigImportDialog
          onClose={() => setImporting(false)}
          onImported={(created: number, updated: number) => {
            setImporting(false);
            setNotice(`imported ${created} new host(s), updated ${updated}`);
            void refresh(query);
          }}
        />
      )}
      {changed && (
        <ChangedKeyDialog
          detail={changed}
          onForget={() => void forgetChangedKey()}
          onDismiss={() => setChanged(null)}
        />
      )}
    </div>
  );
}
