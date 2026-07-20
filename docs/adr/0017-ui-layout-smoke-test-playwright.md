# ADR-0017: A headless-browser tier for layout, in Playwright

- Status: Accepted
- Date: 2026-07-20

## Context

c8f444a shipped a sidebar that rendered as a ~40px sliver, and every gate the
repo had passed it: `tsc --noEmit` (the react-resizable-panels props are
correctly typed — v4 simply reads a bare number as pixels where v3 read it as a
percentage), Biome, and all 43 Vitest tests. The blind spot is structural, not an
oversight. Vitest runs under jsdom, which has no layout engine: every
`offsetWidth` is 0 — and 0 is precisely the measurement that makes the library
discard `defaultSize`. The tier that should have caught the bug is the one whose
environment reproduces its trigger and reports success.

## Decision

We add a **Playwright tier with a single Chromium project**, run against the Vite
dev server in the existing `ui` CI job. It asserts **geometry and page-level
health only** — sidebar width at three viewports, the shell filling the window,
no console errors on load. Anything provable without a real browser stays in a
`*.test.ts`; this tier is not where feature coverage goes.

Three alternatives were considered:

- **A DOM shim with layout (happy-dom, jsdom patches)** — rejected. Neither
  implements CSS layout; they would move the number from 0 to a different wrong
  number, which is worse than an honest 0.
- **Driving the packaged Tauri app (tauri-driver/WebDriver)** — rejected for
  *this* tier. It is slow, platform-specific, and aimed at a different risk. The
  `integration` job already covers the Rust side against a real sshd, and the
  bug class here needs a layout engine, not a Tauri runtime.
- **Screenshot/visual-regression diffing** — rejected. Font rasterisation differs
  per platform, so it buys constant baseline churn, and "the sidebar is 281px,
  not 40px" is a claim better made as a number than as an image.

Two sub-decisions carry real cost and are made deliberately. **Chromium only:**
Tauri ships WebView2 (Chromium) on Windows but WebKitGTK on Linux and WKWebView
on macOS, so no single engine matches production everywhere — partial
cross-engine coverage would be theatre at triple the CI cost, and the failures
this tier targets are framework-behaviour and CSS-layout bugs that reproduce
across engines. **Dev server, not the production build:** it is what Tauri loads
in development and costs no build step; the 3-OS `test` job already exercises the
real `vite build`.

Fallback: if an engine-specific layout bug ever escapes, adding a `webkit`
project is one entry in `projects[]` and one more cached browser download.

## Consequences

- Good: the original bug now fails CI. Verified by reverting App.tsx to the v3
  props — all three sidebar assertions fail, with the measured pixel width in the
  message; the two non-layout tests stay green.
- Good: cheap enough to keep. Five tests, under a second locally, one Chromium
  download cached on `runner.os` + Playwright version.
- Bad / accepted cost: a new dev dependency, and ~540 MB restored from cache
  (`playwright install chromium` fetches full Chromium, the headless shell and
  ffmpeg) for a tier that is currently five assertions. Installing only
  `chromium-headless-shell` would cut that to ~190 MB; not done, because it
  would break `--headed` local debugging and bet on how a future Playwright
  resolves headless. Worth trimming if the repo's Actions cache gets tight.
- Bad / accepted cost: WebKit-specific layout bugs still reach macOS and Linux
  users unseen. This is the honest gap, not a claim of cross-browser safety —
  and it lands on the platform the dev plan already names as Tauri's weak spot,
  so the multi-distro manual testing it calls for stays necessary. This tier
  narrows the blind spot; it does not close it.
- Bad / accepted cost: the expected widths restate constants from `App.tsx`, so
  an intentional layout change means editing two files. Deliberate — a test that
  imports its expectation from the code under test cannot fail when that code is
  wrong.
- Revisit when: an engine-specific bug escapes to a release (add `webkit`), or
  the tier needs a real Tauri runtime to say anything useful (that is when
  tauri-driver starts earning its cost).
