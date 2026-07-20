import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Skeleton = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "animate-pulse rounded-[var(--radius-control-sm)] bg-[var(--lilt-surface-2)]",
      className,
    )}
    {...props}
  />
);
