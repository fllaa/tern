// Typed mirror of crates/proto + the client side of the terminal data path.
//
// Terminal bytes arrive as raw ArrayBuffers on a Tauri Channel — never JSON.
// Flow control follows the xterm.js idiom: count pending (unparsed) bytes,
// pause the Rust producer above HIGH, resume below LOW once parsing catches up.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

export type AuthMethodDto =
  | { method: "password"; password: string }
  | { method: "key_file"; path: string; passphrase: string | null }
  | { method: "agent" };

export type Target =
  | {
      kind: "ssh";
      host: string;
      port: number;
      username: string;
      auth: AuthMethodDto;
      insecure_accept_host_key?: boolean;
    }
  | { kind: "local_pty"; program: string | null; args?: string[] }
  // The product path. No credential crosses the boundary — Rust resolves the
  // stored host's secret from the OS keyring itself.
  | { kind: "saved_host"; host_id: number };

export interface OpenSessionReq {
  target: Target;
  cols: number;
  rows: number;
  chunk_max?: number;
  tick_ms?: number;
  window_size?: number;
}

export type SessionEvent =
  | {
      event: "host_key_prompt";
      host: string;
      port: number;
      algorithm: string;
      fingerprint_sha256: string;
    }
  // Refused already — the connect has failed by the time this arrives. Must
  // never render as the same "continue?" dialog as host_key_prompt.
  | {
      event: "host_key_changed";
      host: string;
      port: number;
      algorithm: string;
      recorded_fingerprint: string;
      presented_fingerprint: string;
      known_hosts_path: string;
      known_hosts_line: number;
    }
  | {
      event: "host_key_revoked";
      host: string;
      port: number;
      known_hosts_path: string;
      known_hosts_line: number;
    }
  | { event: "connected" }
  // Transport died. Distinct from "exited", which is a shell ending normally.
  | { event: "disconnected"; reason: string }
  | { event: "exited"; code: number | null }
  | { event: "error"; message: string }
  // Non-fatal. Emitted when the connection went ahead but something the user
  // should know about did not go to plan — a saved credential that could not
  // be read, for instance. Never terminal; "error" is the terminal one.
  | { event: "warning"; message: string };

/** Decide whether to trust a first-contact host key. */
export type HostKeyPrompt = Extract<SessionEvent, { event: "host_key_prompt" }>;
export type HostKeyDecision = (ev: HostKeyPrompt) => Promise<boolean>;

export interface StreamStatsDto {
  bytes_in: number;
  newlines_in: number;
  frames_out: number;
  bytes_out: number;
  max_frame_bytes: number;
  pause_count: number;
  paused_ms: number;
  elapsed_ms: number;
}

export interface BenchJsStats {
  recv_bytes: number;
  recv_frames: number;
  parsed_bytes: number;
  wall_ms: number;
  max_pending_bytes: number;
  pause_count: number;
  js_newlines: number;
  echo_p50_ms?: number;
  echo_p95_ms?: number;
  echo_max_ms?: number;
  echo_samples?: number;
  max_stall_ms?: number;
}

export interface BenchReport {
  scenario: string;
  renderer: string;
  chunk_max: number;
  tick_ms: number;
  window_size: number;
  server: string;
  rust: StreamStatsDto;
  js: BenchJsStats;
}

export interface AutoBenchCfg {
  host: string;
  port: number;
  username: string;
  key_path: string;
  chunk_max: number;
  tick_ms: number;
  window_size: number;
  quick: boolean;
}

const HIGH_WATERMARK = 384 * 1024;
const LOW_WATERMARK = 64 * 1024;

export interface FlowStats {
  pendingBytes: number;
  maxPending: number;
  pauseCount: number;
  recvBytes: number;
  recvFrames: number;
  parsedBytes: number;
  jsNewlines: number;
  paused: boolean;
}

function countNewlines(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) n++;
  return n;
}

export class TermSession {
  id = "";
  readonly flow: FlowStats = {
    pendingBytes: 0,
    maxPending: 0,
    pauseCount: 0,
    recvBytes: 0,
    recvFrames: 0,
    parsedBytes: 0,
    jsNewlines: 0,
    paused: false,
  };
  /** Bench hooks: raw bytes as they arrive / parse-complete timestamps. */
  onData: ((bytes: Uint8Array, t: number) => void) | null = null;
  onParsed: ((t: number) => void) | null = null;
  onEvent: ((ev: SessionEvent) => void) | null = null;

