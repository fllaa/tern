// Flow control is the single highest-value thing to test in this app.
//
// The whole Phase 0 architecture bet rests on it: pause the Rust producer when
// xterm falls behind, resume when it catches up, and never drop a byte. It is
// also invisible — a broken watermark does not throw, it just quietly buffers
// until the app dies under `cat` on a large file. These tests are the tripwire.

import { beforeEach, describe, expect, it } from "vitest";
import {
  type Channel,
  callsTo,
  invokeCalls,
  invokeHandlers,
  resetTauriMock,
} from "../test/tauri-mock";
import { type OpenSessionReq, TermSession } from "./ipc";

const HIGH = 384 * 1024;
const LOW = 64 * 1024;

/**
 * Minimal stand-in for xterm's Terminal.
 *
 * The only behaviour that matters is that `write` takes a completion callback
 * and may defer it — that deferral *is* backpressure, and holding the
 * callbacks is how a test simulates a terminal falling behind.
 */
class FakeTerminal {
  readonly pending: Array<() => void> = [];
  written = 0;

  write(data: Uint8Array, cb?: () => void): void {
    this.written += data.length;
    if (cb) this.pending.push(cb);
  }

  /** Let the terminal finish parsing `n` chunks (all of them by default). */
  drain(n = Number.POSITIVE_INFINITY): void {
    const count = Math.min(n, this.pending.length);
    for (let i = 0; i < count; i++) this.pending.shift()?.();
  }
}

const req: OpenSessionReq = {
  target: { kind: "saved_host", host_id: 1 },
  cols: 80,
  rows: 24,
};

/** Open a session whose data channel the test can push frames into. */
async function openSession() {
  const term = new FakeTerminal();
  const channels: Array<Channel<ArrayBuffer>> = [];

  invokeHandlers.set("open_session", (args) => {
    const { data } = args as { data: Channel<ArrayBuffer> };
    channels.push(data);
    return "s-1";
  });

  const session = await TermSession.open(
    term as unknown as import("@xterm/xterm").Terminal,
    req,
  );
  return { session, term, data: channels[0] };
}

function frame(bytes: number, fill = 0x61): ArrayBuffer {
  return new Uint8Array(bytes).fill(fill).buffer;
}

beforeEach(() => {
  resetTauriMock();
});

