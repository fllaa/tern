"use client";

import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { CheckIcon, ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const DropdownMenu = (props: ComponentProps<typeof Menu.Root>) => (
  <Menu.Root {...props} />
);

export const DropdownMenuTrigger = (props: ComponentProps<typeof Menu.Trigger>) => (
  <Menu.Trigger {...props} />
);

export const DropdownMenuContent = ({
  children,
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Menu.Positioner>) => (
  <Menu.Portal>
    <Menu.Positioner className="z-50" sideOffset={sideOffset} {...props}>
      <Menu.Popup
        className={cn(
          "min-w-48 origin-[var(--transform-origin)] rounded-[var(--radius-control)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] p-1 text-[var(--lilt-text)] outline-none transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-out)] data-[starting-style]:translate-y-1 data-[starting-style]:scale-[0.985] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.985] data-[ending-style]:opacity-0",
          className,
        )}
      >
        {children}
      </Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>
);

const menuItemClassName =
  "flex min-h-10 cursor-default items-center gap-2 rounded-[var(--radius-control-sm)] px-3 text-sm outline-none select-none data-[highlighted]:bg-[var(--lilt-surface-2)] data-[disabled]:opacity-45";

const dangerItemClassName =
  "text-[var(--lilt-danger-text)] data-[highlighted]:bg-[var(--lilt-danger-soft)]";

export interface DropdownMenuItemProps extends ComponentProps<typeof Menu.Item> {
  /** "danger" styles destructive actions in Lilt's muted brick red. */
  variant?: "default" | "danger";
}

export const DropdownMenuItem = ({
  className,
  variant = "default",
  ...props
}: DropdownMenuItemProps) => (
  <Menu.Item
    className={cn(
      menuItemClassName,
      variant === "danger" && dangerItemClassName,
      className,
    )}
    {...props}
  />
);

export const DropdownMenuCheckboxItem = ({
  children,
  className,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) => (
  <Menu.CheckboxItem
    className={cn(menuItemClassName, "grid grid-cols-[1.125rem_1fr] gap-2", className)}
    {...props}
  >
    <Menu.CheckboxItemIndicator className="col-start-1 flex text-[var(--lilt-primary-text)]">
      <CheckIcon size={16} />
    </Menu.CheckboxItemIndicator>
    <span className="col-start-2 truncate">{children}</span>
  </Menu.CheckboxItem>
);

export const DropdownMenuGroup = (props: ComponentProps<typeof Menu.Group>) => (
  <Menu.Group {...props} />
);

export const DropdownMenuGroupLabel = ({
  className,
  ...props
}: ComponentProps<typeof Menu.GroupLabel>) => (
  <Menu.GroupLabel
    className={cn(
      "px-3 py-2 font-display text-xs font-bold uppercase tracking-[0.15em] text-[var(--lilt-text-muted)]",
      className,
    )}
    {...props}
  />
);

export const DropdownMenuSeparator = ({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) => (
  <Menu.Separator
    className={cn("mx-2 my-1 h-px bg-[var(--lilt-border)]", className)}
    {...props}
  />
);

export const DropdownMenuSub = (props: ComponentProps<typeof Menu.SubmenuRoot>) => (
  <Menu.SubmenuRoot {...props} />
);

export const DropdownMenuSubTrigger = ({
  children,
  className,
  ...props
}: ComponentProps<typeof Menu.SubmenuTrigger>) => (
  <Menu.SubmenuTrigger
    className={cn(menuItemClassName, "justify-between", className)}
    {...props}
  >
    {children}
    <ChevronIcon className="-rotate-90 text-[var(--lilt-text-subtle)]" size={16} />
  </Menu.SubmenuTrigger>
);
