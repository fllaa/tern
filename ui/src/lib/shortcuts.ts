// App keyboard shortcuts, kept off the shell's toes.
//
// The hard constraint: a terminal client must not steal chords the shell needs.
// Single-Ctrl bindings are readline's — Ctrl+K is kill-line, Ctrl+F is
// forward-char, Ctrl+R is reverse-search — so app shortcuts use Cmd on macOS
// and Ctrl+Shift everywhere else, neither of which readline claims.

interface Chord {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
}

/** Whether an event carries the app-accelerator modifier (not a shell chord). */
export function isAppAccel(e: Pick<Chord, "metaKey" | "ctrlKey" | "shiftKey">): boolean {
  return e.metaKey || (e.ctrlKey && e.shiftKey);
}

/** Which app action a key event maps to, if any. */
export type Shortcut = "palette" | "search";

export function matchShortcut(e: Chord): Shortcut | null {
  if (!isAppAccel(e)) return null;
  switch (e.key.toLowerCase()) {
    case "k":
      return "palette";
    case "f":
      return "search";
    default:
      return null;
  }
}
