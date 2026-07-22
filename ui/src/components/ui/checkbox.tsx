"use client";

import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import type { ComponentProps } from "react";
import { CheckIcon, MinusIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Checkbox = ({
  className,
  ...props
}: ComponentProps<typeof BaseCheckbox.Root>) => (
  <BaseCheckbox.Root
    className={cn(
      "group flex size-6 shrink-0 items-center justify-center rounded-lg border border-[var(--lilt-border-strong)] bg-[var(--lilt-field)] outline-none transition-colors duration-[var(--duration-fast)] data-[checked]:border-[var(--lilt-button)] data-[checked]:bg-[var(--lilt-button)] data-[indeterminate]:border-[var(--lilt-button)] data-[indeterminate]:bg-[var(--lilt-button)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  >
    <BaseCheckbox.Indicator className="flex text-[var(--lilt-button-text)] data-[unchecked]:hidden">
      <CheckIcon className="group-data-[indeterminate]:hidden" size={15} />
      <MinusIcon className="hidden group-data-[indeterminate]:block" size={15} />
    </BaseCheckbox.Indicator>
  </BaseCheckbox.Root>
);
