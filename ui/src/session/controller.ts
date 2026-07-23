// Per-pane session ownership.
//
// This is the seam that lets `store/sessions.ts` stay plain serializable data:
// the `TermSession` objects, whose `flow` field mutates on every frame, live
// here in a module-level map instead of in React state.

import type { HostKeyDecision, SessionEvent, Target } from "../lib/ipc";
import { TermSession } from "../lib/ipc";
import { type PaneId, useSessions } from "../store/sessions";
import * as pool from "../terminal/pool";

const sessions = new Map<PaneId, TermSession>();
/** Panes the user closed, so a late event cannot resurrect their state. */
const closing = new Set<PaneId>();

export function sessionFor(id: PaneId): TermSession | undefined {
  return sessions.get(id);
}

export interface ConnectArgs {
  paneId: PaneId;
  hostId: number;
  onHostKey: HostKeyDecision;
  onEvent?: (ev: SessionEvent) => void;
}

/**
 * Open a session for a tab against any target, mediating the close/connect
 * race. Target-agnostic: the saved-host and local-shell entry points below
 * differ only in the `Target` they pass.
 */
async function establish(
  paneId: PaneId,
  target: Target,
  onEvent?: (ev: SessionEvent) => void,
  onHostKey?: HostKeyDecision,
): Promise<void> {
  const handle = pool.get(paneId);
  if (!handle || sessions.has(paneId)) return;

  const store = useSessions.getState();
  store.setConn(paneId, "connecting");
  closing.delete(paneId);

  try {
    const session = await TermSession.open(
      handle.term,
      { target, cols: handle.term.cols, rows: handle.term.rows },
      (ev) => {
        handleEvent(paneId, ev);
        onEvent?.(ev);
      },
      onHostKey,
    );

    // The user may have closed the tab while the connect was in flight.
    if (closing.has(paneId)) {
      void session.close().catch(() => {});
      return;
    }

    sessions.set(paneId, session);
    useSessions.getState().setRustSessionId(paneId, session.id);
    useSessions.getState().setConn(paneId, "connected");
  } catch (err) {
    useSessions.getState().setConn(paneId, "error", String(err));
  }
}

/** Connect a tab to a stored host. */
export function connect({
  paneId,
  hostId,
  onHostKey,
  onEvent,
}: ConnectArgs): Promise<void> {
  // No credential crosses the boundary — Rust resolves the stored host's
  // secret from the OS keyring itself.
  return establish(paneId, { kind: "saved_host", host_id: hostId }, onEvent, onHostKey);
}

export interface ConnectLocalArgs {
  paneId: PaneId;
  /** Explicit program to run; null runs the platform's default login shell. */
  program?: string | null;
  args?: string[];
  onEvent?: (ev: SessionEvent) => void;
}

/**
 * Connect a tab to a local shell.
 *
 * No host-key callback is threaded through: a local PTY never presents a host
 * key, so `TermSession.open` never reaches for one.
 */
export function connectLocal({
  paneId,
  program = null,
  args,
  onEvent,
}: ConnectLocalArgs): Promise<void> {
  return establish(paneId, { kind: "local_pty", program, args }, onEvent);
}

function handleEvent(paneId: PaneId, ev: SessionEvent): void {
  const store = useSessions.getState();
  switch (ev.event) {
    case "connected":
      // Either the initial connect's own event or a successful reconnect. The
      // session id is unchanged; just clear any reconnecting state.
      store.setConn(paneId, "connected");
      break;
    case "reconnecting":
      // The transport dropped and the supervisor is retrying on the *same*
      // session id, so the session stays put. Reset the now-stale flow state
      // before the new generation's bytes arrive — carrying a pause or a
      // pending-byte count across would throttle a producer that no longer
      // exists. This is what makes flow state session-scoped per generation.
      sessions.get(paneId)?.resetFlowState();
      sessions.get(paneId)?.resetJsStats();
      store.setReconnecting(paneId, {
        attempt: ev.attempt,
        max: ev.max_attempts,
        dueAt: Date.now() + ev.delay_ms,
      });
      break;
    case "exited":
      sessions.delete(paneId);
      store.setExit(paneId, ev.code);
      break;
    case "disconnected":
      // Distinct from `exited`: the transport died rather than the shell
      // ending. Reached only when the supervisor has *given up* reconnecting —
      // an in-progress reconnect is `reconnecting`, not this.
      sessions.delete(paneId);
      store.setConn(paneId, "disconnected", ev.reason);
      store.setRustSessionId(paneId, null);
      break;
    case "error":
      store.setConn(paneId, "error", ev.message);
      break;
    case "host_key_changed":
      store.setConn(paneId, "error", `host key changed for ${ev.host}:${ev.port}`);
      break;
    case "host_key_revoked":
      store.setConn(paneId, "error", `host key revoked for ${ev.host}:${ev.port}`);
      break;
    default:
      // `warning` deliberately lands here: it is non-fatal and must not touch
      // the connection state. The caller's onEvent surfaces it.
      break;
  }
}

export function write(paneId: PaneId, data: string): void {
  void sessions
    .get(paneId)
    ?.writeText(data)
    .catch(() => {});
}

export function resize(paneId: PaneId, cols: number, rows: number): void {
  void sessions
    .get(paneId)
    ?.resize(cols, rows)
    .catch(() => {});
}

/** Close a tab's session and drop its terminal. */
export async function disconnect(paneId: PaneId): Promise<void> {
  // Set before awaiting: a connect racing this must see the intent and not
  // register a session nobody will ever close.
  closing.add(paneId);
  const session = sessions.get(paneId);
  sessions.delete(paneId);
  if (session) await session.close().catch(() => {});
  useSessions.getState().setRustSessionId(paneId, null);
}

/** Full teardown for a tab the user closed. */
export async function destroy(paneId: PaneId): Promise<void> {
  await disconnect(paneId);
  pool.release(paneId);
  closing.delete(paneId);
}

/** Live flow stats for the status bar. Read directly, never through the store —
 *  this object mutates on every frame. */
export function flowOf(paneId: PaneId) {
  return sessions.get(paneId)?.flow ?? null;
}
