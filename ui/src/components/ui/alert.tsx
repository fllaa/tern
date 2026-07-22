import type { HTMLAttributes } from "react";
import { InfoIcon, SparkIcon, WarningIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const alertVariants = {
  danger: {
    className: "bg-[var(--lilt-danger-soft)]",
    icon: WarningIcon,
    iconClassName: "text-[var(--lilt-danger-text)]",
    role: "alert" as const,
  },
  info: {
    className: "bg-[var(--lilt-primary-soft)]",
    icon: InfoIcon,
    iconClassName: "text-[var(--lilt-primary-text)]",
    role: "status" as const,
  },
  success: {
    className: "bg-[var(--lilt-primary-soft)]",
    icon: SparkIcon,
    iconClassName: "text-[var(--lilt-primary-text)]",
    role: "status" as const,
  },
  warning: {
    className: "bg-[var(--lilt-warning)]",
    icon: WarningIcon,
    iconClassName: "text-[var(--lilt-text)]",
    role: "status" as const,
  },
};

export type AlertVariant = keyof typeof alertVariants;

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

export const Alert = ({
  children,
  className,
  variant = "info",
  ...props
}: AlertProps) => {
  const {
    className: variantClassName,
    icon: Icon,
    iconClassName,
    role,
  } = alertVariants[variant];
  return (
    <div
      className={cn(
        "flex gap-3 rounded-[var(--radius-card)] p-4 text-[var(--lilt-text)]",
        variantClassName,
        className,
      )}
      role={role}
      {...props}
    >
      <Icon className={cn("mt-0.5 shrink-0", iconClassName)} size={20} />
      <div className="grid gap-1">{children}</div>
    </div>
  );
};

export const AlertTitle = ({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm font-semibold tracking-[-0.01em]", className)} {...props} />
);

export const AlertDescription = ({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm leading-relaxed", className)} {...props} />
);
