// The command vocabulary.
//
// A command is pure data plus a `run` that receives the injected
// `CommandContext` — every side effect goes through that context, so the
// registry and keymap stay testable without React or the DOM.

import type { Accel } from "../lib/shortcuts";

export type CommandGroupId = "session" | "tabs" | "hosts" | "view";

/** Every side-effecting operation a command may invoke. App builds this once
 *  and injects it, so commands never reach into React state directly. */
export interface CommandContext {
  openHost: (hostId: number) => void;
  openLocalShell: () => void;
  connectHostPrompt: () => void;
  focusSearch: () => void;
  togglePalette: () => void;
  closeActiveTab: () => void;
  selectRelativeTab: (delta: number) => void;
  selectTabByIndex: (oneBased: number) => void;
  selectTab: (tabId: string) => void;
  renameActiveTab: () => void;
}

export interface Command {
  id: string;
  title: string;
  group: CommandGroupId;
  /** Extra terms the palette search matches, beyond the title. */
  keywords?: string[];
  /** A muted second line under the title (a host's user@host:port). */
  subtitle?: string;
  /** Shown as a hint in the palette; the keymap is the source of truth. */
  keybinding?: Accel;
  /** Registered but kept out of the palette (e.g. the palette toggle itself). */
  hidden?: boolean;
  /** When present and false, the command is hidden from the palette and its
   *  keybinding is a no-op. */
  enabled?: () => boolean;
  run: (ctx: CommandContext) => void;
}
