// Terminal instances, owned outside React.
//
// ## Why a module-level map rather than component state
//
// A `Terminal` in React state is destroyed and rebuilt on reconciliation, and
// with it the scrollback. Scrollback surviving a tab switch is the entire
// point of a tabbed terminal, so the instances outlive the components that
// display them and `TerminalMount` is only a window onto one.
//
// ## Why all terminals stay in the document
//
// Three arrangements are possible and two of them are traps:
//
//   * `display: none` on inactive tabs — FitAddon measures a display:none
//     element as 0×0 and computes garbage cols/rows, so the remote PTY gets
//     resized to nonsense the moment you switch away.
//   * Detaching inactive tabs from the DOM entirely — appealing, because only
//     one terminal is ever live. But whether xterm 6 tolerates a detached host
//     element on its next render pass is not something we have verified, and
//     building the tab model on an unverified assumption is how you discover a
//     problem in month six.
//   * Stacked, with `visibility: hidden` on inactive tabs — layout is
//     preserved so `fit()` stays correct, nothing is ever detached, and the
//     cost is bounded by only giving the *active* tab a WebGL context.
//
// The third is what this does. Browsers cap WebGL contexts around 8–16, so
// handing one to every tab would silently drop later tabs to the DOM renderer;
// instead the addon is created on activate and disposed on deactivate.
//
// The load-bearing detail that makes hidden tabs safe: backpressure is driven
// by `term.write(bytes, callback)` — the *parser*, not the renderer. A hidden
// terminal still parses and still fires its write callbacks, so flow control
// keeps working for background tabs exactly as it does for the foreground one.

import { FitAddon } from "@xterm/addon-fit";
import type { ISearchOptions } from "@xterm/addon-search";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

import type { PaneId } from "../store/sessions";
import { searchDecorations, terminalTheme } from "./theme";

export interface TerminalHandle {
  term: Terminal;
  fit: FitAddon;
  /** Scrollback search. One per terminal so results survive a tab switch. */
  search: SearchAddon;
  /** The element `term.open()` was called on. Always in the document. */
  host: HTMLDivElement;
  renderer: "webgl" | "dom";
  /** Live only while this tab is active; disposed on deactivate. */
  webgl: { dispose(): void } | null;
  disposers: Array<() => void>;
}

const pool = new Map<PaneId, TerminalHandle>();

export interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
}

export const DEFAULT_TERMINAL_OPTIONS: TerminalOptions = {
  // Resolved from the --font-mono token so the terminal follows the theme.
  fontFamily:
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "ui-monospace, monospace",
  fontSize: 13,
  scrollback: 10_000,
};

// The options new terminals are created with. Mutable so an appearance change
// reaches tabs opened *after* it, not just the ones already on screen (those
// are handled by `restyleAll`).
let currentOptions: TerminalOptions = { ...DEFAULT_TERMINAL_OPTIONS };

/** Update the defaults future terminals are created with. */
export function setDefaults(opts: Partial<TerminalOptions>): void {
  currentOptions = { ...currentOptions, ...opts };
}

/**
 * The webfont must be loaded *before* the first Terminal is constructed.
 *
 * xterm's WebGL renderer measures one glyph and caches an atlas from it. If it
 * measures a fallback font because JetBrains Mono has not arrived yet, every
 * cell is mis-sized for the life of the session and no amount of later
 * refreshing fixes it.
 */
export async function waitForTerminalFont(opts = currentOptions): Promise<void> {
  if (!document.fonts) return;
  try {
    await document.fonts.load(`${opts.fontSize}px ${opts.fontFamily}`);
    await document.fonts.ready;
  } catch {
    // A font that will not load is not worth blocking a connection over; the
    // fallback stack still renders, just less prettily.
  }
}

/** Create (or return) the terminal for a tab. */
export function acquire(id: PaneId, opts = currentOptions): TerminalHandle {
  const existing = pool.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    scrollback: opts.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);

  const host = document.createElement("div");
  // Absolutely positioned to fill its leaf container exactly (inset:0 against a
  // relative mount), so panes overlap in the same box instead of stacking down
  // the page and each claiming a screenful of height. Visibility is the tab
  // *layer*'s job now: a background tab is visibility:hidden (still laid out, so
  // FitAddon measures correctly), which hides its panes; the host stays visible.
  host.style.position = "absolute";
  host.style.inset = "0";

  const handle: TerminalHandle = {
    term,
    fit,
    search,
    host,
    renderer: "dom",
    webgl: null,
    disposers: [],
  };
  pool.set(id, handle);
  return handle;
}

export function get(id: PaneId): TerminalHandle | undefined {
  return pool.get(id);
}

/** Open the terminal onto its host element. Idempotent. */
export function ensureOpen(handle: TerminalHandle): void {
  if (handle.host.childElementCount === 0) {
    handle.term.open(handle.host);
  }
}

