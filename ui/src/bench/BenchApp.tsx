// Phase 0 benchmark harness, lifted verbatim out of the old App.tsx.
//
// This mounts *instead of* the product UI when TERN_BENCH=auto (see main.tsx),
// so a bench run has no stores, no dialogs, and no product effects that could
// perturb the numbers in docs/bench/. That is stricter isolation than the
// spike had, where the harness and the shell were the same component.
//
// The terminal is built through the same TerminalView the product uses, so the
// renderer string that lands in every BenchReport still describes the real
// product path.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { type TerminalReady, TerminalView } from "../components/TerminalView";
import { type BenchEnv, ptySmoke, runSuite } from "../lib/bench";
import { type AutoBenchCfg, benchAutoDone, TermSession } from "../lib/ipc";

interface LogLine {
  id: number;
  text: string;
}

export default function BenchApp({ cfg }: { cfg: AutoBenchCfg }) {
  const [log, setLog] = useState<LogLine[]>([]);
  const [flowLine, setFlowLine] = useState("");
  const sessionRef = useRef<TermSession | null>(null);
  const started = useRef(false);
  // The list is capped and sliced from the front, so array indices shift as it
  // fills — a monotonic id keeps React's reconciliation stable.
  const nextLogId = useRef(0);

  const pushLog = useCallback((line: string) => {
    console.log(`[bench] ${line}`);
    void invoke("bench_log", { line }).catch(() => {});
    nextLogId.current += 1;
    const entry = { id: nextLogId.current, text: line };
    setLog((prev) => [...prev.slice(-199), entry]);
  }, []);

  const onTerminalReady = useCallback(
    (ready: TerminalReady) => {
      if (started.current) return;
      started.current = true;
      void (async () => {
        pushLog(`auto-bench: ${JSON.stringify(cfg)}`);
        const ptyOk = await ptySmoke(ready.term, pushLog);

        let session: TermSession | null = null;
        try {
          session = await TermSession.open(ready.term, {
            target: {
              kind: "ssh",
              host: cfg.host,
              port: cfg.port,
              username: cfg.username,
              auth: {
                method: "key_file",
                path: cfg.key_path,
                passphrase: null,
              },
              // Rig only. The product path never sets this, and with it set
              // the host-key callback short-circuits before known_hosts.
              insecure_accept_host_key: true,
            },
            cols: ready.term.cols,
            rows: ready.term.rows,
            chunk_max: cfg.chunk_max,
            tick_ms: cfg.tick_ms,
            window_size: cfg.window_size,
          });
        } catch (err) {
          pushLog(`connect failed: ${String(err)}`);
        }

        if (!session) {
          await benchAutoDone(true);
          return;
        }
        sessionRef.current = session;

        const env: BenchEnv = {
          renderer: ready.renderer,
          chunk_max: cfg.chunk_max,
          tick_ms: cfg.tick_ms,
          window_size: cfg.window_size,
          server: cfg.port === 2223 ? "dropbear" : "openssh",
        };
        const result = await runSuite(session, env, cfg.quick, pushLog);
        await benchAutoDone(result.failed || !ptyOk);
      })();
    },
    [cfg, pushLog],
  );

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

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-sm">
        <span className="font-medium tracking-wide">Tern — benchmark</span>
        <span className="ml-auto font-mono text-[10px] text-neutral-500">{flowLine}</span>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalView onReady={onTerminalReady} onInput={onInput} onResize={onResize} />
      </main>
      {log.length > 0 && (
        <footer className="max-h-40 shrink-0 overflow-y-auto border-t border-neutral-800 px-3 py-1 font-mono text-[10px] leading-4 text-neutral-400">
          {log.map((line) => (
            <div key={line.id}>{line.text}</div>
          ))}
        </footer>
      )}
    </div>
  );
}
