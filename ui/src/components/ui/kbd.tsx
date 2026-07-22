import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Kbd = ({ className, ...props }: ComponentProps<"kbd">) => (
  <kbd
    className={cn(
      // font-mono is Tailwind's default mono stack — lilt defines no --font-mono.
      // The 2px bottom border gives keycap depth while staying a border, not a shadow.
      "inline-flex min-w-6 items-center justify-center rounded-[6px] border border-b-2 border-[var(--lilt-border)] bg-[var(--lilt-surface)] px-1.5 py-0.5 font-mono text-xs font-semibold text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);

export const KbdGroup = ({ className, ...props }: ComponentProps<"span">) => (
  <span className={cn("inline-flex items-center gap-1", className)} {...props} />
);
