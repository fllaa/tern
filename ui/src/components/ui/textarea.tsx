import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Textarea = ({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "min-h-24 w-full resize-y rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-field)] px-4 py-3 text-base leading-relaxed text-[var(--lilt-text)] outline-none transition-[border-color,background-color] placeholder:text-[var(--lilt-text-subtle)] hover:border-[var(--lilt-border-strong)] focus:border-[var(--lilt-focus)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--lilt-focus)_25%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--lilt-danger)]",
      className,
    )}
    {...props}
  />
);
