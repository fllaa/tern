"use client";

import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type { ComponentProps } from "react";
import { ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Collapsible = ({
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Root>) => (
  <BaseCollapsible.Root className={cn("flex flex-col", className)} {...props} />
);

export const CollapsibleTrigger = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Trigger>) => (
  <BaseCollapsible.Trigger
    className={cn(
      "group flex min-h-11 items-center gap-2 rounded-[var(--radius-control-sm)] text-left font-display text-base font-semibold tracking-[-0.01em] text-[var(--lilt-text)] outline-none transition-colors hover:text-[var(--lilt-primary-text)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)]",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronIcon
      className="shrink-0 text-[var(--lilt-text-subtle)] transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] group-data-[panel-open]:rotate-180"
      size={18}
    />
  </BaseCollapsible.Trigger>
);

export const CollapsiblePanel = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Panel>) => (
  <BaseCollapsible.Panel
    className={cn(
      "h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:h-0 data-[ending-style]:h-0",
      className,
    )}
    {...props}
  >
    <div className="pt-2 pb-1 text-sm leading-relaxed text-[var(--lilt-text-muted)]">
      {children}
    </div>
  </BaseCollapsible.Panel>
);
