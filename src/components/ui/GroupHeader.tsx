import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 11/600 caps group header with optional mono count and trailing action. */
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
        <span className="font-mono text-[11px] text-(--color-text-muted)">{count}</span>
      ) : null}
      {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
    </div>
  );
}
