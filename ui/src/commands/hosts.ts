// Dynamic "open this host" commands, one per saved host. Palette-only —
// quick-connect lives here as a command group, not a bespoke component.

import type { Host } from "../lib/hosts-ipc";
import type { Command } from "./types";

export function hostCommands(hosts: Host[]): Command[] {
  return hosts.map((h) => ({
    id: `host.open:${h.id}`,
    title: h.name,
    group: "hosts",
    subtitle: `${h.username ? `${h.username}@` : ""}${h.hostname}${
      h.port !== 22 ? `:${h.port}` : ""
    }`,
    keywords: [h.hostname, h.username].filter((s): s is string => Boolean(s)),
    run: (c) => c.openHost(h.id),
  }));
}
