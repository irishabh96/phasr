import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Status =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "archived"
  | "pending";

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
    ...style,
  };
  return (
    <span
      aria-label={status}
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={composed}
      {...rest}
    >
      {shouldPulse && (
        // The ripple is a child ring animating transform+opacity (composited)
        // rather than an animated box-shadow on the dot itself, which would
        // cost a main-thread style resolve + repaint every frame, forever.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background: COLOR[status],
            animation: "pulse-ring 2s ease-in-out infinite",
          }}
        />
      )}
    </span>
  );
}
