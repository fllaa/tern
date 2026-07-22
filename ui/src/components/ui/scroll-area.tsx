"use client";

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const ScrollBar = ({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof BaseScrollArea.Scrollbar>) => (
  <BaseScrollArea.Scrollbar
    className={cn(
      "pointer-events-none flex touch-none p-0.5 opacity-0 transition-opacity duration-[var(--duration-base)] select-none data-[hovering]:pointer-events-auto data-[hovering]:opacity-100 data-[scrolling]:pointer-events-auto data-[scrolling]:opacity-100 data-[scrolling]:transition-none data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:w-2.5",
      className,
    )}
    orientation={orientation}
    {...props}
  >
    <BaseScrollArea.Thumb className="flex-1 rounded-full bg-[var(--lilt-border-strong)]" />
  </BaseScrollArea.Scrollbar>
);

export const ScrollArea = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseScrollArea.Root>) => (
  <BaseScrollArea.Root className={cn("relative overflow-hidden", className)} {...props}>
    <BaseScrollArea.Viewport className="size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)]">
      <BaseScrollArea.Content>{children}</BaseScrollArea.Content>
    </BaseScrollArea.Viewport>
    <ScrollBar />
    <BaseScrollArea.Corner />
  </BaseScrollArea.Root>
);
