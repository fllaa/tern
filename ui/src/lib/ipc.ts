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
  | { kind: "local_pty"; program: string | null; args?: string[] };

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
  | { event: "connected" }
  | { event: "disconnected"; reason: string }
  | { event: "exited"; code: number | null }
  | { event: "error"; message: string };

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
  ): Promise<TermSession> {
    const session = new TermSession(term);
    session.onEvent = onEvent ?? null;

    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buf) => session.ingest(buf);

    const events = new Channel<SessionEvent>();
    events.onmessage = (ev) => {
      // Default TOFU handling: surface a confirm dialog. Bench/auto flows use
      // insecure_accept_host_key and never hit this.
      if (ev.event === "host_key_prompt") {
        const ok = window.confirm(
          `Host key for ${ev.host}:${ev.port}\n${ev.algorithm}\n${ev.fingerprint_sha256}\n\nTrust this key?`,
        );
        void invoke("approve_host_key", { id: session.id, accept: ok });
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
        if (this.id) void invoke("resume_session", { id: this.id });
      }
    });

    if (!flow.paused && flow.pendingBytes > HIGH_WATERMARK) {
      flow.paused = true;
      flow.pauseCount += 1;
      if (this.id) void invoke("pause_session", { id: this.id });
    }
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
