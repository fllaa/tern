// Session tab strip.
//
// Not Lilt's Tabs: that component owns panel mounting, and our panels are the
// pooled terminals, which must not be mounted or unmounted by anything except
// the pool. So the strip is bespoke and the terminals stay where they are.
//
// A tab's dot and label come from its *focused pane* — a tab is a layout of
// panes, and the active one is what the strip surfaces.

import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

import { type ConnState, type Pane, useSessions } from "../store/sessions";

/** Colour and label for each connection state, in one place. */
const STATE: Record<ConnState, { dot: string; label: string }> = {
  idle: { dot: "bg-[var(--lilt-text-subtle)]", label: "not connected" },
  connecting: { dot: "bg-[var(--lilt-warning)]", label: "connecting" },
  connected: { dot: "bg-[var(--lilt-primary)]", label: "connected" },
  reconnecting: { dot: "bg-[var(--lilt-warning)]", label: "reconnecting" },
  disconnected: { dot: "bg-[var(--lilt-text-subtle)]", label: "disconnected" },
  error: { dot: "bg-[var(--lilt-danger)]", label: "error" },
};

function TabButton({
  pane,
  active,
  broadcast,
  renaming,
  onSelect,
  onClose,
  onRename,
  onRenameStart,
  onRenameCancel,
}: {
  pane: Pane;
  active: boolean;
  broadcast: boolean;
  renaming: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
}) {
  const state = STATE[pane.conn];
  const busy = pane.conn === "connecting" || pane.conn === "reconnecting";
  // Enter and Escape both unmount the input, which fires onBlur; this flag stops
  // that blur from committing a second time (Enter) or reviving a cancel (Escape).
  const settled = useRef(false);

  return (
    <div
      className={`group flex min-w-0 shrink-0 items-center gap-2 border-r border-[var(--lilt-border)] px-3 py-1.5 text-xs ${
        active
          ? "bg-[var(--lilt-surface)] text-[var(--lilt-text)]"
          : "text-[var(--lilt-text-muted)] hover:bg-[var(--lilt-surface-2)]"
      }`}
    >
      {renaming ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: focusing the field IS the rename action
          autoFocus
          aria-label="Rename tab"
          className="min-w-0 flex-1 rounded-[var(--radius-control-sm)] border border-[var(--lilt-focus)] bg-[var(--lilt-field)] px-1.5 py-0.5 text-xs text-[var(--lilt-text)] outline-none"
          defaultValue={pane.title}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            if (settled.current) {
              settled.current = false;
              return;
            }
            onRename(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            // Keep app chords (they bubble to the window) off the edit session.
            e.stopPropagation();
            if (e.key === "Enter") {
              settled.current = true;
              onRename(e.currentTarget.value);
            } else if (e.key === "Escape") {
              settled.current = true;
              onRenameCancel();
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="flex min-w-0 items-center gap-2"
            onClick={onSelect}
            onDoubleClick={onRenameStart}
            title={pane.detail ? `${state.label} — ${pane.detail}` : state.label}
          >
            {busy ? (
              <Spinner label={null} size={10} />
            ) : (
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${state.dot}`}
              />
            )}
            <span className="max-w-40 truncate">{pane.title}</span>
            {broadcast && (
              <span
                title="Broadcasting input to all panes"
                className="shrink-0 font-semibold text-[var(--lilt-warning-text,var(--lilt-primary-text))]"
              >
                ⇉
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={`Close ${pane.title}`}
            className="shrink-0 rounded px-1 text-[var(--lilt-text-subtle)] opacity-0 transition-opacity hover:text-[var(--lilt-danger)] group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onClose}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

export function SessionTabs({
  onClose,
  onNewLocalShell,
  onConnectHost,
  renaming,
  onRename,
  onRenameStart,
  onRenameCancel,
}: {
  onClose: (id: string) => void;
  onNewLocalShell: () => void;
  onConnectHost: () => void;
  renaming: string | null;
  onRename: (id: string, title: string) => void;
  onRenameStart: (id: string) => void;
  onRenameCancel: () => void;
}) {
  const order = useSessions((s) => s.order);
  const tabs = useSessions((s) => s.tabs);
  const panes = useSessions((s) => s.panes);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--lilt-border)] bg-[var(--lilt-surface-2)]">
      {order.map((id) => {
        const tab = tabs[id];
        const pane = tab ? panes[tab.activePaneId] : null;
        if (!tab || !pane) return null;
        return (
          <TabButton
            key={id}
            pane={pane}
            active={id === activeId}
            broadcast={tab.broadcast}
            renaming={id === renaming}
            onSelect={() => setActive(id)}
            onClose={() => onClose(id)}
            onRename={(title) => onRename(id, title)}
            onRenameStart={() => onRenameStart(id)}
            onRenameCancel={onRenameCancel}
          />
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="New session"
          className="shrink-0 px-3 text-[var(--lilt-text-subtle)] hover:bg-[var(--lilt-surface)] hover:text-[var(--lilt-text)]"
        >
          +
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewLocalShell}>New local shell</DropdownMenuItem>
          <DropdownMenuItem onClick={onConnectHost}>Connect to host…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
