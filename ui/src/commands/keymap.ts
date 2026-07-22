// The accelerator → command table, and window-level dispatch.
//
// One table drives BOTH dispatch and the xterm bubble test (isBoundAccel), so
// they can never drift: the terminal returns false for exactly the chords this
// dispatcher will handle, letting them reach the window instead of the shell.

import { type Accel, eventAccel } from "../lib/shortcuts";
import { commandById } from "./registry";
import type { CommandContext } from "./types";

export const DEFAULT_KEYMAP: ReadonlyArray<{ accel: Accel; command: string }> = [
  { accel: { key: "k" }, command: "palette.toggle" },
  { accel: { key: "f" }, command: "search.focus" },
  { accel: { key: "t" }, command: "session.newLocalShell" },
  { accel: { key: "d" }, command: "pane.splitRight" },
  { accel: { key: "s" }, command: "pane.splitDown" },
  { accel: { key: "o" }, command: "pane.focusNext" },
  { accel: { key: "b" }, command: "session.toggleBroadcast" },
  { accel: { key: "w" }, command: "tab.close" },
  { accel: { key: "[" }, command: "tab.prev" },
  { accel: { key: "]" }, command: "tab.next" },
  { accel: { key: "e" }, command: "tab.rename" },
  { accel: { key: "1" }, command: "tab.select1" },
  { accel: { key: "2" }, command: "tab.select2" },
  { accel: { key: "3" }, command: "tab.select3" },
  { accel: { key: "4" }, command: "tab.select4" },
  { accel: { key: "5" }, command: "tab.select5" },
  { accel: { key: "6" }, command: "tab.select6" },
  { accel: { key: "7" }, command: "tab.select7" },
  { accel: { key: "8" }, command: "tab.select8" },
  { accel: { key: "9" }, command: "tab.selectLast" },
];

const BOUND_KEYS = new Set(DEFAULT_KEYMAP.map((b) => b.accel.key));

/** Whether a chord is claimed by the keymap.
 *
 * This is the terminal bubble test: `wireClipboard`'s key handler returns
 * false for exactly these chords so xterm does not consume them and they reach
 * the window `keydown` listener instead of the shell. */
export function isBoundAccel(accel: Accel | null): boolean {
  return accel != null && BOUND_KEYS.has(accel.key);
}

/** Handle a window keydown against the keymap. Returns whether it consumed the
 *  event. A bound-but-disabled command is swallowed (never leaks to the shell)
 *  and does nothing. */
export function dispatchKey(e: KeyboardEvent, ctx: CommandContext): boolean {
  const accel = eventAccel(e);
  if (!accel || !isBoundAccel(accel)) return false;
  e.preventDefault();
  const hit = DEFAULT_KEYMAP.find((b) => b.accel.key === accel.key);
  const cmd = hit ? commandById(hit.command) : undefined;
  cmd?.run(ctx);
  return true;
}
