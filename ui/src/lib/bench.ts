// Spike 2 benchmark harness: scenario runner, marker detection, echo latency,
// UI-stall meter, and threshold verdicts. Results are merged with the
// Rust-side StreamStats and written to docs/bench/results/ by the backend.

import type { BenchJsStats, BenchReport, StreamStatsDto } from "./ipc";
import { TermSession, benchFinish } from "./ipc";

export interface ScenarioOutcome {
  name: string;
  report: BenchReport;
  parsedMbps: number;
  rustMbps: number;
  lossless: boolean;
  verdict: "pass" | "fail" | "info";
  detail: string;
}

export interface BenchEnv {
  renderer: string;
  chunk_max: number;
  tick_ms: number;
  window_size: number;
  server: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once no data has arrived for `quietMs`. */
function waitQuiet(session: TermSession, quietMs: number, capMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let last = performance.now();
    const prev = session.onData;
    session.onData = (bytes, t) => {
      prev?.(bytes, t);
      last = t;
    };
    const started = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - last >= quietMs || now - started >= capMs) {
        clearInterval(timer);
        session.onData = prev;
        resolve();
      }
    }, 25);
  });
}

/** Resolve when `marker` appears in the decoded output stream. */
function waitForMarker(
  session: TermSession,
  marker: string,
  timeoutMs: number,
  debug?: (line: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let tail = "";
    let seen = 0;
    const prev = session.onData;
    const timer = setTimeout(() => {
      session.onData = prev;
      resolve(false);
    }, timeoutMs);
    session.onData = (bytes, t) => {
      prev?.(bytes, t);
      seen += bytes.length;
      tail += decoder.decode(bytes, { stream: true });
      if (tail.length > 512) tail = tail.slice(-512);
      if (tail.includes(marker)) {
        debug?.(
          `marker ${marker} matched after ${seen}B; tail=${JSON.stringify(tail.slice(-160))}`,
        );
        clearTimeout(timer);
        session.onData = prev;
        resolve(true);
      }
    };
  });
}

function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve(true);
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 10);
  });
}

