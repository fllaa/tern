"use client";

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Switch = ({
  className,
  ...props
}: ComponentProps<typeof BaseSwitch.Root>) => (
  <BaseSwitch.Root
    className={cn(
      "inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-[var(--lilt-border)] bg-[var(--lilt-surface-2)] p-0.5 outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] data-[checked]:border-transparent data-[checked]:bg-[var(--lilt-primary)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  >
    <BaseSwitch.Thumb className="aspect-square h-full rounded-full border border-[var(--lilt-border)] bg-[var(--lilt-surface)] transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] data-[checked]:translate-x-5" />
  </BaseSwitch.Root>
);
