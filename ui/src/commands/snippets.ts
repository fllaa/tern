// Dynamic "run this snippet" commands, one per stored snippet. Palette-only.
//
// The command carries the id rather than the snippet: App holds the live list,
// so resolving at run time avoids acting on a copy the manager has since
// edited or deleted.

import type { Snippet } from "../lib/snippets-ipc";
import type { Command } from "./types";

export function snippetCommands(snippets: Snippet[]): Command[] {
  return snippets.map((s) => ({
    id: `snippet.run:${s.id}`,
    title: s.name,
    group: "snippets",
    subtitle: s.description ?? undefined,
    keywords: ["snippet", "run"],
    run: (c) => c.runSnippet(s.id),
  }));
}
