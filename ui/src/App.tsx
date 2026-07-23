// Product shell: resizable sidebar, session tabs, pooled terminals.

import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { dispatchKey, isBoundAccel } from "./commands/keymap";
import type { CommandContext } from "./commands/types";
import { AppearanceDialog } from "./components/AppearanceDialog";
import { CommandPalette } from "./components/CommandPalette";
import {
  type ChangedKey,
  ChangedKeyDialog,
  FirstContactDialog,
} from "./components/HostKeyDialog";
import { HostNewDialog } from "./components/HostNewDialog";
import { HostSidebar } from "./components/HostSidebar";
import { PasteWarningDialog } from "./components/PasteWarningDialog";
import { StatusPill } from "./components/SessionStatus";
import { SessionTabs } from "./components/SessionTabs";
import { SnippetRunDialog } from "./components/SnippetRunDialog";
import { SnippetsDialog } from "./components/SnippetsDialog";
import { SshConfigImportDialog } from "./components/SshConfigImport";
import { TerminalMount } from "./components/TerminalMount";
import { TerminalSearch } from "./components/TerminalSearch";
import {
  type Appearance,
  applyAppearance,
  DEFAULT_APPEARANCE,
  getAppearance,
  setAppearance as persistAppearance,
  watchSystemTheme,
} from "./lib/appearance";
import {
  deleteHost,
  type Folder,
  type Host,
  keyringStatus,
  listFolders,
  listHosts,
  removeKnownHost,
  type TestConnectionReq,
  type TestConnectionResult,
  testConnection,
} from "./lib/hosts-ipc";
import type { HostKeyPrompt, SessionEvent } from "./lib/ipc";
import { eventAccel } from "./lib/shortcuts";
import { listSnippets, type Snippet } from "./lib/snippets-ipc";
import { hostContext, variablesIn } from "./lib/substitute";
import * as controller from "./session/controller";
import { collectPaneIds, neighbourPane, type SplitDir } from "./store/layout";
import { relativeTab, tabAtIndex, useSessions } from "./store/sessions";
import { assessPaste } from "./terminal/clipboard";
import * as pool from "./terminal/pool";

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [flowLine, setFlowLine] = useState("");

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [importing, setImporting] = useState(false);
  const [palette, setPalette] = useState(false);
  const [searching, setSearching] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [runningSnippet, setRunningSnippet] = useState<Snippet | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [showAppearance, setShowAppearance] = useState(false);
  // Non-null when this machine has no working credential store. A persistent
  // banner rather than a transient notice: it changes what "remember my
  // password" can mean, and stays true for the whole session.
  const [keyringWarning, setKeyringWarning] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [changed, setChanged] = useState<ChangedKey | null>(null);
  const [pastePending, setPastePending] = useState<{
    text: string;
    lineCount: number;
    paneId: string;
  } | null>(null);

  const order = useSessions((s) => s.order);
  const activeId = useSessions((s) => s.activeId);
  const tabs = useSessions((s) => s.tabs);
  const panes = useSessions((s) => s.panes);
  const openTab = useSessions((s) => s.openTab);
  const closeTab = useSessions((s) => s.closeTab);

  // The host-key prompt is answered from a dialog, so the decision has to
  // travel back out of React state to the promise the connect is awaiting.
  const decideRef = useRef<((accept: boolean) => void) | null>(null);
  // The command context, mirrored so the window keydown handler always
  // dispatches against the latest closures without re-subscribing.
  const cmdCtxRef = useRef<CommandContext | null>(null);
  // When set, the next spawned session splits the active pane in this direction
  // rather than opening a new tab. Armed by a split command, consumed by the
  // next spawn, cleared when the palette closes.
  const splitDirRef = useRef<SplitDir | null>(null);

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

  const refreshSnippets = useCallback(async () => {
    try {
      setSnippets(await listSnippets());
    } catch {
      // A snippet library that will not load must not block the shell — the
      // manager surfaces the real error when it is opened.
    }
  }, []);

  useEffect(() => {
    void refreshSnippets();
  }, [refreshSnippets]);

  // App-level shortcuts. Bound on window so they fire even while a terminal
  // holds focus — xterm lets bound chords bubble because the terminal's own key
  // handler returns false for them (see wireClipboard). Dispatch reads the
  // context through a ref so it always sees the latest closures.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cmdCtxRef.current) dispatchKey(e, cmdCtxRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load and apply saved appearance once at startup. Applied before the state
  // is set so the terminal never flashes the default before the saved theme.
  useEffect(() => {
    getAppearance()
      .then((a) => {
        applyAppearance(a);
        setAppearance(a);
      })
      .catch(() => applyAppearance(DEFAULT_APPEARANCE));
  }, []);

  // A "system" theme has to keep following the OS while the app is open.
  useEffect(
    () => watchSystemTheme(appearance.theme, () => applyAppearance(appearance)),
    [appearance],
  );

  // Apply live and persist. Live first so the change is visible immediately;
  // the write is fire-and-forget because a failed persist must not block the UI.
  const changeAppearance = useCallback((next: Appearance) => {
    applyAppearance(next);
    setAppearance(next);
    void persistAppearance(next).catch(() => {});
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
  const wireClipboard = useCallback((paneId: string, handle: pool.TerminalHandle) => {
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

      // Bound app chords must reach the window listener, not the shell.
      // Returning false stops xterm from consuming them so they bubble.
      if (isBoundAccel(eventAccel(ev))) return false;

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
              setPastePending({ text, lineCount, paneId });
            } else {
              controller.write(paneId, text);
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
  // pane. Reconnecting reuses the pane's terminal (and its already-wired data
  // and resize handlers), so this must not touch the pool — only re-bind a
  // session.
  const runConnect = useCallback(
    (paneId: string, hostId: number) =>
      controller.connect({
        paneId,
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

  // Route a pane's keystrokes: to itself, or — when its tab is broadcasting —
  // to every pane in the tab. Fan-out is a plain loop; the backend's per-session
  // writers already tolerate concurrent writes.
  const writeData = useCallback((paneId: string, tabId: string, data: string) => {
    const tab = useSessions.getState().tabs[tabId];
    if (tab?.broadcast) {
      for (const pid of collectPaneIds(tab.root)) controller.write(pid, data);
    } else {
      controller.write(paneId, data);
    }
  }, []);

  // Create a pane, wire its terminal I/O, and connect it. The pane is a new tab,
  // or — when a split is armed (see `splitDirRef`) — a split of the active pane.
  const spawn = useCallback(
    async (init: { hostId: number | null; title: string }) => {
      // Consume the split direction synchronously, before any await, so a
      // concurrent palette close cannot clear it out from under us.
      const dir = splitDirRef.current;
      splitDirRef.current = null;

      // Font before terminal: xterm's WebGL renderer caches a glyph atlas from
      // whatever font is loaded when the Terminal is constructed, and a fallback
      // measured there stays wrong for the session's whole life.
      await pool.waitForTerminalFont();

      const st = useSessions.getState();
      let tabId: string;
      let paneId: string;
      if (dir && st.activeId && st.tabs[st.activeId]) {
        const tab = st.tabs[st.activeId];
        const created = st.splitPane(tab.id, tab.activePaneId, dir, init);
        if (!created) return;
        tabId = tab.id;
        paneId = created;
      } else {
        const opened = openTab(init);
        tabId = opened.tabId;
        paneId = opened.paneId;
      }

      const handle = pool.acquire(paneId);
      handle.term.onData((data) => writeData(paneId, tabId, data));
      handle.term.onResize(({ cols, rows }) => controller.resize(paneId, cols, rows));
      wireClipboard(paneId, handle);

      if (init.hostId != null) {
        await runConnect(paneId, init.hostId);
        void refresh(query);
      } else {
        await controller.connectLocal({
          paneId,
          onEvent: (ev) => {
            if (ev.event === "warning") setNotice(ev.message);
          },
        });
      }
    },
    [openTab, wireClipboard, runConnect, writeData, query, refresh],
  );

  const openHost = useCallback(
    (hostId: number) => {
      const host = hosts.find((h) => h.id === hostId);
      if (host) void spawn({ hostId, title: host.name });
    },
    [hosts, spawn],
  );

  const openLocalShell = useCallback(() => {
    void spawn({ hostId: null, title: "Local shell" });
  }, [spawn]);

  // Duplicate the focused pane's target — its host, or a local shell.
  const duplicateActivePane = useCallback(() => {
    const st = useSessions.getState();
    const tab = st.activeId ? st.tabs[st.activeId] : null;
    const pane = tab ? st.panes[tab.activePaneId] : null;
    if (!pane) return;
    void spawn(
      pane.hostId != null
        ? { hostId: pane.hostId, title: pane.title }
        : { hostId: null, title: "Local shell" },
    );
  }, [spawn]);

  // Reconnect (host) or restart (local shell) a dropped pane. Its terminal and
  // handlers survive in the pool, so this only re-binds a session.
  const reconnectPane = useCallback(
    (paneId: string) => {
      const pane = useSessions.getState().panes[paneId];
      if (!pane) return;
      if (pane.hostId != null) {
        void runConnect(paneId, pane.hostId);
      } else {
        void controller.connectLocal({
          paneId,
          onEvent: (ev) => {
            if (ev.event === "warning") setNotice(ev.message);
          },
        });
      }
    },
    [runConnect],
  );

  // The tab-strip × closes a whole tab: tear down every pane it holds.
  const onCloseTab = useCallback(
    (id: string) => {
      const tab = useSessions.getState().tabs[id];
      if (tab) for (const pid of collectPaneIds(tab.root)) void controller.destroy(pid);
      closeTab(id);
    },
    [closeTab],
  );

  // Send an expanded snippet to the focused pane, through the same
  // broadcast-aware path as typing — so a broadcasting tab fans it out too.
  // The trailing newline is what makes "run" actually run.
  const sendSnippet = useCallback(
    (text: string) => {
      const st = useSessions.getState();
      const tab = st.activeId ? st.tabs[st.activeId] : null;
      if (!tab) return;
      writeData(tab.activePaneId, tab.id, text.endsWith("\n") ? text : `${text}\n`);
    },
    [writeData],
  );

  const runSnippet = useCallback(
    (id: number) => {
      const snippet = snippets.find((s) => s.id === id);
      if (!snippet) return;
      const st = useSessions.getState();
      const tab = st.activeId ? st.tabs[st.activeId] : null;
      if (!tab) {
        setNotice("Open a session before running a snippet.");
        return;
      }
      // Nothing to fill in: send it straight through. Anything with a
      // placeholder goes via the dialog, which is also where the expanded
      // command is shown before it reaches a live shell.
      if (variablesIn(snippet.body).length === 0) {
        sendSnippet(snippet.body);
        return;
      }
      setRunningSnippet(snippet);
    },
    [snippets, sendSnippet],
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

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const { id, name } = deleting;
    try {
      await deleteHost(id);
      setNotice(`Deleted ${name}.`);
    } catch (err) {
      setNotice(`could not delete host: ${String(err)}`);
    }
    setDeleting(null);
    void refresh(query);
  }, [deleting, query, refresh]);

  // Test a host's (possibly unsaved) config from the form. Host-key prompts ride
  // the same FirstContactDialog a real connect uses: the events channel routes
  // them to `setPrompt`, and the decision goes back via `approve_host_key`.
  const runTest = useCallback(
    (req: TestConnectionReq): Promise<TestConnectionResult> =>
      new Promise((resolve) => {
        const events = new Channel<SessionEvent>();
        events.onmessage = (ev) => {
          if (ev.event !== "host_key_prompt") return;
          void new Promise<boolean>((decide) => {
            decideRef.current = decide;
            setPrompt(ev);
          })
            .then((accept) => invoke("approve_host_key", { id: ev.session_id, accept }))
            .catch(() => {});
        };
        testConnection(req, events)
          .then(() => resolve({ ok: true }))
          .catch((e) => resolve({ ok: false, message: String(e) }));
      }),
    [],
  );

  // Flow stats are read straight off the session object, never through the
  // store — that object mutates on every frame and would re-render at 100 Hz.
  useEffect(() => {
    const timer = setInterval(() => {
      const st = useSessions.getState();
      const tab = st.activeId ? st.tabs[st.activeId] : null;
      const id = tab?.activePaneId ?? null;
      const flow = id ? controller.flowOf(id) : null;
      if (!flow) {
        setFlowLine("");
        return;
      }
      // The renderer is worth surfacing: on Linux a WebKitGTK build without a
      // usable GL context silently falls back to the DOM renderer, and "which
      // renderer am I on?" is otherwise a devtools question.
      const renderer = id ? (pool.get(id)?.renderer ?? "") : "";
      setFlowLine(
        `${renderer ? `${renderer} · ` : ""}${(flow.recvBytes / 1048576).toFixed(1)} MB · ${
          flow.pauseCount
        } pauses${flow.paused ? " · paused (flow control)" : ""}`,
      );
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Every command's side effects funnel through this context, so the registry
  // and keymap stay pure. Rebuilt each render and mirrored into the ref the
  // window keydown handler reads, so dispatch always sees the latest closures.
  const cmdCtx: CommandContext = {
    openHost,
    openLocalShell,
    duplicateActivePane,
    connectHostPrompt: () => {
      splitDirRef.current = null;
      setPalette(true);
    },
    focusSearch: () => {
      if (useSessions.getState().activeId) setSearching(true);
    },
    togglePalette: () => {
      splitDirRef.current = null;
      setPalette((open) => !open);
    },
    closeActivePane: () => {
      const st = useSessions.getState();
      const tab = st.activeId ? st.tabs[st.activeId] : null;
      if (!tab) return;
      void controller.destroy(tab.activePaneId);
      st.closePane(tab.id, tab.activePaneId);
    },
    selectRelativeTab: (delta) => {
      const { order: ids, activeId: current } = useSessions.getState();
      const next = relativeTab(ids, current, delta);
      if (next) useSessions.getState().setActive(next);
    },
    selectTabByIndex: (oneBased) => {
      const id = tabAtIndex(useSessions.getState().order, oneBased);
      if (id) useSessions.getState().setActive(id);
    },
    selectTab: (id) => useSessions.getState().setActive(id),
    renameActiveTab: () => {
      const id = useSessions.getState().activeId;
      if (id) setRenaming(id);
    },
    splitActive: (dir) => {
      if (useSessions.getState().activeId == null) return;
      splitDirRef.current = dir;
      setPalette(true);
    },
    focusNextPane: () => {
      const st = useSessions.getState();
      const tab = st.activeId ? st.tabs[st.activeId] : null;
      if (!tab) return;
      const next = neighbourPane(tab.root, tab.activePaneId);
      if (next) st.setActivePane(tab.id, next);
    },
    toggleBroadcast: () => {
      const id = useSessions.getState().activeId;
      if (id) useSessions.getState().toggleBroadcast(id);
    },
    runSnippet,
    manageSnippets: () => setSnippetsOpen(true),
  };
  cmdCtxRef.current = cmdCtx;

  const activeTab = activeId ? tabs[activeId] : null;
  const activePane = activeTab ? (panes[activeTab.activePaneId] ?? null) : null;
  // The focused pane's host record, so a snippet's {{host}}/{{user}}/{{port}}
  // need no typing. Null for a local shell, which has no host.
  const activeHost =
    activePane?.hostId != null
      ? (hosts.find((h) => h.id === activePane.hostId) ?? null)
      : null;

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
            onEditHost={setEditing}
            onDeleteHost={setDeleting}
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
              <div className="flex gap-2 border-t border-[var(--lilt-border)] p-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setImporting(true)}
                >
                  Import ssh_config
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowAppearance(true)}
                >
                  Appearance
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
              <SessionTabs
                onClose={onCloseTab}
                onNewLocalShell={() => void openLocalShell()}
                onConnectHost={() => setPalette(true)}
                renaming={renaming}
                onRename={(id, title) => {
                  const next = title.trim();
                  if (next) {
                    const st = useSessions.getState();
                    const tab = st.tabs[id];
                    if (tab) st.renamePane(tab.activePaneId, next);
                  }
                  setRenaming(null);
                }}
                onRenameStart={setRenaming}
                onRenameCancel={() => setRenaming(null)}
              />
            )}

            <main className="relative min-h-0 flex-1">
              {order.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <p className="text-sm text-[var(--lilt-text-subtle)]">
                    Select a host to open a session.
                  </p>
                  <Button size="sm" variant="secondary" onClick={openLocalShell}>
                    New local shell
                  </Button>
                </div>
              ) : (
                <>
                  {activeTab?.broadcast && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-[var(--lilt-warning-soft,var(--lilt-surface-2))] px-3 py-1 text-xs font-medium text-[var(--lilt-warning-text,var(--lilt-text))]">
                      ⇉ Broadcasting input to every pane in this tab
                    </div>
                  )}
                  {activePane && searching && (
                    <TerminalSearch
                      key={activePane.id}
                      paneId={activePane.id}
                      onClose={() => setSearching(false)}
                    />
                  )}
                  <TerminalMount onReconnectPane={reconnectPane} />
                </>
              )}
            </main>

            <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--lilt-border)] px-3 text-[11px] text-[var(--lilt-text-subtle)]">
              {activePane && <StatusPill pane={activePane} />}
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
          onTest={runTest}
          onSaved={() => {
            setAdding(false);
            void refresh(query);
          }}
        />
      )}
      {editing && (
        <HostNewDialog
          key={editing.id}
          editing={editing}
          onTest={runTest}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
      <CommandPalette
        open={palette}
        onOpenChange={(open) => {
          setPalette(open);
          if (!open) splitDirRef.current = null;
        }}
        hosts={hosts}
        snippets={snippets}
        ctx={cmdCtx}
      />
      {snippetsOpen && (
        <SnippetsDialog
          onClose={() => setSnippetsOpen(false)}
          onChanged={() => void refreshSnippets()}
        />
      )}
      {runningSnippet && (
        <SnippetRunDialog
          snippet={runningSnippet}
          context={hostContext(activeHost)}
          broadcasting={activeTab?.broadcast ?? false}
          onCancel={() => setRunningSnippet(null)}
          onRun={(text) => {
            sendSnippet(text);
            setRunningSnippet(null);
          }}
        />
      )}
      {showAppearance && (
        <AppearanceDialog
          value={appearance}
          onChange={changeAppearance}
          onClose={() => setShowAppearance(false)}
        />
      )}
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
            controller.write(pastePending.paneId, pastePending.text);
            setPastePending(null);
          }}
        />
      )}
      {deleting && (
        <AlertDialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleting.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes{" "}
                <span className="font-medium text-[var(--lilt-text)]">
                  {deleting.name}
                </span>{" "}
                ({deleting.username ? `${deleting.username}@` : ""}
                {deleting.hostname}) and any saved credential from this machine. Open
                sessions stay connected. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void confirmDelete()}>
                Delete host
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
