// Product shell: resizable sidebar, session tabs, pooled terminals.

import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import {
  type ChangedKey,
  ChangedKeyDialog,
  FirstContactDialog,
} from "./components/HostKeyDialog";
import { HostNewDialog } from "./components/HostNewDialog";
import { HostPalette } from "./components/HostPalette";
import { HostSidebar } from "./components/HostSidebar";
import { PasteWarningDialog } from "./components/PasteWarningDialog";
import { SessionOverlay, StatusPill } from "./components/SessionStatus";
import { SessionTabs } from "./components/SessionTabs";
import { SshConfigImportDialog } from "./components/SshConfigImport";
import { TerminalMount } from "./components/TerminalMount";
import {
  type Folder,
  type Host,
  keyringStatus,
  listFolders,
  listHosts,
  removeKnownHost,
} from "./lib/hosts-ipc";
import type { HostKeyPrompt } from "./lib/ipc";
import { matchShortcut } from "./lib/shortcuts";
import * as controller from "./session/controller";
import { useSessions } from "./store/sessions";
import { assessPaste } from "./terminal/clipboard";
import * as pool from "./terminal/pool";

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [flowLine, setFlowLine] = useState("");

  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [palette, setPalette] = useState(false);
  // Non-null when this machine has no working credential store. A persistent
  // banner rather than a transient notice: it changes what "remember my
  // password" can mean, and stays true for the whole session.
  const [keyringWarning, setKeyringWarning] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [changed, setChanged] = useState<ChangedKey | null>(null);
  const [pastePending, setPastePending] = useState<{
    text: string;
    lineCount: number;
    tabId: string;
  } | null>(null);

  const order = useSessions((s) => s.order);
  const activeId = useSessions((s) => s.activeId);
  const byId = useSessions((s) => s.byId);
  const openTab = useSessions((s) => s.openTab);
  const closeTab = useSessions((s) => s.closeTab);

  // The host-key prompt is answered from a dialog, so the decision has to
  // travel back out of React state to the promise the connect is awaiting.
  const decideRef = useRef<((accept: boolean) => void) | null>(null);

  const refresh = useCallback(async (q: string) => {
    try {
      const [h, f] = await Promise.all([listHosts({ query: q || null }), listFolders()]);
      setHosts(h);
      setFolders(f);
    } catch (err) {
      setNotice(`could not load hosts: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh(query);
  }, [query, refresh]);

  // App-level shortcuts. Bound on window (capture phase) so they fire even
  // while a terminal holds focus — xterm lets these chords bubble because the
  // terminal's own key handler returns false for them (see wireClipboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = matchShortcut(e);
      if (shortcut === "palette") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Probe the credential store once at startup. A failure to even ask is
  // treated as "no store" — the honest default is to warn rather than to
  // assume it works and silently drop saved secrets.
  useEffect(() => {
    keyringStatus()
      .then((status) => {
        if (!status.available) {
          setKeyringWarning(status.reason ?? "The OS credential store is unavailable.");
        }
      })
      .catch((err) => setKeyringWarning(String(err)));
  }, []);

  /** Copy-on-select, and route multi-line pastes through a confirmation. */
  const wireClipboard = useCallback((tabId: string, handle: pool.TerminalHandle) => {
    const { term } = handle;

    const selection = term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    });
    handle.disposers.push(() => selection.dispose());

    // Returning false from the custom key handler means xterm does not process
    // the event, so paste is intercepted before anything reaches the shell.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // App chords (palette, search) must reach the window listener, not the
      // shell. Returning false stops xterm from consuming them so they bubble.
      if (matchShortcut(ev)) return false;

      const accel = ev.metaKey || ev.ctrlKey;
      if (!accel) return true;
      const key = ev.key.toLowerCase();

      if (key === "v" && (ev.metaKey || ev.shiftKey)) {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (!text) return;
            const { needsConfirmation, lineCount } = assessPaste(text);
            if (needsConfirmation) {
              setPastePending({ text, lineCount, tabId });
            } else {
              controller.write(tabId, text);
            }
          })
          .catch(() => {});
        return false;
      }
      // Copy is already handled by copy-on-select; let Cmd/Ctrl+Shift+C through
      // to the browser so the native copy path still works.
      return true;
    });
  }, []);

  // The connect call, shared by opening a host and reconnecting an existing
  // tab. Reconnecting reuses the tab's terminal (and its already-wired data and
  // resize handlers), so this must not touch the pool — only re-bind a session.
  const runConnect = useCallback(
    (tabId: string, hostId: number) =>
      controller.connect({
        tabId,
        hostId,
        onHostKey: (ev) =>
          new Promise<boolean>((resolve) => {
            decideRef.current = resolve;
            setPrompt(ev);
          }),
        onEvent: (ev) => {
          // Non-fatal, so it gets the notice bar rather than the error state —
          // the session is still connecting, and usually still connects.
          if (ev.event === "warning") setNotice(ev.message);
          if (ev.event === "host_key_changed") setChanged(ev);
          if (ev.event === "host_key_revoked") {
            setNotice(
              `host key for ${ev.host}:${ev.port} is revoked (${ev.known_hosts_path}:${ev.known_hosts_line})`,
            );
          }
        },
      }),
    [],
  );

  const openHost = useCallback(
    async (hostId: number) => {
      const host = hosts.find((h) => h.id === hostId);
      if (!host) return;

      // Font before terminal: xterm's WebGL renderer caches a glyph atlas from
      // whatever font is loaded when the Terminal is constructed, and a
      // fallback measured there stays wrong for the session's whole life.
      await pool.waitForTerminalFont();

      const tabId = openTab({ hostId, title: host.name });
      const handle = pool.acquire(tabId);
      handle.term.onData((data) => controller.write(tabId, data));
      handle.term.onResize(({ cols, rows }) => controller.resize(tabId, cols, rows));
      wireClipboard(tabId, handle);

      await runConnect(tabId, hostId);
      void refresh(query);
    },
    [hosts, openTab, query, refresh, wireClipboard, runConnect],
  );

  // Manual reconnect for a tab the supervisor gave up on. The terminal and its
  // handlers are still in the pool (the tab never closed), so this only needs
  // to bind a fresh session to it.
  const reconnectTab = useCallback(
    (tabId: string) => {
      const tab = useSessions.getState().byId[tabId];
      if (tab?.hostId != null) void runConnect(tabId, tab.hostId);
    },
    [runConnect],
  );

  const onCloseTab = useCallback(
    (id: string) => {
      void controller.destroy(id);
      closeTab(id);
    },
    [closeTab],
  );

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
          ? `Forgot ${n} key(s) for ${changed.host}. Reconnect to verify the new one.`
          : `No stored key found for ${changed.host}.`,
      );
    } catch (err) {
      setNotice(`could not forget key: ${String(err)}`);
    }
    setChanged(null);
  }, [changed]);

  // Flow stats are read straight off the session object, never through the
  // store — that object mutates on every frame and would re-render at 100 Hz.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = useSessions.getState().activeId;
      const flow = id ? controller.flowOf(id) : null;
      if (!flow) {
        setFlowLine("");
        return;
      }
      setFlowLine(
        `${(flow.recvBytes / 1048576).toFixed(1)} MB · ${flow.pauseCount} pauses${
          flow.paused ? " · paused (flow control)" : ""
        }`,
      );
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const activeTab = activeId ? byId[activeId] : null;

  return (
    <div className="h-full bg-[var(--lilt-canvas)] font-sans text-[var(--lilt-text)]">
      {/*
        Two v4 gotchas are load-bearing here.

        1. Sizes are unit-sensitive: a bare number is PIXELS, a bare string is a
           percentage. v3 read numbers as percentages, so the `minSize={14}` /
           `maxSize={40}` carried over from it silently became a 14px..40px
           sidebar.
        2. Panel `defaultSize` is dropped on the first render: the constraint
           resolver bails out with `defaultSize: undefined` whenever the group
           measures 0, which it does before layout. The panel then keeps the
           auto-assigned even split and, once measurement lands, gets clamped —
           so it renders pinned to `maxSize` no matter what `defaultSize` says.
           Group-level `defaultLayout` is applied by panel id and does not
           depend on that first measurement, so it is the one that survives.
      */}
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={{ sidebar: 22, terminals: 78 }}
      >
        {/* Percentage start, pixel bounds: a host list needs a real minimum to
            show names, and never needs to be half an ultrawide display.
            `defaultSize` is redundant for the initial layout (see above) but is
            still what double-clicking the separator resets to, so it stays. */}
        <ResizablePanel
          id="sidebar"
          defaultSize="22"
          minSize={200}
          maxSize={420}
          collapsible
          collapsedSize={0}
        >
          <HostSidebar
            hosts={hosts}
            folders={folders}
            query={query}
            onQueryChange={setQuery}
            onOpenHost={(id) => void openHost(id)}
            header={
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="font-display text-sm font-semibold">Tern</span>
                <Button
                  size="sm"
                  variant="soft"
                  className="ml-auto"
                  onClick={() => setAdding(true)}
                >
                  Add host
                </Button>
              </div>
            }
            footer={
              <div className="border-t border-[var(--lilt-border)] p-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  onClick={() => setImporting(true)}
                >
                  Import ssh_config
                </Button>
              </div>
            }
          />
        </ResizablePanel>

        {/* The grip is what makes `collapsible` recoverable: dragged to zero,
            an invisible separator leaves no clue the sidebar can come back. */}
        <ResizableHandle withHandle />

        <ResizablePanel id="terminals">
          <div className="flex h-full min-w-0 flex-col bg-[var(--lilt-surface)]">
            {keyringWarning && (
              <Alert variant="warning" className="m-3 rounded-[var(--radius-card)]">
                <AlertTitle>Credentials can't be saved on this machine</AlertTitle>
                <AlertDescription>
                  {keyringWarning} Passwords and key passphrases will be asked for each
                  time instead of remembered.
                </AlertDescription>
              </Alert>
            )}
            {order.length > 0 && (
              <SessionTabs onClose={onCloseTab} onNew={() => setAdding(true)} />
            )}

            <main className="relative min-h-0 flex-1">
              {order.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-[var(--lilt-text-subtle)]">
                    Select a host to open a session.
                  </p>
                </div>
              ) : (
                <>
                  {activeTab && (
                    <SessionOverlay
                      tab={activeTab}
                      onReconnect={() => reconnectTab(activeTab.id)}
                    />
                  )}
                  <TerminalMount />
                </>
              )}
            </main>

            <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--lilt-border)] px-3 text-[11px] text-[var(--lilt-text-subtle)]">
              {activeTab && <StatusPill tab={activeTab} />}
              <span className="ml-auto font-mono">{flowLine}</span>
            </footer>
            {notice && (
              <div className="shrink-0 border-t border-[var(--lilt-border)] bg-[var(--lilt-surface-2)] px-3 py-1 font-mono text-[10px] text-[var(--lilt-text-muted)]">
                {notice}
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {adding && (
        <HostNewDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void refresh(query);
          }}
        />
      )}
      {importing && (
        <SshConfigImportDialog
          onClose={() => setImporting(false)}
          onImported={(created: number, updated: number) => {
            setImporting(false);
            setNotice(`Imported ${created} new host(s), updated ${updated}.`);
            void refresh(query);
          }}
        />
      )}
      <HostPalette
        hosts={hosts}
        open={palette}
        onOpenChange={setPalette}
        onPick={(id) => void openHost(id)}
      />
      {prompt && <FirstContactDialog prompt={prompt} onDecide={answerPrompt} />}
      {changed && (
        <ChangedKeyDialog
          detail={changed}
          onForget={() => void forgetChangedKey()}
          onDismiss={() => setChanged(null)}
        />
      )}
      {pastePending && (
        <PasteWarningDialog
          text={pastePending.text}
          lineCount={pastePending.lineCount}
          onCancel={() => setPastePending(null)}
          onConfirm={() => {
            controller.write(pastePending.tabId, pastePending.text);
            setPastePending(null);
          }}
        />
      )}
    </div>
  );
}
