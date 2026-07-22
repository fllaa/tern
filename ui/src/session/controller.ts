// Per-tab session ownership.
//
// This is the seam that lets `store/sessions.ts` stay plain serializable data:
// the `TermSession` objects, whose `flow` field mutates on every frame, live
// here in a module-level map instead of in React state.

import type { HostKeyDecision, SessionEvent } from "../lib/ipc";
import { TermSession } from "../lib/ipc";
import { type TabId, useSessions } from "../store/sessions";
import * as pool from "../terminal/pool";

const sessions = new Map<TabId, TermSession>();
/** Tabs the user closed, so a late event cannot resurrect their state. */
const closing = new Set<TabId>();

export function sessionFor(id: TabId): TermSession | undefined {
  return sessions.get(id);
}

export interface ConnectArgs {
  tabId: TabId;
  hostId: number;
  onHostKey: HostKeyDecision;
  onEvent?: (ev: SessionEvent) => void;
}

/** Connect a tab to a stored host. */
export async function connect({
  tabId,
  hostId,
  onHostKey,
  onEvent,
}: ConnectArgs): Promise<void> {
  const handle = pool.get(tabId);
  if (!handle || sessions.has(tabId)) return;

  const store = useSessions.getState();
  store.setConn(tabId, "connecting");
  closing.delete(tabId);

  try {
    const session = await TermSession.open(
      handle.term,
      {
        // No credential crosses the boundary — Rust resolves the stored
        // host's secret from the OS keyring itself.
        target: { kind: "saved_host", host_id: hostId },
        cols: handle.term.cols,
        rows: handle.term.rows,
      },
      (ev) => {
        handleEvent(tabId, ev);
        onEvent?.(ev);
      },
      onHostKey,
    );

    // The user may have closed the tab while the connect was in flight.
    if (closing.has(tabId)) {
      void session.close().catch(() => {});
      return;
    }

    sessions.set(tabId, session);
    useSessions.getState().setRustSessionId(tabId, session.id);
    useSessions.getState().setConn(tabId, "connected");
  } catch (err) {
    useSessions.getState().setConn(tabId, "error", String(err));
  }
}

function handleEvent(tabId: TabId, ev: SessionEvent): void {
  const store = useSessions.getState();
  switch (ev.event) {
    case "connected":
      // Either the initial connect's own event or a successful reconnect. The
      // session id is unchanged; just clear any reconnecting state.
      store.setConn(tabId, "connected");
      break;
    case "reconnecting":
      // The transport dropped and the supervisor is retrying on the *same*
      // session id, so the session stays put. Reset the now-stale flow state
      // before the new generation's bytes arrive — carrying a pause or a
      // pending-byte count across would throttle a producer that no longer
      // exists. This is what makes flow state session-scoped per generation.
      sessions.get(tabId)?.resetFlowState();
      sessions.get(tabId)?.resetJsStats();
      store.setReconnecting(tabId, {
        attempt: ev.attempt,
        max: ev.max_attempts,
        dueAt: Date.now() + ev.delay_ms,
      });
      break;
    case "exited":
      sessions.delete(tabId);
      store.setExit(tabId, ev.code);
      break;
    case "disconnected":
      // Distinct from `exited`: the transport died rather than the shell
      // ending. Reached only when the supervisor has *given up* reconnecting —
      // an in-progress reconnect is `reconnecting`, not this.
      sessions.delete(tabId);
      store.setConn(tabId, "disconnected", ev.reason);
      store.setRustSessionId(tabId, null);
      break;
    case "error":
      store.setConn(tabId, "error", ev.message);
      break;
    case "host_key_changed":
      store.setConn(tabId, "error", `host key changed for ${ev.host}:${ev.port}`);
      break;
    case "host_key_revoked":
      store.setConn(tabId, "error", `host key revoked for ${ev.host}:${ev.port}`);
      break;
    default:
      // `warning` deliberately lands here: it is non-fatal and must not touch
      // the connection state. The caller's onEvent surfaces it.
      break;
  }
}

export function write(tabId: TabId, data: string): void {
  void sessions
    .get(tabId)
    ?.writeText(data)
    .catch(() => {});
}

export function resize(tabId: TabId, cols: number, rows: number): void {
  void sessions
    .get(tabId)
    ?.resize(cols, rows)
    .catch(() => {});
}

/** Close a tab's session and drop its terminal. */
export async function disconnect(tabId: TabId): Promise<void> {
  // Set before awaiting: a connect racing this must see the intent and not
  // register a session nobody will ever close.
  closing.add(tabId);
  const session = sessions.get(tabId);
  sessions.delete(tabId);
  if (session) await session.close().catch(() => {});
  useSessions.getState().setRustSessionId(tabId, null);
}

/** Full teardown for a tab the user closed. */
export async function destroy(tabId: TabId): Promise<void> {
  await disconnect(tabId);
  pool.release(tabId);
  closing.delete(tabId);
}

/** Live flow stats for the status bar. Read directly, never through the store —
 *  this object mutates on every frame. */
export function flowOf(tabId: TabId) {
  return sessions.get(tabId)?.flow ?? null;
}
