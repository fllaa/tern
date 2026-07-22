"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { ArrowIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const buttonVariants = {
  danger:
    "border-transparent bg-[var(--lilt-danger-soft)] text-[var(--lilt-danger-text)] hover:bg-[var(--lilt-danger-soft-hover)]",
  primary:
    "border-[var(--lilt-button-border)] bg-[var(--lilt-button)] text-[var(--lilt-button-text)] hover:bg-[var(--lilt-button-hover)]",
  secondary:
    "border-[var(--lilt-border-strong)] bg-transparent text-[var(--lilt-text)] hover:bg-[var(--lilt-surface-2)]",
  soft: "border-transparent bg-[var(--lilt-primary-soft)] text-[var(--lilt-primary-text)] hover:bg-[var(--lilt-primary-tint)] hover:text-[var(--lilt-selection-text)]",
};

const buttonSizes = {
  lg: "min-h-14 rounded-full px-6 text-base",
  md: "min-h-12 rounded-full px-5 text-base",
  sm: "min-h-10 rounded-[var(--radius-control-sm)] px-4 text-sm",
};

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  /** "arrow" renders Lilt's hand-drawn arrow that nudges on hover. */
  icon?: "arrow" | ReactNode;
  iconOnly?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export const Button = ({
  children,
  className,
  icon,
  iconOnly = false,
  render,
  size = "md",
  variant = "primary",
  ...props
}: ButtonProps) =>
  useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        children: (
          <>
            {children}
            {icon === "arrow" ? (
              <ArrowIcon
                className="transition-transform group-hover:translate-x-0.5"
                size={19}
              />
            ) : (
              icon
            )}
          </>
        ),
        className: cn(
          "group inline-flex items-center justify-center gap-2 border font-semibold tracking-[-0.01em] outline-none transition-[transform,background-color,color,border-color] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--lilt-canvas)] active:translate-y-0 disabled:pointer-events-none disabled:opacity-45",
          buttonVariants[variant],
          buttonSizes[size],
          iconOnly && "aspect-square px-0",
          className,
        ),
        type: render ? undefined : "button",
      },
      props,
    ),
    render,
  });