describe("flow control", () => {
  it("does not pause while the terminal keeps up", async () => {
    const { term, data } = await openSession();
    for (let i = 0; i < 20; i++) {
      data.emit(frame(64 * 1024));
      term.drain();
    }
    expect(callsTo("pause_session")).toBe(0);
  });

  it("pauses once when pending bytes cross the high watermark", async () => {
    const { data } = await openSession();
    // Withhold every write callback so pending only grows.
    data.emit(frame(HIGH - 1024));
    expect(callsTo("pause_session")).toBe(0);

    data.emit(frame(8 * 1024));
    expect(callsTo("pause_session")).toBe(1);

    // Still above the mark: must not pause again.
    data.emit(frame(8 * 1024));
    expect(callsTo("pause_session")).toBe(1);
  });

  it("resumes once when pending falls below the low watermark", async () => {
    const { term, data } = await openSession();
    data.emit(frame(HIGH + 1024));
    expect(callsTo("pause_session")).toBe(1);
    expect(callsTo("resume_session")).toBe(0);

    term.drain();
    expect(callsTo("resume_session")).toBe(1);
  });

  it("does not storm pause/resume while oscillating between the marks", async () => {
    const { session, term, data } = await openSession();
    const KB = 1024;

    // Many small frames, so draining some of them is a genuinely partial
    // parse — with one big frame, draining at all empties the buffer.
    for (let i = 0; i < 400; i++) data.emit(frame(KB));
    expect(callsTo("pause_session")).toBe(1);

    // Ride the dead zone between the two marks: parse 100 KB, receive 100 KB.
    // Pending never approaches LOW, so a correct implementation stays paused
    // and says nothing. A single-threshold one would thrash here.
    for (let round = 0; round < 5; round++) {
      term.drain(100);
      expect(session.flow.pendingBytes).toBeGreaterThan(LOW);
      for (let i = 0; i < 100; i++) data.emit(frame(KB));
    }
    expect(callsTo("pause_session")).toBe(1);
    expect(callsTo("resume_session")).toBe(0);

    // And once it genuinely catches up, exactly one resume.
    term.drain();
    expect(callsTo("resume_session")).toBe(1);
  });

  it("counts every byte and newline it receives", async () => {
    // Losslessness is the property the whole benchmark suite asserts by
    // comparing this tally against Rust's independent count.
    const { session, term, data } = await openSession();
    const withNewlines = new Uint8Array(1000);
    withNewlines.fill(0x61);
    for (let i = 9; i < 1000; i += 10) withNewlines[i] = 0x0a;

    data.emit(withNewlines.buffer);
    term.drain();

    expect(session.flow.recvBytes).toBe(1000);
    expect(session.flow.recvFrames).toBe(1);
    expect(session.flow.jsNewlines).toBe(100);
    expect(session.flow.parsedBytes).toBe(1000);
  });

  it("remembers the high-water mark after pending drains away", async () => {
    const { session, term, data } = await openSession();
    data.emit(frame(200 * 1024));
    data.emit(frame(200 * 1024));
    expect(session.flow.pendingBytes).toBe(400 * 1024);

    term.drain();
    expect(session.flow.pendingBytes).toBe(0);
    // The peak is what the benchmark reports; it must survive the drain.
    expect(session.flow.maxPending).toBe(400 * 1024);
  });

  it("resetFlowState clears live state, resetJsStats preserves it", async () => {
    // The distinction matters at reconnect: pendingBytes/paused describe work
    // in flight, which is exactly what does not survive a new transport.
    const { session, data } = await openSession();
    data.emit(frame(HIGH + 1024));
    expect(session.flow.paused).toBe(true);

    session.resetJsStats();
    expect(session.flow.paused).toBe(true);
    expect(session.flow.pendingBytes).toBeGreaterThan(0);

    session.resetFlowState();
    expect(session.flow.paused).toBe(false);
    expect(session.flow.pendingBytes).toBe(0);
  });
});

describe("host key decisions", () => {
  it("refuses an unknown key when no decision callback is wired up", async () => {
    // A client with no UI must not trust an unverified key by default.
    const term = new FakeTerminal();
    const channels: Array<Channel<unknown>> = [];
    invokeHandlers.set("open_session", (args) => {
      const { events } = args as { events: Channel<unknown> };
      channels.push(events);
      return "s-1";
    });

    await TermSession.open(term as unknown as import("@xterm/xterm").Terminal, req);
    channels[0].emit({
      event: "host_key_prompt",
      host: "example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprint_sha256: "SHA256:abc",
    });

    await new Promise((r) => setTimeout(r, 0));
    const approve = invokeCalls.find((c) => c.cmd === "approve_host_key");
    expect(approve?.args).toEqual({ id: "s-1", accept: false });
  });

  it("still answers the connect when the decision callback throws", async () => {
    // Rust blocks awaiting this answer; a thrown decision must resolve to a
    // refusal rather than hanging the connect forever.
    const term = new FakeTerminal();
    const channels: Array<Channel<unknown>> = [];
    invokeHandlers.set("open_session", (args) => {
      const { events } = args as { events: Channel<unknown> };
      channels.push(events);
      return "s-1";
    });

    await TermSession.open(
      term as unknown as import("@xterm/xterm").Terminal,
      req,
      undefined,
      () => Promise.reject(new Error("dialog blew up")),
    );
    channels[0].emit({
      event: "host_key_prompt",
      host: "example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprint_sha256: "SHA256:abc",
    });

    await new Promise((r) => setTimeout(r, 0));
    const approve = invokeCalls.find((c) => c.cmd === "approve_host_key");
    expect(approve?.args).toEqual({ id: "s-1", accept: false });
  });
});
