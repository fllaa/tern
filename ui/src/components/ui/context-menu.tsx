"use client";

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import type { ComponentProps } from "react";
import { CheckIcon, ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const ContextMenu = (props: ComponentProps<typeof BaseContextMenu.Root>) => (
  <BaseContextMenu.Root {...props} />
);

export const ContextMenuTrigger = ({
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.Trigger>) => (
  <BaseContextMenu.Trigger className={cn("select-none", className)} {...props} />
);

export const ContextMenuContent = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.Positioner>) => (
  <BaseContextMenu.Portal>
    <BaseContextMenu.Positioner className="z-50" {...props}>
      <BaseContextMenu.Popup
        className={cn(
          "min-w-48 origin-[var(--transform-origin)] rounded-[var(--radius-control)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] p-1 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:translate-y-1 data-[starting-style]:scale-[0.985] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.985] data-[ending-style]:opacity-0",
          className,
        )}
      >
        {children}
      </BaseContextMenu.Popup>
    </BaseContextMenu.Positioner>
  </BaseContextMenu.Portal>
);

const menuItemClassName =
  "flex min-h-10 cursor-default items-center gap-2 rounded-[var(--radius-control-sm)] px-3 text-sm outline-none select-none data-[highlighted]:bg-[var(--lilt-surface-2)] data-[disabled]:opacity-45";

const dangerItemClassName =
  "text-[var(--lilt-danger-text)] data-[highlighted]:bg-[var(--lilt-danger-soft)]";

export interface ContextMenuItemProps
  extends ComponentProps<typeof BaseContextMenu.Item> {
  /** "danger" styles destructive actions in Lilt's muted brick red. */
  variant?: "default" | "danger";
}

export const ContextMenuItem = ({
  className,
  variant = "default",
  ...props
}: ContextMenuItemProps) => (
  <BaseContextMenu.Item
    className={cn(
      menuItemClassName,
      variant === "danger" && dangerItemClassName,
      className,
    )}
    {...props}
  />
);

export const ContextMenuCheckboxItem = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.CheckboxItem>) => (
  <BaseContextMenu.CheckboxItem
    className={cn(menuItemClassName, "grid grid-cols-[1.125rem_1fr] gap-2", className)}
    {...props}
  >
    <BaseContextMenu.CheckboxItemIndicator className="col-start-1 flex text-[var(--lilt-primary-text)]">
      <CheckIcon size={16} />
    </BaseContextMenu.CheckboxItemIndicator>
    <span className="col-start-2 truncate">{children}</span>
  </BaseContextMenu.CheckboxItem>
);

export const ContextMenuGroup = (props: ComponentProps<typeof BaseContextMenu.Group>) => (
  <BaseContextMenu.Group {...props} />
);

export const ContextMenuGroupLabel = ({
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.GroupLabel>) => (
  <BaseContextMenu.GroupLabel
    className={cn(
      "px-3 py-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);

export const ContextMenuSeparator = ({
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.Separator>) => (
  <BaseContextMenu.Separator
    className={cn("mx-2 my-1 h-px bg-[var(--lilt-border)]", className)}
    {...props}
  />
);

export const ContextMenuSub = (
  props: ComponentProps<typeof BaseContextMenu.SubmenuRoot>,
) => <BaseContextMenu.SubmenuRoot {...props} />;

export const ContextMenuSubTrigger = ({
  children,
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.SubmenuTrigger>) => (
  <BaseContextMenu.SubmenuTrigger
    className={cn(menuItemClassName, "justify-between", className)}
    {...props}
  >
    {children}
    <ChevronIcon className="-rotate-90 text-[var(--lilt-text-subtle)]" size={16} />
  </BaseContextMenu.SubmenuTrigger>
);
