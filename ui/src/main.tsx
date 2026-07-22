// Fonts are bundled, not fetched. The Tauri CSP is `font-src 'self' data:`,
// so a Google Fonts link would silently fail to load and the terminal would
// fall back to a font with no box-drawing glyphs. @fontsource ships woff2 that
// Vite rewrites to hashed same-origin assets, satisfying 'self' with no CSP
// change at all.
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource-variable/jetbrains-mono";

import ReactDOM from "react-dom/client";
import App from "./App";
import BenchApp from "./bench/BenchApp";
import { benchAuto } from "./lib/ipc";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root element");
const root = ReactDOM.createRoot(el);

// A bench run mounts the harness *instead of* the product UI, so no store, no
// dialog, and no product effect can perturb the numbers in docs/bench/.
// `bench_auto` returns null unless TERN_BENCH=auto, so this costs one IPC
// round trip at startup and nothing else.
void benchAuto()
  .catch(() => null)
  .then((cfg) => {
    root.render(cfg ? <BenchApp cfg={cfg} /> : <App />);
  });
