// Appearance: the app light/dark choice, the terminal colour scheme, and the
// terminal font. Persisted by the Rust side; applied live here.

import { invoke } from "@tauri-apps/api/core";

import * as pool from "../terminal/pool";
import { setTerminalScheme } from "../terminal/theme";

export type AppTheme = "system" | "light" | "dark";

export interface Appearance {
  theme: AppTheme;
  terminalTheme: string;
  /** Empty means "the app's --font-mono token". */
  fontFamily: string;
  fontSize: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  terminalTheme: "auto",
  fontFamily: "",
  fontSize: 13,
};

export const getAppearance = (): Promise<Appearance> => invoke("get_appearance");

export const setAppearance = (appearance: Appearance): Promise<void> =>
  invoke("set_appearance", { appearance });

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** Toggle the root `dark` class for the app light/dark choice. */
export function applyTheme(theme: AppTheme): void {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

/** Resolve the effective terminal font family — the override, else the token. */
function resolveFontFamily(fontFamily: string): string {
  if (fontFamily) return fontFamily;
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "ui-monospace, monospace"
  );
}

/**
 * Apply a full appearance record: the theme class, the terminal scheme, and the
 * font — to terminals already open (via `restyleAll`) and to those opened later
 * (via `setDefaults`).
 */
export function applyAppearance(a: Appearance): void {
  applyTheme(a.theme);
  setTerminalScheme(a.terminalTheme);
  const fontFamily = resolveFontFamily(a.fontFamily);
  pool.setDefaults({ fontFamily, fontSize: a.fontSize });
  pool.restyleAll({ fontFamily, fontSize: a.fontSize });
}

/**
 * Keep a "system" theme following the OS. Returns an unsubscribe. A no-op for
 * an explicit light/dark choice — those do not track the OS.
 */
export function watchSystemTheme(theme: AppTheme, onChange: () => void): () => void {
  if (theme !== "system" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
