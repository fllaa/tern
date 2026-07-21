// xterm colours, derived from the Lilt theme tokens.
//
// Read from computed CSS rather than hardcoded so the terminal follows the app
// theme — including the light/dark flip — without a second palette to keep in
// sync. xterm needs concrete colour strings; it cannot consume `var()`.

import type { ISearchOptions } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";

/** The decorations shape, extracted since the addon does not export it by name. */
type SearchDecorations = NonNullable<ISearchOptions["decorations"]>;

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * The ANSI 16 are deliberately *not* Lilt tokens.
 *
 * Those are UI colours chosen to sit next to each other in chrome; ANSI colours
 * have to be distinguishable as syntax and match what decades of terminal
 * output expects `\e[31m` to look like. Only the surface colours — background,
 * foreground, cursor, selection — come from the theme.
 */
const ANSI_DARK = {
  black: "#1c1f1d",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dcdfe4",
  brightBlack: "#5c6370",
  brightRed: "#ef7a82",
  brightGreen: "#a9d67f",
  brightYellow: "#efcb87",
  brightBlue: "#75bbff",
  brightMagenta: "#d68aea",
  brightCyan: "#68c6d1",
  brightWhite: "#ffffff",
};

const ANSI_LIGHT = {
  black: "#3b4048",
  red: "#c1503f",
  green: "#4b8b3b",
  yellow: "#a37b1f",
  blue: "#2f6fb5",
  magenta: "#9440a6",
  cyan: "#2b8091",
  white: "#5c6370",
  brightBlack: "#8a9199",
  brightRed: "#d4604c",
  brightGreen: "#5aa348",
  brightYellow: "#c09227",
  brightBlue: "#3a83d0",
  brightMagenta: "#a94fbb",
  brightCyan: "#3496a9",
  brightWhite: "#2f3237",
};

function isDark(): boolean {
  const root = document.documentElement;
  return root.classList.contains("dark") || root.dataset.theme === "dark";
}

/**
 * Match highlighting for scrollback search.
 *
 * The addon requires `#RRGGBB` strings (no alpha, no `var()`), so these read
 * concrete token values with hex fallbacks — the highlight token for matches,
 * the primary for the active one, so it stands out from the rest.
 */
export function searchDecorations(): SearchDecorations {
  const dark = isDark();
  const match = token("--lilt-highlight", dark ? "#5d532c" : "#fbe7a1");
  const active = token("--lilt-primary", dark ? "#a5e5c6" : "#1f6f4a");
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active,
  };
}

/** The "auto" scheme: surfaces from the app theme, so it follows the light/dark
 *  flip. The one scheme that changes with the chrome rather than standing apart. */
function autoTheme(): ITheme {
  const dark = isDark();
  return {
    // `--lilt-surface` rather than `--lilt-canvas`: the terminal sits in a
    // panel, and matching the panel is what makes it look built-in.
    background: token("--lilt-surface", dark ? "#161a17" : "#ffffff"),
    foreground: token("--lilt-text", dark ? "#e6e8e6" : "#1a1c1a"),
    cursor: token("--lilt-primary", dark ? "#7fd4a8" : "#1f6f4a"),
    cursorAccent: token("--lilt-surface", dark ? "#161a17" : "#ffffff"),
    selectionBackground: token("--lilt-primary-soft", dark ? "#2a4c3b" : "#cfeadd"),
    selectionForeground: token("--lilt-selection-text", dark ? "#ffffff" : "#10231a"),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/** Named, self-contained colour schemes — fixed palettes that do not follow the
 *  app theme. These are the recognisable classics people expect by name. */
const NAMED_SCHEMES: Record<string, ITheme> = {
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  "gruvbox-dark": {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
};

/** Selectable terminal schemes, in menu order. */
export const TERMINAL_SCHEMES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Match app theme" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "gruvbox-dark", label: "Gruvbox Dark" },
];

let currentScheme = "auto";

/** Set the active terminal scheme; the pool reads it on the next restyle. */
export function setTerminalScheme(scheme: string): void {
  currentScheme = scheme;
}

export function terminalTheme(): ITheme {
  return NAMED_SCHEMES[currentScheme] ?? autoTheme();
}
