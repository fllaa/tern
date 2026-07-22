"use client";

import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Popover = (props: ComponentProps<typeof BasePopover.Root>) => (
  <BasePopover.Root {...props} />
);

export const PopoverTrigger = (props: ComponentProps<typeof BasePopover.Trigger>) => (
  <BasePopover.Trigger {...props} />
);

export const PopoverClose = (props: ComponentProps<typeof BasePopover.Close>) => (
  <BasePopover.Close {...props} />
);

export const PopoverContent = ({
  children,
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof BasePopover.Positioner>) => (
  <BasePopover.Portal>
    <BasePopover.Positioner className="z-50" sideOffset={sideOffset} {...props}>
      <BasePopover.Popup
        className={cn(
          "w-72 origin-[var(--transform-origin)] rounded-[var(--radius-control)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] p-4 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:translate-y-1 data-[starting-style]:scale-[0.985] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.985] data-[ending-style]:opacity-0",
          className,
        )}
      >
        {children}
      </BasePopover.Popup>
    </BasePopover.Positioner>
  </BasePopover.Portal>
);

export const PopoverTitle = ({
  className,
  ...props
}: ComponentProps<typeof BasePopover.Title>) => (
  <BasePopover.Title
    className={cn("font-display text-base font-semibold tracking-[-0.02em]", className)}
    {...props}
  />
);

export const PopoverDescription = ({
  className,
  ...props
}: ComponentProps<typeof BasePopover.Description>) => (
  <BasePopover.Description
    className={cn(
      "mt-1 text-sm leading-relaxed text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);
