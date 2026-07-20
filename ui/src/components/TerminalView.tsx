import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

/**
 * Mounts xterm with fit + WebGL (DOM renderer fallback — xterm 6 removed the
 * canvas renderer). The Phase 0 Spike 2 wires the Tauri Channel data path with
 * watermark flow control into `term` here.
 */
export function TerminalView() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({ scrollback: 10_000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    try {
      const webgl = new WebglAddon();
      // On context loss, dispose the addon — xterm falls back to the DOM renderer.
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (some WebKitGTK setups) — DOM renderer fallback.
    }

    fit.fit();
    term.writeln("Tern — terminal spike placeholder");

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    // TODO(spike-2): attach the Tauri Channel -> term.write(bytes) path with
    // pending-byte watermarks (pause/resume) here.

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full bg-black" />;
}
