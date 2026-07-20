"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Dialog = (props: ComponentProps<typeof BaseDialog.Root>) => (
  <BaseDialog.Root {...props} />
);

export const DialogTrigger = (props: ComponentProps<typeof BaseDialog.Trigger>) => (
  <BaseDialog.Trigger {...props} />
);

export const DialogClose = (props: ComponentProps<typeof BaseDialog.Close>) => (
  <BaseDialog.Close {...props} />
);

export const DialogContent = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Popup>) => (
  <BaseDialog.Portal>
    <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-[rgba(8,12,9,0.68)] backdrop-blur-[2px] transition-opacity duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
    <BaseDialog.Popup
      className={cn(
        "fixed top-1/2 left-1/2 z-50 w-[min(92vw,32rem)] rounded-[var(--radius-dialog)] border border-[var(--lilt-border)] bg-[var(--lilt-surface)] p-6 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] [transform:translate(-50%,-50%)] data-[starting-style]:opacity-0 data-[starting-style]:[transform:translate(-50%,calc(-50%+0.5rem))_scale(0.985)] data-[ending-style]:opacity-0 data-[ending-style]:[transform:translate(-50%,calc(-50%+0.5rem))_scale(0.985)] sm:p-7",
        className,
      )}
      {...props}
    >
      {children}
    </BaseDialog.Popup>
  </BaseDialog.Portal>
);

export interface DialogHeaderProps {
  children: ReactNode;
  className?: string;
  /** Lilt's small uppercase note above the title. */
  eyebrow?: ReactNode;
  /** Set false to hide the built-in close button. */
  showClose?: boolean;
}

export const DialogHeader = ({
  children,
  className,
  // Vendored change: Lilt defaults this to a whimsical string that renders on
  // every dialog. An SSH client's host-key warning cannot open with it, so the
  // default is off and callers opt in.
  eyebrow = null,
  showClose = true,
}: DialogHeaderProps) => (
  <div className={cn("flex items-start justify-between gap-6", className)}>
    <div>
      {eyebrow ? (
        <p className="mb-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-primary-text)]">
          {eyebrow}
        </p>
      ) : null}
      {children}
    </div>
    {showClose ? (
      <BaseDialog.Close
        aria-label="Close dialog"
        className="inline-flex aspect-square min-h-10 items-center justify-center rounded-[var(--radius-control-sm)] border border-[var(--lilt-border-strong)] bg-transparent text-[var(--lilt-text)] outline-none transition-[background-color] duration-[var(--duration-fast)] hover:bg-[var(--lilt-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-surface)]"
      >
        <CloseIcon size={18} />
      </BaseDialog.Close>
    ) : null}
  </div>
);

export const DialogTitle = ({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Title>) => (
  <BaseDialog.Title
    className={cn("font-display text-2xl font-semibold tracking-[-0.035em]", className)}
    {...props}
  />
);

export const DialogDescription = ({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Description>) => (
  <BaseDialog.Description
    className={cn("mt-3 max-w-[44ch] leading-7 text-[var(--lilt-text-muted)]", className)}
    {...props}
  />
);

export const DialogFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("mt-6 flex flex-wrap items-center gap-3", className)} {...props} />
);
