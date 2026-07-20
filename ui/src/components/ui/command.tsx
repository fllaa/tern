"use client";

import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { SearchIcon } from "@/components/ui/icons";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export const Command = (props: ComponentProps<typeof BaseDialog.Root>) => (
  <BaseDialog.Root {...props} />
);

export const CommandTrigger = (props: ComponentProps<typeof BaseDialog.Trigger>) => (
  <BaseDialog.Trigger {...props} />
);

export type CommandDialogProps = ComponentProps<typeof BaseAutocomplete.Root> & {
  className?: string;
};

export const CommandDialog = ({ children, className, ...props }: CommandDialogProps) => (
  <BaseDialog.Portal>
    <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-[rgba(8,12,9,0.68)] backdrop-blur-[2px] transition-opacity duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
    <BaseDialog.Popup
      aria-label="Command palette"
      className={cn(
        "fixed top-[max(1rem,12vh)] left-1/2 z-50 flex max-h-[min(30rem,80vh)] w-[min(92vw,34rem)] flex-col overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--lilt-border)] bg-[var(--lilt-surface)] text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] [transform:translate(-50%,0)] data-[starting-style]:opacity-0 data-[starting-style]:[transform:translate(-50%,0.5rem)_scale(0.985)] data-[ending-style]:opacity-0 data-[ending-style]:[transform:translate(-50%,0.5rem)_scale(0.985)]",
        className,
      )}
    >
      {/* `open` is required alongside `inline`: the list renders in place
          (no portal/positioner) and stays mounted while the dialog is up. */}
      <BaseAutocomplete.Root autoHighlight="always" inline keepHighlight open {...props}>
        {children}
        <BaseDialog.Close className="sr-only">Close command palette</BaseDialog.Close>
      </BaseAutocomplete.Root>
    </BaseDialog.Popup>
  </BaseDialog.Portal>
);

export const CommandInput = ({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Input>) => (
  <div
    className={cn(
      "flex items-center gap-3 border-b border-[var(--lilt-border)] px-4",
      className,
    )}
  >
    <SearchIcon className="shrink-0 text-[var(--lilt-text-subtle)]" size={18} />
    {/* No focus ring — the palette panel itself is the affordance. */}
    <BaseAutocomplete.Input
      aria-label="Search commands"
      className="min-h-14 w-full bg-transparent text-base outline-none placeholder:text-[var(--lilt-text-subtle)]"
      placeholder="Type a command or search..."
      {...props}
    />
  </div>
);

export const CommandList = ({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.List>) => (
  <BaseAutocomplete.List
    className={cn(
      "max-h-full flex-1 overflow-y-auto overscroll-contain scroll-py-1 p-1 outline-none",
      className,
    )}
    {...props}
  />
);

export const CommandEmpty = ({
  children = "No commands found. Try a different word?",
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Empty>) => (
  <BaseAutocomplete.Empty
    className={cn("px-3 py-6 text-sm text-[var(--lilt-text-muted)] empty:p-0", className)}
    {...props}
  >
    {children}
  </BaseAutocomplete.Empty>
);

export const CommandGroup = (props: ComponentProps<typeof BaseAutocomplete.Group>) => (
  <BaseAutocomplete.Group {...props} />
);

export const CommandGroupLabel = ({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.GroupLabel>) => (
  <BaseAutocomplete.GroupLabel
    className={cn(
      "px-3 py-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);

export const CommandCollection = (
  props: ComponentProps<typeof BaseAutocomplete.Collection>,
) => <BaseAutocomplete.Collection {...props} />;

export interface CommandItemProps extends ComponentProps<typeof BaseAutocomplete.Item> {
  /** Keys rendered as a keyboard shortcut on the item's right edge. */
  shortcut?: string[];
}

// onClick fires for pointer clicks AND Enter on the highlighted item,
// so a single handler covers both activation paths.
export const CommandItem = ({
  children,
  className,
  shortcut,
  ...props
}: CommandItemProps) => (
  <BaseAutocomplete.Item
    className={cn(
      "flex min-h-10 cursor-default items-center justify-between gap-2 rounded-[var(--radius-control-sm)] px-3 text-sm outline-none select-none data-[highlighted]:bg-[var(--lilt-surface-2)] data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  >
    <span className="truncate">{children}</span>
    {shortcut ? (
      <KbdGroup className="shrink-0">
        {shortcut.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
    ) : null}
  </BaseAutocomplete.Item>
);

export const CommandSeparator = ({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Separator>) => (
  <BaseAutocomplete.Separator
    className={cn("mx-2 my-1 h-px bg-[var(--lilt-border)]", className)}
    {...props}
  />
);
