// Dynamic "switch to tab" commands, one per open tab. Palette-only.
//
// A tab's label is its focused pane's title (a tab has no title of its own),
// so callers pass the resolved labels rather than raw tabs.

import type { Command } from "./types";

export interface TabLabel {
  id: string;
  title: string;
}

export function tabCommands(tabs: TabLabel[]): Command[] {
  return tabs.map((t) => ({
    id: `tab.switch:${t.id}`,
    title: t.title,
    group: "tabs",
    keywords: ["switch", "tab"],
    run: (c) => c.selectTab(t.id),
  }));
}
