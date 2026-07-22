"use client";

import { Separator as BaseSeparator } from "@base-ui/react/separator";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Separator = ({
  className,
  ...props
}: ComponentProps<typeof BaseSeparator>) => (
  <BaseSeparator
    className={cn(
      "shrink-0 bg-[var(--lilt-border)] data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
      className,
    )}
    {...props}
  />
);
