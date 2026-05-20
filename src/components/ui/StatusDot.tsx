import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Status = "running" | "completed" | "failed" | "stopped" | "archived" | "pending";

type StatusDotProps = HTMLAttributes<HTMLSpanElement> & {
  status: Status;
  size?: "sm" | "md";
  /** Pulse the dot. Defaults to true for `running`. */
  pulse?: boolean;
};

const COLOR: Record<Status, string> = {
  running: "var(--color-info)",
  completed: "var(--color-success)",
  failed: "var(--color-danger)",
  stopped: "var(--color-text-muted)",
  archived: "var(--color-text-muted)",
  pending: "var(--color-warning)",
};

export function StatusDot({
  status,
  size = "sm",
  pulse,
  className,
  style,
  ...rest
}: StatusDotProps) {
  const shouldPulse = pulse ?? status === "running";
  const dim = size === "sm" ? 8 : 10;
  const composed: CSSProperties = {
    width: dim,
    height: dim,
    background: COLOR[status],
    ["--pulse-color" as string]: COLOR[status],
    animation: shouldPulse ? "pulse-dot 2s ease-in-out infinite" : undefined,
    ...style,
  };
  return (
    <span
      aria-label={status}
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={composed}
      {...rest}
    />
  );
}
