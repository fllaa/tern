import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = {
  danger:
    "border-transparent bg-[var(--lilt-danger-soft)] text-[var(--lilt-danger-text)]",
  default:
    "border-transparent bg-[var(--lilt-primary-soft)] text-[var(--lilt-primary-text)]",
  highlight: "border-transparent bg-[var(--lilt-highlight)] text-[var(--lilt-text)]",
  outline:
    "border-[var(--lilt-border-strong)] bg-transparent text-[var(--lilt-text-muted)]",
  warning: "border-transparent bg-[var(--lilt-warning)] text-[var(--lilt-text)]",
};

export type BadgeVariant = keyof typeof badgeVariants;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = ({ className, variant = "default", ...props }: BadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold",
      badgeVariants[variant],
      className,
    )}
    {...props}
  />
);