/** Longest gap between animation frames — the honest UI-stall proxy. */
function startStallMeter(): { stop: () => number } {
  let maxGap = 0;
  let last = performance.now();
  let running = true;
  const loop = (t: number) => {
    const gap = t - last;
    if (gap > maxGap) maxGap = gap;
    last = t;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    stop: () => {
      running = false;
      return maxGap;
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

const mbps = (bytes: number, ms: number) => (ms > 0 ? bytes / 1024 / 1024 / (ms / 1000) : 0);

async function collect(
  session: TermSession,
  env: BenchEnv,
  name: string,
  wallMs: number,
  maxStallMs: number | undefined,
  echo?: { p50: number; p95: number; max: number; n: number },
): Promise<BenchReport> {
  const rust: StreamStatsDto = await session.benchStats();
  const flow = session.flow;
  const js: BenchJsStats = {
    recv_bytes: flow.recvBytes,
    recv_frames: flow.recvFrames,
    parsed_bytes: flow.parsedBytes,
    wall_ms: Math.round(wallMs),
    max_pending_bytes: flow.maxPending,
    pause_count: flow.pauseCount,
    js_newlines: flow.jsNewlines,
    echo_p50_ms: echo?.p50,
    echo_p95_ms: echo?.p95,
    echo_max_ms: echo?.max,
    echo_samples: echo?.n,
    max_stall_ms: maxStallMs,
  };
  const report: BenchReport = { scenario: name, ...env, rust, js };
  await benchFinish(report);
  return report;
}

/** Run one streaming command scenario to its completion marker. */
async function runCommandScenario(
  session: TermSession,
  env: BenchEnv,
  name: string,
  command: string,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<ScenarioOutcome> {
  await waitQuiet(session, 400);
  await session.benchReset();
  session.resetJsStats();

  const stall = startStallMeter();
  const t0 = performance.now();
  const marker = `__DONE_${name}__`;
  // PTY echo is off during streaming scenarios (see runSuite), so the typed
  // command can never satisfy the marker — only printf's real output can.
  await session.writeText(`${command}; printf '\\n${marker}\\n'\n`);
  const sawMarker = await waitForMarker(session, marker, timeoutMs, log);
  const wall = performance.now() - t0;
  // Drain: no new arrivals for 300ms AND everything parsed, so both stat taps
  // are settled before the snapshot (wall excludes this drain tail).
  await waitQuiet(session, 300);
  await waitUntil(() => session.flow.pendingBytes === 0, 10000);
  const maxStall = stall.stop();

  const report = await collect(session, env, name, wall, maxStall);
  const parsedMbps = mbps(report.js.parsed_bytes, wall);
  const rustMbps = mbps(report.rust.bytes_in, wall);
  const lossless =
    sawMarker && report.rust.newlines_in === report.js.js_newlines;
  const verdict = lossless ? "pass" : "fail";
  const detail =
    `${name}: ${parsedMbps.toFixed(1)} MB/s parsed (rust-in ${rustMbps.toFixed(1)}), ` +
    `${report.js.recv_frames} frames, maxPending ${(report.js.max_pending_bytes / 1024).toFixed(0)}K, ` +
    `pauses ${report.js.pause_count}, stall ${maxStall.toFixed(0)}ms, ` +
    `newlines rust=${report.rust.newlines_in} js=${report.js.js_newlines}` +
    (sawMarker ? "" : " [NO MARKER — timeout]");
  log(detail);
  return { name, report, parsedMbps, rustMbps, lossless, verdict, detail };
}

/** `yes` has no natural end: stream for `secs`, then Ctrl-C. */
async function runYesScenario(
  session: TermSession,
  env: BenchEnv,
  secs: number,
  log: (line: string) => void,
): Promise<ScenarioOutcome> {
  await waitQuiet(session, 400);
  await session.benchReset();
  session.resetJsStats();

  const stall = startStallMeter();
  const t0 = performance.now();
  await session.writeText("yes\n");
  await sleep(secs * 1000);
  await session.write(new Uint8Array([0x03]));
  const marker = "__DONE_yes__";
  await sleep(300);
  await session.writeText(`printf '\\n${marker}\\n'\n`);
  const sawMarker = await waitForMarker(session, marker, 20000, log);
  const wall = performance.now() - t0;
  await waitQuiet(session, 300);
  await waitUntil(() => session.flow.pendingBytes === 0, 10000);
  const maxStall = stall.stop();

  const name = `yes${secs}s`;
  const report = await collect(session, env, name, wall, maxStall);
  const parsedMbps = mbps(report.js.parsed_bytes, wall);
  const rustMbps = mbps(report.rust.bytes_in, wall);
  const lossless = sawMarker && report.rust.newlines_in === report.js.js_newlines;
  const detail =
    `${name}: ${parsedMbps.toFixed(1)} MB/s parsed (rust-in ${rustMbps.toFixed(1)}), ` +
    `pauses ${report.js.pause_count}, paused ${report.rust.paused_ms}ms total, ` +
    `stall ${maxStall.toFixed(0)}ms, newlines rust=${report.rust.newlines_in} js=${report.js.js_newlines}`;
  log(detail);
  return { name, report, parsedMbps, rustMbps, lossless, verdict: lossless ? "pass" : "fail", detail };
}

/** 200 scripted keystrokes at a quiet prompt; latency = write() → parse of echo. */
async function runEchoScenario(
  session: TermSession,
  env: BenchEnv,
  n: number,
  log: (line: string) => void,
): Promise<ScenarioOutcome> {
  // This scenario MEASURES echo, so re-enable it (streaming scenarios run
  // with `stty -echo` — see runSuite).
  await session.writeText("stty echo\n");
  await waitQuiet(session, 500);
  await session.benchReset();
  session.resetJsStats();

  const samples: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    // Clear the accumulating line every 24 chars (Ctrl-U).
    if (i % 24 === 23) {
      await session.write(new Uint8Array([0x15]));
      await sleep(60);
    }
    const parsed = new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        session.onParsed = null;
        resolve(Number.NaN);
      }, 2000);
      session.onParsed = (t) => {
        clearTimeout(timer);
        session.onParsed = null;
        resolve(t);
      };
    });
    const sent = performance.now();
    await session.writeText("a");
    const t1 = await parsed;
    if (!Number.isNaN(t1)) samples.push(t1 - sent);
    await sleep(90);
  }
  await session.write(new Uint8Array([0x15]));
  const wall = performance.now() - t0;

  samples.sort((a, b) => a - b);
  const echo = {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples.length ? samples[samples.length - 1] : 0,
    n: samples.length,
  };
  const report = await collect(session, env, "echo", wall, undefined, echo);
  const pass = echo.p95 < 16 && echo.n >= n * 0.95;
  const detail =
    `echo: p50 ${echo.p50.toFixed(2)}ms p95 ${echo.p95.toFixed(2)}ms ` +
    `max ${echo.max.toFixed(2)}ms over ${echo.n}/${n} keystrokes`;
  log(detail);
  return {
    name: "echo",
    report,
    parsedMbps: 0,
    rustMbps: 0,
    lossless: true,
    verdict: pass ? "pass" : "fail",
    detail,
  };
}

