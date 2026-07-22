"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import type { ComponentProps } from "react";
import { CheckIcon, ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Select = (props: ComponentProps<typeof BaseSelect.Root>) => (
  <BaseSelect.Root {...props} />
);

export const SelectTrigger = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseSelect.Trigger>) => (
  <BaseSelect.Trigger
    className={cn(
      "flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-field)] px-4 text-base text-[var(--lilt-text)] outline-none transition-[border-color,background-color] select-none hover:border-[var(--lilt-border-strong)] focus-visible:border-[var(--lilt-focus)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--lilt-focus)_25%,transparent)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[invalid]:border-[var(--lilt-danger)]",
      className,
    )}
    {...props}
  >
    {children}
    <BaseSelect.Icon className="flex text-[var(--lilt-text-subtle)]">
      <ChevronIcon size={18} />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
);

export const SelectValue = ({
  className,
  ...props
}: ComponentProps<typeof BaseSelect.Value>) => (
  <BaseSelect.Value
    className={cn(
      "truncate data-[placeholder]:text-[var(--lilt-text-subtle)]",
      className,
    )}
    {...props}
  />
);

export const SelectContent = ({
  children,
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof BaseSelect.Positioner>) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner
      alignItemWithTrigger={false}
      className="z-50 select-none"
      sideOffset={sideOffset}
      {...props}
    >
      <BaseSelect.Popup
        className={cn(
          "max-h-[var(--available-height)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] p-1 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:translate-y-1 data-[starting-style]:scale-[0.985] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.985] data-[ending-style]:opacity-0",
          className,
        )}
      >
        <BaseSelect.List>{children}</BaseSelect.List>
      </BaseSelect.Popup>
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
);

export const SelectItem = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseSelect.Item>) => (
  <BaseSelect.Item
    className={cn(
      "grid min-h-10 cursor-default grid-cols-[1.125rem_1fr] items-center gap-2 rounded-[var(--radius-control-sm)] px-3 text-sm outline-none select-none data-[highlighted]:bg-[var(--lilt-surface-2)] data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  >
    <BaseSelect.ItemIndicator className="col-start-1 flex text-[var(--lilt-primary-text)]">
      <CheckIcon size={16} />
    </BaseSelect.ItemIndicator>
    <BaseSelect.ItemText className="col-start-2 truncate">{children}</BaseSelect.ItemText>
  </BaseSelect.Item>
);

export const SelectGroup = (props: ComponentProps<typeof BaseSelect.Group>) => (
  <BaseSelect.Group {...props} />
);

export const SelectGroupLabel = ({
  className,
  ...props
}: ComponentProps<typeof BaseSelect.GroupLabel>) => (
  <BaseSelect.GroupLabel
    className={cn(
      "px-3 py-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);
