// The command registry: the fixed set of actions, plus lookups over it.
//
// Static commands carry the stable ids and keybindings. Dynamic host/tab
// commands are composed in for the palette only (never keybound), so the
// keymap resolves against the static set alone.

import type { Host } from "../lib/hosts-ipc";
import type { Snippet } from "../lib/snippets-ipc";
import { collectPaneIds } from "../store/layout";
import { useSessions } from "../store/sessions";
import { hostCommands } from "./hosts";
import { snippetCommands } from "./snippets";
import { type TabLabel, tabCommands } from "./tabs";
import type { Command } from "./types";

const hasActiveTab = () => useSessions.getState().activeId != null;
const hasMultipleTabs = () => useSessions.getState().order.length > 1;
const hasMultiplePanes = () => {
  const s = useSessions.getState();
  const tab = s.activeId ? s.tabs[s.activeId] : null;
  return tab != null && collectPaneIds(tab.root).length > 1;
};

/** Cmd/Ctrl+Shift 1..8 select that tab; 9 selects the last. */
function selectByIndexCommands(): Command[] {
  const byIndex: Command[] = [];
  for (let i = 1; i <= 8; i += 1) {
    byIndex.push({
      id: `tab.select${i}`,
      title: `Select tab ${i}`,
      group: "tabs",
      keybinding: { key: String(i) },
      enabled: () => useSessions.getState().order.length >= i,
      run: (c) => c.selectTabByIndex(i),
    });
  }
  byIndex.push({
    id: "tab.selectLast",
    title: "Select last tab",
    group: "tabs",
    keybinding: { key: "9" },
    enabled: () => useSessions.getState().order.length > 0,
    run: (c) => c.selectTabByIndex(useSessions.getState().order.length),
  });
  return byIndex;
}

export const STATIC_COMMANDS: Command[] = [
  {
    id: "palette.toggle",
    title: "Command palette",
    group: "view",
    keybinding: { key: "k" },
    hidden: true, // reachable by chord; listing it inside itself is noise
    run: (c) => c.togglePalette(),
  },
  {
    id: "search.focus",
    title: "Find in terminal",
    group: "view",
    keywords: ["search", "find"],
    keybinding: { key: "f" },
    enabled: hasActiveTab,
    run: (c) => c.focusSearch(),
  },
  {
    id: "session.newLocalShell",
    title: "New local shell",
    group: "session",
    keywords: ["terminal", "shell", "bash", "zsh", "pwsh", "pty"],
    keybinding: { key: "t" },
    run: (c) => c.openLocalShell(),
  },
  {
    id: "session.connectHost",
    title: "Connect to host…",
    group: "session",
    keywords: ["ssh", "open", "new session"],
    run: (c) => c.connectHostPrompt(),
  },
  {
    id: "session.duplicatePane",
    title: "Duplicate active pane",
    group: "session",
    keywords: ["duplicate", "clone"],
    enabled: hasActiveTab,
    run: (c) => c.duplicateActivePane(),
  },
  {
    id: "pane.splitRight",
    title: "Split pane right",
    group: "view",
    keywords: ["split", "vertical", "side by side"],
    keybinding: { key: "d" },
    enabled: hasActiveTab,
    run: (c) => c.splitActive("row"),
  },
  {
    id: "pane.splitDown",
    title: "Split pane down",
    group: "view",
    keywords: ["split", "horizontal", "stack"],
    keybinding: { key: "s" },
    enabled: hasActiveTab,
    run: (c) => c.splitActive("column"),
  },
  {
    id: "pane.focusNext",
    title: "Focus next pane",
    group: "view",
    keywords: ["pane", "cycle", "other"],
    keybinding: { key: "o" },
    enabled: hasMultiplePanes,
    run: (c) => c.focusNextPane(),
  },
  {
    id: "session.toggleBroadcast",
    title: "Toggle broadcast to all panes",
    group: "view",
    keywords: ["broadcast", "sync", "type everywhere"],
    keybinding: { key: "b" },
    enabled: hasMultiplePanes,
    run: (c) => c.toggleBroadcast(),
  },
  {
    id: "snippet.manage",
    title: "Manage snippets…",
    group: "snippets",
    keywords: ["snippet", "library", "edit"],
    run: (c) => c.manageSnippets(),
  },
  {
    id: "tab.close",
    title: "Close pane",
    group: "tabs",
    keywords: ["close", "pane"],
    keybinding: { key: "w" },
    enabled: hasActiveTab,
    run: (c) => c.closeActivePane(),
  },
  {
    id: "tab.next",
    title: "Next tab",
    group: "tabs",
    keybinding: { key: "]" },
    enabled: hasMultipleTabs,
    run: (c) => c.selectRelativeTab(1),
  },
  {
    id: "tab.prev",
    title: "Previous tab",
    group: "tabs",
    keybinding: { key: "[" },
    enabled: hasMultipleTabs,
    run: (c) => c.selectRelativeTab(-1),
  },
  {
    id: "tab.rename",
    title: "Rename tab",
    group: "tabs",
    keybinding: { key: "e" },
    enabled: hasActiveTab,
    run: (c) => c.renameActiveTab(),
  },
  ...selectByIndexCommands(),
];

/** A static command by id, or undefined if unknown or currently disabled.
 *  The keymap dispatches through this, so a disabled command is a no-op
 *  rather than an error. */
export function commandById(id: string): Command | undefined {
  const cmd = STATIC_COMMANDS.find((c) => c.id === id);
  if (!cmd) return undefined;
  if (cmd.enabled && !cmd.enabled()) return undefined;
  return cmd;
}

/** Everything the palette lists: enabled, non-hidden static commands plus the
 *  dynamic host, snippet and tab items. */
export function paletteCommands(
  hosts: Host[],
  tabs: TabLabel[],
  snippets: Snippet[],
): Command[] {
  const staticVisible = STATIC_COMMANDS.filter(
    (c) => !c.hidden && (!c.enabled || c.enabled()),
  );
  return [
    ...staticVisible,
    ...hostCommands(hosts),
    ...snippetCommands(snippets),
    ...tabCommands(tabs),
  ];
}
