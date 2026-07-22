"use client";

import type { ComponentProps } from "react";
import { Separator as BaseSeparator, Group, Panel } from "react-resizable-panels";
import { GripIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A group of resizable panels laid out along one axis.
 *
 * Wraps react-resizable-panels v4 `Group` (renamed from `PanelGroup` in v4).
 * Use the `orientation` prop ("horizontal" | "vertical") — the v3 `direction`
 * prop was renamed in v4.
 */
export const ResizablePanelGroup = ({
  className,
  ...props
}: ComponentProps<typeof Group>) => (
  <Group className={cn("h-full w-full", className)} {...props} />
);

/**
 * A single resizable region inside a `ResizablePanelGroup`.
 *
 * Note: `className` lands on an INNER div that already fills the panel
 * (flex-grow: 1, overflow: auto), so flex/centering classes work directly.
 */
export const ResizablePanel = (props: ComponentProps<typeof Panel>) => (
  <Panel {...props} />
);

/**
 * The draggable separator between two panels.
 *
 * Wraps react-resizable-panels v4 `Separator` (renamed from
 * `PanelResizeHandle` in v4). The separator's `aria-orientation` is the
 * OPPOSITE of the group orientation: a horizontal group renders a vertical
 * 1px separator bar, and vice versa.
 */
export const ResizableHandle = ({
  className,
  withHandle,
  ...props
}: ComponentProps<typeof BaseSeparator> & { withHandle?: boolean }) => (
  <BaseSeparator
    className={cn(
      "group/handle relative flex shrink-0 items-center justify-center bg-[var(--lilt-border)] outline-none transition-colors duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)] aria-[orientation=vertical]:w-px aria-[orientation=horizontal]:h-px data-[separator=hover]:bg-[var(--lilt-border-strong)] data-[separator=active]:bg-[var(--lilt-focus)]",
      className,
    )}
    {...props}
  >
    {withHandle && (
      <span className="z-10 flex h-5 w-3.5 items-center justify-center rounded-[6px] border border-[var(--lilt-border)] bg-[var(--lilt-surface)] text-[var(--lilt-text-subtle)] group-aria-[orientation=horizontal]/handle:rotate-90">
        <GripIcon size={12} />
      </span>
    )}
  </BaseSeparator>
);
