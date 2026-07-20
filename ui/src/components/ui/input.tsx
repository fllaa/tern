import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "min-h-12 w-full rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-field)] px-4 text-base text-[var(--lilt-text)] outline-none transition-[border-color,background-color] placeholder:text-[var(--lilt-text-subtle)] hover:border-[var(--lilt-border-strong)] focus:border-[var(--lilt-focus)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--lilt-focus)_25%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--lilt-danger)]",
      className,
    )}
    {...props}
  />
);
