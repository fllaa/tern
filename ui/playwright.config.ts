import { defineConfig, devices } from "@playwright/test";

// A deliberately tiny browser tier. Vitest under jsdom covers the logic; this
// exists for the one class of bug jsdom structurally cannot see — anything that
// needs a layout engine. jsdom reports every offsetWidth as 0, which is also the
// exact condition that makes react-resizable-panels discard `defaultSize`, so a
// sidebar capped at 40px passed tsc, biome and 43 unit tests untouched.
//
// Keep it that way: assertions here should be about geometry and page-level
// health. Anything provable without a real browser belongs in a *.test.ts.
export default defineConfig({
  testDir: "./e2e",

  // No Tauri runtime in a plain browser, so nothing here can touch the disk,
  // the keyring or the network. Tests are pure reads of a rendered page and are
  // safe to run fully parallel.
  fullyParallel: true,

  // A smoke test that only passes on a retry is a smoke test that is lying.
  retries: 0,

  // Guards against a stray `test.only` reaching main and silently shrinking CI.
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: "http://localhost:1420",
    // Not "on-first-retry": retries are 0, so that setting would never fire.
    // A layout failure that only reproduces on CI is near-impossible to read
    // from a log alone, and this costs nothing on a green run.
    trace: "retain-on-failure",
  },

  // Chromium alone. The webview Tauri ships is WebKit on macOS and WebKitGTK on
  // Linux, so no single engine here matches production everywhere — and the
  // failures this tier catches are CSS-layout and framework-behaviour bugs that
  // reproduce identically across engines. One browser, one download, seconds of
  // CI. Add a webkit project only if an engine-specific bug ever escapes.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // The same dev server `bun run dev` starts, which is what Tauri loads in
  // development. `cwd` is this file's directory, so the command runs in ui/.
  //
  // vite.config.ts sets strictPort on 1420 (Tauri requires a fixed port), so a
  // second server cannot quietly come up on 1421 and serve a stale bundle —
  // it fails loudly instead. reuseExistingServer keeps that from being a
  // nuisance locally, where a dev server is usually already running.
  webServer: {
    command: "bun run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    // Cold CI start includes Vite's first dependency optimization pass.
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
