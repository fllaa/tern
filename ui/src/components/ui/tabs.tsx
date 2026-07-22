"use client";

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const Tabs = ({ className, ...props }: ComponentProps<typeof BaseTabs.Root>) => (
  <BaseTabs.Root className={cn("flex flex-col gap-4", className)} {...props} />
);

export const TabsList = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseTabs.List> & { children?: ReactNode }) => (
  <BaseTabs.List
    className={cn(
      "relative isolate flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-[var(--lilt-border)] bg-[var(--lilt-surface)] p-1",
      className,
    )}
    {...props}
  >
    {children}
    <BaseTabs.Indicator className="absolute top-0 left-0 -z-1 h-[var(--active-tab-height)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] translate-y-[var(--active-tab-top)] rounded-full bg-[var(--lilt-button)] transition-[translate,width,height] duration-[var(--duration-base)] ease-[var(--ease-out)]" />
  </BaseTabs.List>
);

export const TabsTab = ({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) => (
  <BaseTabs.Tab
    className={cn(
      "inline-flex min-h-10 shrink-0 items-center rounded-full px-4 text-sm font-semibold text-[var(--lilt-text-muted)] outline-none transition-colors duration-[var(--duration-base)] ease-[var(--ease-out)] not-data-[active]:hover:bg-[var(--lilt-surface-2)] not-data-[active]:hover:text-[var(--lilt-text)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] data-[active]:text-[var(--lilt-button-text)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  />
);

export const TabsPanel = ({
  className,
  ...props
}: ComponentProps<typeof BaseTabs.Panel>) => (
  <BaseTabs.Panel
    className={cn(
      "rounded-[var(--radius-control-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)]",
      className,
    )}
    {...props}
  />
);
