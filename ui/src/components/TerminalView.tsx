import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

export interface TerminalReady {
  term: Terminal;
  fit: FitAddon;
  /** "webgl" or "dom" — xterm 6 removed the canvas renderer. */
  renderer: string;
}

/**
 * Mounts xterm with fit + WebGL (DOM renderer fallback). The parent wires the
 * Tauri Channel data path in via `onReady`.
 */
export function TerminalView({
  onReady,
  onInput,
  onResize,
}: {
  onReady: (ready: TerminalReady) => void;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const readyRef = useRef(onReady);
  inputRef.current = onInput;
  resizeRef.current = onResize;
  readyRef.current = onReady;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({ scrollback: 10_000, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let renderer = "dom";
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
      renderer = "webgl";
    } catch {
      // WebGL unavailable (some WebKitGTK setups) — DOM renderer fallback.
    }

    fit.fit();
    term.onData((data) => inputRef.current?.(data));
    term.onResize(({ cols, rows }) => resizeRef.current?.(cols, rows));

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    readyRef.current({ term, fit, renderer });

    return () => {
      window.removeEventListener("resize", onWindowResize);
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full bg-black" />;
}
