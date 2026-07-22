// Quick-connect palette (Cmd/Ctrl+K).
//
// A thin host-picker over the vendored Command primitives: Base UI Autocomplete
// does the filtering (substring over name/hostname/user via itemToStringValue),
// and CommandItem's onClick fires for both a pointer click and Enter on the
// highlighted row, so one handler covers both ways to connect.

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

import type { Host } from "../lib/hosts-ipc";

/** What the palette matches against — every field someone might type. Base UI
 *  hands items back as `unknown`, so this narrows at the boundary. */
function searchable(item: unknown): string {
  const h = item as Host;
  return `${h.name} ${h.hostname} ${h.username}`.trim();
}

export function HostPalette({
  hosts,
  open,
  onOpenChange,
  onPick,
}: {
  hosts: Host[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (hostId: number) => void;
}) {
  const pick = (hostId: number) => {
    onOpenChange(false);
    onPick(hostId);
  };

  return (
    <Command open={open} onOpenChange={onOpenChange}>
      <CommandDialog items={hosts} itemToStringValue={searchable}>
        <CommandInput placeholder="Connect to a host…" />
        <CommandList>
          {(h: Host) => (
            <CommandItem key={h.id} value={h} onClick={() => pick(h.id)}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{h.name}</span>
                <span className="truncate text-xs text-[var(--lilt-text-subtle)]">
                  {h.username ? `${h.username}@` : ""}
                  {h.hostname}
                  {h.port !== 22 ? `:${h.port}` : ""}
                </span>
              </span>
            </CommandItem>
          )}
        </CommandList>
        <CommandEmpty>
          {hosts.length === 0 ? "No hosts yet." : "No hosts match."}
        </CommandEmpty>
      </CommandDialog>
    </Command>
  );
}
