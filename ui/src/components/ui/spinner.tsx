import { cn } from "@/lib/utils";

export interface SpinnerProps {
  className?: string;
  /**
   * Announced to screen readers. Pass `null` when the surrounding context
   * already says what's loading (e.g. inside a labeled button).
   */
  label?: string | null;
  size?: number;
}

export const Spinner = ({ className, label = "Loading", size = 20 }: SpinnerProps) => (
  <span
    className={cn("inline-flex text-[var(--lilt-text-muted)]", className)}
    role={label === null ? undefined : "status"}
  >
    <svg
      aria-hidden="true"
      className="animate-spin"
      fill="none"
      height={size}
      stroke="currentColor"
      viewBox="0 0 24 24"
      width={size}
    >
      <path
        d="M12.1 3.8c4.5.05 8.2 3.75 8.1 8.3-.1 4.5-3.75 8.15-8.3 8.1-4.5-.05-8.15-3.7-8.1-8.3"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
    {label === null ? null : <span className="sr-only">{label}</span>}
  </span>
);