  private constructor(private term: Terminal) {}

  static async open(
    term: Terminal,
    req: OpenSessionReq,
    onEvent?: (ev: SessionEvent) => void,
    /**
     * Called on first contact with an unknown host key.
     *
     * Omitting it **rejects** — a client with no UI wired up must refuse an
     * unverified key, not trust one. Bench and rig flows set
     * insecure_accept_host_key and never reach here.
     */
    onHostKey?: HostKeyDecision,
  ): Promise<TermSession> {
    const session = new TermSession(term);
    session.onEvent = onEvent ?? null;

    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buf) => session.ingest(buf);

    const events = new Channel<SessionEvent>();
    events.onmessage = (ev) => {
      if (ev.event === "host_key_prompt") {
        const decide = onHostKey ?? (async () => false);
        void decide(ev)
          .then((accept) => invoke("approve_host_key", { id: session.id, accept }))
          // The Rust side is blocked on this answer; a thrown decision must
          // still resolve to a refusal rather than hanging the connect.
          .catch(() => invoke("approve_host_key", { id: session.id, accept: false }))
          .catch(() => {});
      }
      session.onEvent?.(ev);
    };

    const id = await invoke<{ 0: string } | string>("open_session", {
      req,
      data,
      events,
    });
    // SessionId is a tuple struct -> serializes as a plain string.
    session.id = typeof id === "string" ? id : id[0];
    return session;
  }

  private ingest(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf);
    const flow = this.flow;
    flow.recvBytes += bytes.length;
    flow.recvFrames += 1;
    flow.jsNewlines += countNewlines(bytes);
    flow.pendingBytes += bytes.length;
    if (flow.pendingBytes > flow.maxPending) flow.maxPending = flow.pendingBytes;
    this.onData?.(bytes, performance.now());

    this.term.write(bytes, () => {
      flow.pendingBytes -= bytes.length;
      flow.parsedBytes += bytes.length;
      this.onParsed?.(performance.now());
      if (flow.paused && flow.pendingBytes < LOW_WATERMARK) {
        flow.paused = false;
        // Swallowed deliberately: a session torn down mid-flight (close, or a
        // reconnect) rejects these, and an unhandled rejection per in-flight
        // frame is noise, not signal.
        if (this.id) void invoke("resume_session", { id: this.id }).catch(() => {});
      }
    });

    if (!flow.paused && flow.pendingBytes > HIGH_WATERMARK) {
      flow.paused = true;
      flow.pauseCount += 1;
      if (this.id) void invoke("pause_session", { id: this.id }).catch(() => {});
    }
  }

  /**
   * Clear live flow state before rebinding this terminal to a new transport.
   *
   * Distinct from `resetJsStats`, which deliberately preserves `pendingBytes`
   * and `paused` because they describe work still in flight. Across a
   * reconnect there is no such work — carrying the old values over would leave
   * the client believing it had paused a producer that no longer exists.
   */
  resetFlowState(): void {
    this.flow.pendingBytes = 0;
    this.flow.paused = false;
  }

  resetJsStats(): void {
    const flow = this.flow;
    flow.maxPending = 0;
    flow.pauseCount = 0;
    flow.recvBytes = 0;
    flow.recvFrames = 0;
    flow.parsedBytes = 0;
    flow.jsNewlines = 0;
    // pendingBytes/paused are live state, not counters — leave them.
  }

  async write(data: Uint8Array): Promise<void> {
    await invoke("write_session", { id: this.id, data: Array.from(data) });
  }

  async writeText(text: string): Promise<void> {
    await this.write(new TextEncoder().encode(text));
  }

  async resize(cols: number, rows: number): Promise<void> {
    await invoke("resize_session", { req: { id: this.id, cols, rows } });
  }

  async close(): Promise<void> {
    await invoke("close_session", { id: this.id });
  }

  benchReset(): Promise<void> {
    return invoke("bench_reset", { id: this.id });
  }

  benchStats(): Promise<StreamStatsDto> {
    return invoke("bench_stats", { id: this.id });
  }
}

export function benchAuto(): Promise<AutoBenchCfg | null> {
  return invoke("bench_auto");
}

export function benchFinish(report: BenchReport): Promise<string> {
  return invoke("bench_finish", { report });
}

export function benchAutoDone(failed: boolean): Promise<void> {
  return invoke("bench_auto_done", { failed });
}