/**
 * Spike 3 UI-path proof: open a *local PTY* session through the identical
 * Channel data path, round-trip a marker, close. SSH and local shells must be
 * transport-interchangeable behind the same IPC.
 */
export async function ptySmoke(
  term: import("@xterm/xterm").Terminal,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const s = await TermSession.open(term, {
      target: { kind: "local_pty", program: null },
      cols: term.cols,
      rows: term.rows,
    });
    const ok = await new Promise<boolean>((resolve) => {
      const decoder = new TextDecoder();
      let tail = "";
      const timer = setTimeout(() => {
        s.onData = null;
        resolve(false);
      }, 10000);
      s.onData = (b) => {
        tail = (tail + decoder.decode(b, { stream: true })).slice(-256);
        if (tail.includes("__PTY_OK__")) {
          clearTimeout(timer);
          s.onData = null;
          resolve(true);
        }
      };
      // Marker split so the shell's echo of the command can't match it.
      void s.writeText("printf '\n__PT''Y_OK__\n'\n");
    });
    await s.close();
    log(`local-pty smoke (same IPC path): ${ok ? "PASS" : "FAIL"}`);
    return ok;
  } catch (err) {
    log(`local-pty smoke failed: ${String(err)}`);
    return false;
  }
}

export interface SuiteResult {
  outcomes: ScenarioOutcome[];
  failed: boolean;
  summary: string[];
}

export async function runSuite(
  session: TermSession,
  env: BenchEnv,
  quick: boolean,
  log: (line: string) => void,
): Promise<SuiteResult> {
  const outcomes: ScenarioOutcome[] = [];
  log(`suite start: chunk=${env.chunk_max / 1024}K tick=${env.tick_ms}ms window=${env.window_size / 1024}K renderer=${env.renderer}`);

  // Kill PTY echo for the streaming scenarios: the typed command must never be
  // able to satisfy a completion marker (only real program output counts).
  // The echo-latency scenario turns it back on — echo is what it measures.
  await session.writeText("stty -echo\n");
  await waitQuiet(session, 400);

  outcomes.push(
    await runCommandScenario(session, env, "seq2m", "seq 1 2000000", 120000, log),
  );
  outcomes.push(
    await runCommandScenario(session, env, "cat100mb", "cat /bench/100mb.txt", 180000, log),
  );
  if (!quick) {
    outcomes.push(await runYesScenario(session, env, 10, log));
    outcomes.push(
      await runCommandScenario(
        session,
        env,
        "b64urandom",
        "head -c 100000000 /dev/urandom | base64",
        240000,
        log,
      ),
    );
    outcomes.push(
      await runCommandScenario(session, env, "findroot", "find / 2>/dev/null", 120000, log),
    );
  }
  outcomes.push(await runEchoScenario(session, env, 200, log));

  // Thresholds (dev plan + ADR-0011): zero drops; echo p95 < 16ms;
  // cat100mb parsed >= 20 MB/s end-to-end.
  const cat = outcomes.find((o) => o.name === "cat100mb");
  const echo = outcomes.find((o) => o.name === "echo");
  const drops = outcomes.filter((o) => !o.lossless);
  const failures: string[] = [];
  if (drops.length > 0) failures.push(`LOSS in: ${drops.map((o) => o.name).join(", ")}`);
  if (cat && cat.parsedMbps < 20) failures.push(`cat100mb ${cat.parsedMbps.toFixed(1)} MB/s < 20`);
  if (echo && echo.verdict === "fail") failures.push("echo p95 >= 16ms");
  const stalls = outcomes.filter((o) => (o.report.js.max_stall_ms ?? 0) > 250);
  if (stalls.length > 0)
    failures.push(`UI stalls >250ms in: ${stalls.map((o) => o.name).join(", ")}`);

  const summary = [
    ...outcomes.map((o) => `${o.verdict.toUpperCase().padEnd(4)} ${o.detail}`),
    failures.length ? `FAILED: ${failures.join(" | ")}` : "ALL THRESHOLDS PASSED",
  ];
  summary.forEach((line) => log(`>> ${line}`));
  return { outcomes, failed: failures.length > 0, summary };
}
