// Connection-state surface: a footer pill and a terminal overlay.
//
// Both read the tab's `conn` state and, while reconnecting, its `reconnect`
// progress. The overlay exists so a dropped session shows *something* — a
// frozen black terminal with no explanation is the worst version of "survive
// the day".

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import type { ConnState, Tab } from "../store/sessions";

/** A short label and a colour token for each connection state. */
function describe(conn: ConnState): { label: string; color: string } {
  switch (conn) {
    case "connected":
      return { label: "connected", color: "var(--lilt-primary-text)" };
    case "connecting":
      return { label: "connecting", color: "var(--lilt-text-subtle)" };
    case "reconnecting":
      return {
        label: "reconnecting",
        color: "var(--lilt-warning-text, var(--lilt-text))",
      };
    case "disconnected":
      return { label: "disconnected", color: "var(--lilt-danger-text)" };
    case "error":
      return { label: "error", color: "var(--lilt-danger-text)" };
    default:
      return { label: "idle", color: "var(--lilt-text-subtle)" };
  }
}

/** Seconds remaining until `dueAt`, ticking once a second. Never negative. */
function useCountdown(dueAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (dueAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [dueAt]);
  if (dueAt == null) return null;
  return Math.max(0, Math.ceil((dueAt - now) / 1000));
}

/** "attempt 2/10, retrying in 3s" — the max is dropped when unlimited (0). */
function reconnectText(tab: Tab, secondsLeft: number | null): string {
  const r = tab.reconnect;
  if (!r) return "";
  const of = r.max > 0 ? `/${r.max}` : "";
  const when =
    secondsLeft && secondsLeft > 0 ? `, retrying in ${secondsLeft}s` : ", retrying…";
  return `attempt ${r.attempt}${of}${when}`;
}

/** Compact status pill for the footer. */
export function StatusPill({ tab }: { tab: Tab }) {
  const { label, color } = describe(tab.conn);
  const secondsLeft = useCountdown(tab.reconnect?.dueAt);
  const detail =
    tab.conn === "reconnecting"
      ? reconnectText(tab, secondsLeft)
      : (tab.detail ?? (tab.exitCode != null ? `exit ${tab.exitCode}` : ""));

  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span>{tab.title}</span>
      <span style={{ color }}>· {label}</span>
      {detail && <span className="text-[var(--lilt-text-subtle)]">— {detail}</span>}
    </span>
  );
}

/**
 * Overlay shown over the terminal while a session is down.
 *
 * Only for `reconnecting` and `disconnected` — a connected or connecting
 * session shows nothing. `onReconnect` re-drives the same tab; it is offered
 * only once the supervisor has given up, since during `reconnecting` the retry
 * is already in flight.
 */
export function SessionOverlay({
  tab,
  onReconnect,
}: {
  tab: Tab;
  onReconnect: () => void;
}) {
  const secondsLeft = useCountdown(tab.reconnect?.dueAt);
  if (tab.conn !== "reconnecting" && tab.conn !== "disconnected") return null;

  return (
    <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-[var(--lilt-border)] bg-[var(--lilt-surface-2)] px-4 py-2 text-xs">
      {tab.conn === "reconnecting" ? (
        <>
          <Spinner size={14} />
          <span className="text-[var(--lilt-text)]">
            Connection lost — {reconnectText(tab, secondsLeft)}
          </span>
        </>
      ) : (
        <>
          <span className="text-[var(--lilt-danger-text)]">
            Disconnected{tab.detail ? ` — ${tab.detail}` : ""}
          </span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onReconnect}>
            Reconnect
          </Button>
        </>
      )}
    </div>
  );
}
