// Dynamic "switch to tab" commands, one per open tab. Palette-only.

import type { Tab } from "../store/sessions";
import type { Command } from "./types";

export function tabCommands(tabs: Tab[]): Command[] {
  return tabs.map((t) => ({
    id: `tab.switch:${t.id}`,
    title: t.title,
    group: "tabs",
    keywords: ["switch", "tab"],
    run: (c) => c.selectTab(t.id),
  }));
}
