// App keyboard shortcuts, kept off the shell's toes.
//
// The hard constraint: a terminal client must not steal chords the shell needs.
// Single-Ctrl bindings are readline's — Ctrl+K is kill-line, Ctrl+F is
// forward-char, Ctrl+R is reverse-search — so app shortcuts use Cmd on macOS
// and Ctrl+Shift everywhere else, neither of which readline claims.

/**
 * A platform-neutral app accelerator: the app-accel modifier (see `isAppAccel`)
 * plus a layout-stable key token from `normalizeChord`.
 */
export interface Accel {
  key: string;
}

/** Whether an event carries the app-accelerator modifier (not a shell chord). */
export function isAppAccel(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.metaKey || (e.ctrlKey && e.shiftKey);
}

/**
 * A Shift- and layout-independent token for the *physical* key.
 *
 * Why `code`, not `key`: the non-mac app-accel tier is Ctrl+Shift, and Shift
 * rewrites `e.key` for everything but letters — Ctrl+Shift+1 arrives as key
 * `"!"`, Ctrl+Shift+] as `"}"`. `e.code` names the physical key and never
 * shifts, so it is the only stable basis for a cross-platform accelerator.
 */
export function normalizeChord(e: { code: string }): string | null {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3).toLowerCase(); // KeyK -> "k"
  if (c.startsWith("Digit")) return c.slice(5); // Digit1 -> "1"
  switch (c) {
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    default:
      return null;
  }
}

/** The app-accel chord an event carries, or null if it is not one. */
export function eventAccel(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  code: string;
}): Accel | null {
  if (!isAppAccel(e)) return null;
  const key = normalizeChord(e);
  return key ? { key } : null;
}

/** Platform-aware keycaps for an accelerator, for display in the palette. */
export function accelLabel(accel: Accel): string[] {
  const key = accel.key.length === 1 ? accel.key.toUpperCase() : accel.key;
  return isMac() ? ["⌘", key] : ["Ctrl", "⇧", key];
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}