/**
 * The most simultaneously-visible panes that get a WebGL context.
 *
 * Browsers cap WebGL contexts around 8–16; a split tab can show many panes at
 * once, so the focused pane and up to this many visible neighbours get WebGL
 * and the rest fall back to the DOM renderer. A single-pane tab always fits.
 */
export const MAX_WEBGL = 8;

/**
 * Reconcile which terminals hold a WebGL context.
 *
 * `visible` is the active tab's panes, focused first — so the focused pane is
 * always within the cap. Panes past the cap, and every pane in a background
 * tab, drop to the DOM renderer (its documented fallback). Visibility itself is
 * the React tab-layer's job; this only rations the scarce GL contexts.
 */
export function reconcileRenderers(visible: PaneId[]): void {
  const withGl = new Set(visible.slice(0, MAX_WEBGL));
  for (const [id, handle] of pool) {
    if (withGl.has(id)) {
      ensureWebgl(handle);
      safeFit(handle);
    } else {
      dropWebgl(handle);
    }
  }
}

function ensureWebgl(handle: TerminalHandle): void {
  if (!handle.webgl) void loadWebgl(handle);
}

/** Release a terminal's WebGL context, falling back to the DOM renderer. Dispose
 *  before it can be hidden — a live context on an invisible element is a crash. */
function dropWebgl(handle: TerminalHandle): void {
  handle.webgl?.dispose();
  handle.webgl = null;
  handle.renderer = "dom";
}

async function loadWebgl(handle: TerminalHandle): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      handle.webgl = null;
      handle.renderer = "dom";
    });
    handle.term.loadAddon(addon);
    handle.webgl = addon;
    handle.renderer = "webgl";
  } catch {
    // No WebGL (notably some WebKitGTK builds) — the DOM renderer is the
    // documented fallback and correctness does not depend on which is used.
    handle.renderer = "dom";
  }
}

/**
 * Fit, but never on an element that has no layout.
 *
 * `fit()` on a zero-sized element computes garbage cols/rows and pushes them
 * to the remote PTY, which is far worse than not fitting at all.
 */
export function safeFit(handle: TerminalHandle): boolean {
  const { host } = handle;
  if (!host.isConnected) return false;
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return false;
  try {
    handle.fit.fit();
    return true;
  } catch {
    return false;
  }
}

/** Re-fit every mounted terminal — for a window resize. */
export function fitAll(): void {
  for (const handle of pool.values()) safeFit(handle);
}

/** Apply changed appearance settings to every terminal. */
export function restyleAll(opts: Partial<TerminalOptions>): void {
  const theme = terminalTheme();
  for (const handle of pool.values()) {
    if (opts.fontFamily) handle.term.options.fontFamily = opts.fontFamily;
    if (opts.fontSize) handle.term.options.fontSize = opts.fontSize;
    if (opts.scrollback) handle.term.options.scrollback = opts.scrollback;
    handle.term.options.theme = theme;
    // The glyph atlas is keyed on the old metrics and colours.
    (handle.webgl as { clearTextureAtlas?: () => void } | null)?.clearTextureAtlas?.();
    safeFit(handle);
  }
}

/** Result of a search, as the addon reports it. */
export interface SearchResults {
  resultIndex: number;
  resultCount: number;
}

function withDecorations(opts?: Partial<ISearchOptions>): ISearchOptions {
  return { decorations: searchDecorations(), ...opts };
}

/** Find the next match, scrolling it into view. Returns whether one was found. */
export function searchNext(
  id: PaneId,
  query: string,
  opts?: Partial<ISearchOptions>,
): boolean {
  return pool.get(id)?.search.findNext(query, withDecorations(opts)) ?? false;
}

/** Find the previous match. */
export function searchPrev(
  id: PaneId,
  query: string,
  opts?: Partial<ISearchOptions>,
): boolean {
  return pool.get(id)?.search.findPrevious(query, withDecorations(opts)) ?? false;
}

/** Drop all match highlighting — for closing the search bar. */
export function searchClear(id: PaneId): void {
  pool.get(id)?.search.clearDecorations();
}

/** Subscribe to result-count changes; returns an unsubscribe. */
export function onSearchResults(id: PaneId, cb: (r: SearchResults) => void): () => void {
  const handle = pool.get(id);
  if (!handle) return () => {};
  const sub = handle.search.onDidChangeResults(cb);
  return () => sub.dispose();
}

/** Tear a terminal down for good. */
export function release(id: PaneId): void {
  const handle = pool.get(id);
  if (!handle) return;
  for (const dispose of handle.disposers) {
    try {
      dispose();
    } catch {
      // A listener that throws on teardown must not strand the rest.
    }
  }
  handle.webgl?.dispose();
  handle.term.dispose();
  handle.host.remove();
  pool.delete(id);
}

/** Test/diagnostic helper: how many terminals are alive. */
export function size(): number {
  return pool.size;
}
