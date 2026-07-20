// Phase 0 spike shell: connect to the rig (or any host), stream through the
// raw-Channel data path, and run the Spike 2 benchmark suite. Not product UI.

import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalView, type TerminalReady } from "./components/TerminalView";
import { useSessionStore } from "./store/session";
import { invoke } from "@tauri-apps/api/core";
import {
  TermSession,
  benchAuto,
  benchAutoDone,
  type OpenSessionReq,
} from "./lib/ipc";
import { ptySmoke, runSuite, type BenchEnv } from "./lib/bench";

interface FormState {
  host: string;
  port: number;
  username: string;
  password: string;
  keyPath: string;
  useKey: boolean;
  insecure: boolean;
  localPty: boolean;
}

const RIG: FormState = {
  host: "127.0.0.1",
  port: 2222,
  username: "tern",
  password: "tern123",
  keyPath: ".rig/ssh/id_ed25519",
  useKey: true,
  insecure: true,
  localPty: false,
};

export default function App() {
  const status = useSessionStore((s) => s.status);
  const setStatus = useSessionStore((s) => s.setStatus);
  const [form, setForm] = useState<FormState>(RIG);
  const [log, setLog] = useState<string[]>([]);
  const [flowLine, setFlowLine] = useState("");
  const readyRef = useRef<TerminalReady | null>(null);
  const sessionRef = useRef<TermSession | null>(null);
  const autoStarted = useRef(false);

  const pushLog = useCallback((line: string) => {
    // eslint-disable-next-line no-console
    console.log(`[bench] ${line}`);
    void invoke("bench_log", { line }).catch(() => {});
    setLog((prev) => [...prev.slice(-199), line]);
  }, []);

  const connect = useCallback(
    async (f: FormState, tuning?: Partial<OpenSessionReq>) => {
      const ready = readyRef.current;
      if (!ready || sessionRef.current) return null;
      setStatus("connecting");
      const { term } = ready;
      const req: OpenSessionReq = {
        target: f.localPty
          ? { kind: "local_pty", program: null }
          : {
              kind: "ssh",
              host: f.host,
              port: f.port,
              username: f.username,
              auth: f.useKey
                ? { method: "key_file", path: f.keyPath, passphrase: null }
                : { method: "password", password: f.password },
              insecure_accept_host_key: f.insecure,
            },
        cols: term.cols,
        rows: term.rows,
        ...tuning,
      };
      try {
        const session = await TermSession.open(term, req, (ev) => {
          if (ev.event === "exited") {
            setStatus("idle");
            sessionRef.current = null;
            pushLog(`session exited (code ${ev.code ?? "?"})`);
          } else if (ev.event === "error") {
            setStatus("error");
            pushLog(`error: ${ev.message}`);
          }
        });
        sessionRef.current = session;
        setStatus("connected");
        return session;
      } catch (err) {
        setStatus("error");
        pushLog(`connect failed: ${String(err)}`);
        return null;
      }
    },
    [pushLog, setStatus],
  );

  const disconnect = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) await s.close().catch(() => {});
    setStatus("idle");
  }, [setStatus]);

  const runBench = useCallback(
    async (quick: boolean) => {
      const ready = readyRef.current;
      const session = sessionRef.current;
      if (!ready || !session) {
        pushLog("connect first");
        return { failed: true };
      }
      const env: BenchEnv = {
        renderer: ready.renderer,
        chunk_max: 128 * 1024,
        tick_ms: 8,
        window_size: 512 * 1024,
        server: form.port === 2223 ? "dropbear" : "openssh",
      };
      return runSuite(session, env, quick, pushLog);
    },
    [form.port, pushLog],
  );

  // Auto-bench mode: TERN_BENCH=auto drives the whole suite headlessly.
  const onTerminalReady = useCallback(
    (ready: TerminalReady) => {
      readyRef.current = ready;
      if (autoStarted.current) return;
      autoStarted.current = true;
      void (async () => {
        const cfg = await benchAuto().catch(() => null);
        if (!cfg) return;
        pushLog(`auto-bench: ${JSON.stringify(cfg)}`);
        const ptyOk = await ptySmoke(ready.term, pushLog);
        const session = await connect(
          {
            ...RIG,
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            keyPath: cfg.key_path,
          },
          {
            chunk_max: cfg.chunk_max,
            tick_ms: cfg.tick_ms,
            window_size: cfg.window_size,
          },
        );
        if (!session) {
          await benchAutoDone(true);
          return;
        }
        const env: BenchEnv = {
          renderer: readyRef.current?.renderer ?? "unknown",
          chunk_max: cfg.chunk_max,
          tick_ms: cfg.tick_ms,
          window_size: cfg.window_size,
          server: cfg.port === 2223 ? "dropbear" : "openssh",
        };
        const result = await runSuite(session, env, cfg.quick, pushLog);
        await benchAutoDone(result.failed || !ptyOk);
      })();
    },
    [connect, pushLog],
  );

  // Live flow-stats ticker.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = sessionRef.current;
      if (!s) {
        setFlowLine("");
        return;
      }
      const f = s.flow;
      setFlowLine(
        `recv ${(f.recvBytes / 1048576).toFixed(1)}MB in ${f.recvFrames} frames · ` +
          `pending ${(f.pendingBytes / 1024).toFixed(0)}K (max ${(f.maxPending / 1024).toFixed(0)}K) · ` +
          `pauses ${f.pauseCount}${f.paused ? " [PAUSED]" : ""}`,
      );
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const onInput = useCallback((data: string) => {
    void sessionRef.current?.writeText(data);
  }, []);
  const onResize = useCallback((cols: number, rows: number) => {
    void sessionRef.current?.resize(cols, rows);
  }, []);

  const field = "w-24 rounded bg-neutral-800 px-2 py-1 text-xs";
  const btn =
    "rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600 disabled:opacity-40";

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-sm">
        <span className="font-medium tracking-wide">Tern</span>
        <span className="text-xs text-neutral-400">{status}</span>
        <input
          className={`${field} w-32`}
          value={form.host}
          onChange={(e) => setForm({ ...form, host: e.target.value })}
          placeholder="host"
        />
        <input
          className={`${field} w-16`}
          value={form.port}
          onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })}
          placeholder="port"
        />
        <input
          className={field}
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder="user"
        />
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={form.useKey}
            onChange={(e) => setForm({ ...form, useKey: e.target.checked })}
          />
          key
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={form.localPty}
            onChange={(e) => setForm({ ...form, localPty: e.target.checked })}
          />
          local
        </label>
        <button
          className={btn}
          disabled={status === "connected" || status === "connecting"}
          onClick={() => void connect(form)}
        >
          connect
        </button>
        <button
          className={btn}
          disabled={status !== "connected"}
          onClick={() => void disconnect()}
        >
          disconnect
        </button>
        <span className="mx-1 text-neutral-700">|</span>
        <button
          className={btn}
          disabled={status !== "connected"}
          onClick={() => void runBench(true)}
        >
          bench quick
        </button>
        <button
          className={btn}
          disabled={status !== "connected"}
          onClick={() => void runBench(false)}
        >
          bench full
        </button>
        <span className="ml-auto font-mono text-[10px] text-neutral-500">{flowLine}</span>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalView onReady={onTerminalReady} onInput={onInput} onResize={onResize} />
      </main>
      {log.length > 0 && (
        <footer className="max-h-40 shrink-0 overflow-y-auto border-t border-neutral-800 px-3 py-1 font-mono text-[10px] leading-4 text-neutral-400">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </footer>
      )}
    </div>
  );
}
