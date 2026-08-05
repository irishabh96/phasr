import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Panel tab strip with a right-hand action slot. Contextual actions live
 * in the header (Linear's model), which is why the notes composer costs
 * zero vertical space in the panel body.
 */
export function PanelTabBar({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-(--color-border-subtle) px-2">
      {children}
      {actions ? (
        <div className="ml-auto flex items-center gap-0.5">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * Tab button for panel tab strips (right rail, repo-home rail).
 * Promoted from WorkspaceRightSidebar so both rails share one look:
 * 12px label, plain secondary-numeral count (never a coral pill),
 * 2px accent underline on the active tab.
 */
export function PanelTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-7 items-center gap-1.5 px-2 text-[12px]",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
        active
          ? "font-medium text-(--color-text-primary)"
          : "text-(--color-text-muted) hover:text-(--color-text-secondary)",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="text-(--color-text-secondary)">{count}</span>
      )}
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-(--color-accent-500)"
        />
      )}
    </button>
  );
}
