"use client";

import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const AlertDialog = (props: ComponentProps<typeof BaseAlertDialog.Root>) => (
  <BaseAlertDialog.Root {...props} />
);

export const AlertDialogTrigger = (
  props: ComponentProps<typeof BaseAlertDialog.Trigger>,
) => <BaseAlertDialog.Trigger {...props} />;

export const AlertDialogClose = (props: ComponentProps<typeof BaseAlertDialog.Close>) => (
  <BaseAlertDialog.Close {...props} />
);

export const AlertDialogContent = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseAlertDialog.Popup>) => (
  <BaseAlertDialog.Portal>
    <BaseAlertDialog.Backdrop className="fixed inset-0 z-50 bg-[rgba(8,12,9,0.68)] backdrop-blur-[2px] transition-opacity duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
    <BaseAlertDialog.Popup
      className={cn(
        "fixed top-1/2 left-1/2 z-50 w-[min(92vw,32rem)] rounded-[var(--radius-dialog)] border border-[var(--lilt-border)] bg-[var(--lilt-surface)] p-6 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] [transform:translate(-50%,-50%)] data-[starting-style]:opacity-0 data-[starting-style]:[transform:translate(-50%,calc(-50%+0.5rem))_scale(0.985)] data-[ending-style]:opacity-0 data-[ending-style]:[transform:translate(-50%,calc(-50%+0.5rem))_scale(0.985)] sm:p-7",
        className,
      )}
      {...props}
    >
      {children}
    </BaseAlertDialog.Popup>
  </BaseAlertDialog.Portal>
);

export interface AlertDialogHeaderProps {
  children: ReactNode;
  className?: string;
  /** Lilt's small uppercase note above the title. */
  eyebrow?: ReactNode;
}

export const AlertDialogHeader = ({
  children,
  className,
  eyebrow = "Hold on a second",
}: AlertDialogHeaderProps) => (
  <div className={cn(className)}>
    {eyebrow ? (
      <p className="mb-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-primary-text)]">
        {eyebrow}
      </p>
    ) : null}
    {children}
  </div>
);

export const AlertDialogTitle = ({
  className,
  ...props
}: ComponentProps<typeof BaseAlertDialog.Title>) => (
  <BaseAlertDialog.Title
    className={cn("font-display text-2xl font-semibold tracking-[-0.035em]", className)}
    {...props}
  />
);

export const AlertDialogDescription = ({
  className,
  ...props
}: ComponentProps<typeof BaseAlertDialog.Description>) => (
  <BaseAlertDialog.Description
    className={cn("mt-3 max-w-[44ch] leading-7 text-[var(--lilt-text-muted)]", className)}
    {...props}
  />
);

export const AlertDialogFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("mt-6 flex flex-wrap items-center gap-3", className)} {...props} />
);
