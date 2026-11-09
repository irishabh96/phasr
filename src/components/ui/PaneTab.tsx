import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pane tab (A-System "PANE TABS · 36px"): the active tab is a raised
 * folder-tab joined to the content below; inactive tabs are bare.
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
      "group/pane-tab relative flex shrink-0 items-center gap-2 rounded-t-(--radius-control) px-3 text-[12px]",
      "transition-colors duration-100",
      "focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
      active
        ? "-mb-px border border-b-0 border-(--color-border-subtle) bg-(--color-bg-base) text-(--color-text-primary)"
        : "border border-transparent text-(--color-text-muted) hover:text-(--color-text-secondary)",
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
