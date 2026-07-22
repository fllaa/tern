import type { LabelHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Label = ({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
  // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- passthrough primitive; callers supply htmlFor/id or wrap a control themselves
  <label
    className={cn("text-sm font-semibold text-[var(--lilt-text)]", className)}
    {...props}
  />
);
