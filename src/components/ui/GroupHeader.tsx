import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Group header (A-Polish rule 3): sentence case, 12px, muted, weight 500,
 * no caps or tracking. The optional count is Inter with tabular figures
 * (mono is for code, paths and branches only).
 */
export function GroupHeader({
  children,
  count,
  action,
  className,
  as: Tag = "div",
  id,
}: {
  children: ReactNode;
  count?: number | string;
  action?: ReactNode;
  className?: string;
  as?: "div" | "h2" | "h3";
  id?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Tag id={id} className="group-header m-0">
        {children}
      </Tag>
      {count !== undefined ? (
        <span className="text-[12px] tabular-nums text-(--color-text-muted)">{count}</span>
      ) : null}
      {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
    </div>
  );
}
