// The unified command palette (Cmd/Ctrl+K).
//
// One palette over the command registry: actions and host quick-connect are
// both command groups. Built on the vendored Command primitives using their
// grouped path — Base UI filters leaf items by `itemToStringValue` and drops
// empty groups, so typing a host name collapses to just the Hosts group.

import { useMemo } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { paletteCommands } from "../commands/registry";
import type { Command as Cmd, CommandContext, CommandGroupId } from "../commands/types";
import type { Host } from "../lib/hosts-ipc";
import { accelLabel } from "../lib/shortcuts";
import { type Tab, useSessions } from "../store/sessions";

const GROUP_LABELS: Record<CommandGroupId, string> = {
  session: "Session",
  tabs: "Tabs",
  hosts: "Hosts",
  view: "View",
};
const GROUP_ORDER: CommandGroupId[] = ["session", "tabs", "hosts", "view"];

interface PaletteGroup {
  id: CommandGroupId;
  label: string;
  items: Cmd[];
}

/** What the palette matches against: title, keywords, and host subtitle. Base
 *  UI hands items back as `unknown`, so this narrows at the boundary. */
function searchable(item: unknown): string {
  const cmd = item as Cmd;
  return `${cmd.title} ${(cmd.keywords ?? []).join(" ")} ${cmd.subtitle ?? ""}`.trim();
}

export function CommandPalette({
  open,
  onOpenChange,
  hosts,
  ctx,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: Host[];
  ctx: CommandContext;
}) {
  const order = useSessions((s) => s.order);
  const byId = useSessions((s) => s.byId);

  const groups = useMemo<PaletteGroup[]>(() => {
    const tabs = order.map((id) => byId[id]).filter((t): t is Tab => Boolean(t));
    const all = paletteCommands(hosts, tabs);
    return GROUP_ORDER.map((id) => ({
      id,
      label: GROUP_LABELS[id],
      items: all.filter((c) => c.group === id),
    })).filter((group) => group.items.length > 0);
  }, [hosts, order, byId]);

  const run = (cmd: Cmd) => {
    onOpenChange(false);
    cmd.run(ctx);
  };

  return (
    <Command open={open} onOpenChange={onOpenChange}>
      <CommandDialog items={groups} itemToStringValue={searchable}>
        <CommandInput placeholder="Type a command or search hosts…" />
        <CommandList>
          {(group: PaletteGroup) => (
            <CommandGroup key={group.id} items={group.items}>
              <CommandGroupLabel>{group.label}</CommandGroupLabel>
              <CommandCollection>
                {(cmd: Cmd) => (
                  <CommandItem
                    key={cmd.id}
                    value={cmd}
                    onClick={() => run(cmd)}
                    shortcut={cmd.keybinding ? accelLabel(cmd.keybinding) : undefined}
                  >
                    {cmd.subtitle ? (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{cmd.title}</span>
                        <span className="truncate text-xs text-[var(--lilt-text-subtle)]">
                          {cmd.subtitle}
                        </span>
                      </span>
                    ) : (
                      cmd.title
                    )}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
        <CommandEmpty>
          {hosts.length === 0 ? "No commands or hosts." : "No matches."}
        </CommandEmpty>
      </CommandDialog>
    </Command>
  );
}
