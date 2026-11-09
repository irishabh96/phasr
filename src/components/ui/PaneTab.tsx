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

/** The 36px strip that holds pane tabs (bg = sidebar tone, hairline below). */
export function PaneTabStrip({
  children,
  actions,
  label,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-(--layout-panetabs-height) shrink-0 items-stretch gap-0.5 border-b border-(--color-border-subtle) bg-(--color-bg-sidebar) px-2 pt-1",
        className,
      )}
    >
      <div role="tablist" aria-label={label} className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto">
        {children}
      </div>
      {actions ? <div className="ml-auto flex items-center gap-1.5 pb-1 pl-2">{actions}</div> : null}
    </div>
  );
}
