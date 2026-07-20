"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Wrap your app (or a subtree) once so tooltips share timing. */
export const TooltipProvider = ({
  delay = 300,
  ...props
}: ComponentProps<typeof BaseTooltip.Provider>) => (
  <BaseTooltip.Provider delay={delay} {...props} />
);

export const Tooltip = (props: ComponentProps<typeof BaseTooltip.Root>) => (
  <BaseTooltip.Root {...props} />
);

export const TooltipTrigger = (props: ComponentProps<typeof BaseTooltip.Trigger>) => (
  <BaseTooltip.Trigger {...props} />
);

export const TooltipContent = ({
  children,
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof BaseTooltip.Positioner>) => (
  <BaseTooltip.Portal>
    <BaseTooltip.Positioner className="z-50" sideOffset={sideOffset} {...props}>
      <BaseTooltip.Popup
        className={cn(
          "origin-[var(--transform-origin)] rounded-[var(--radius-control-sm)] bg-[var(--lilt-button)] px-3 py-1.5 text-sm font-medium text-[var(--lilt-button-text)] outline-none transition-[opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] data-[starting-style]:scale-[0.985] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.985] data-[ending-style]:opacity-0",
          className,
        )}
      >
        {children}
      </BaseTooltip.Popup>
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
);
