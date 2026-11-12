import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pane tab (A-Polish rule 8): tabs are underlines. Active = a 2px underline
 * in the text colour that sits on the bar's bottom divider (-mb-px), text
 * primary, weight 500. Inactive = text-2, no box, no notch.
 */
export const PaneTab = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    active: boolean;
    icon?: ReactNode;
    trailing?: ReactNode;
  }
>(({ active, icon, trailing, className, children, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    role="tab"
    aria-selected={active}
    className={cn(
      "group/pane-tab relative -mb-px flex shrink-0 items-center gap-2 border-0 border-b-2 bg-transparent px-2.5 text-[13px]",
      "transition-[color,border-color] duration-(--dur-1) ease-(--ease-out)",
      "focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
      active
        ? "border-(--color-text-primary) font-medium text-(--color-text-primary)"
        : "border-transparent text-(--color-text-secondary) hover:text-(--color-text-primary)",
      className,
    )}
    {...rest}
  >
    {icon}
    {children}
    {trailing}
  </button>
));
PaneTab.displayName = "PaneTab";
