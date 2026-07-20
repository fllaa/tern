import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const EmptyState = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--lilt-border)] bg-[var(--lilt-surface)] px-6 py-10 text-center",
      className,
    )}
    {...props}
  />
);

export const EmptyStateIcon = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    aria-hidden="true"
    className={cn(
      "mb-2 flex size-12 items-center justify-center rounded-full bg-[var(--lilt-primary-soft)] text-[var(--lilt-primary-text)]",
      className,
    )}
    {...props}
  />
);

export const EmptyStateTitle = ({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) => (
  // oxlint-disable-next-line jsx-a11y/heading-has-content -- passthrough primitive, callers supply children via props spread
  <h3
    className={cn("font-display text-lg font-semibold tracking-[-0.02em]", className)}
    {...props}
  />
);

export const EmptyStateDescription = ({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) => (
  <p
    className={cn(
      "max-w-[36ch] text-sm leading-relaxed text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);

export const EmptyStateActions = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("mt-4 flex flex-wrap items-center justify-center gap-3", className)}
    {...props}
  />
);
