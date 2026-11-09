import { cn } from "@/lib/utils";

/**
 * Task status as colour + dot + word (A-System "STATUS"). The word survives
 * colour-blindness and monochrome screenshots; the hue never changes with
 * the accent.
 */
export type TaskStatusKind =
  | "queued"
  | "draft"
  | "running"
  | "needs-you"
  | "review"
  | "done"
  | "failed"
  | "closed";

const META: Record<TaskStatusKind, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--color-status-queued)" },
  queued: { label: "Queued", color: "var(--color-status-queued)" },
  running: { label: "Running", color: "var(--color-status-running)" },
  "needs-you": { label: "Needs you", color: "var(--color-status-attention)" },
  review: { label: "Needs review", color: "var(--color-status-attention)" },
  done: { label: "Done", color: "var(--color-status-success)" },
  failed: { label: "Failed", color: "var(--color-status-danger)" },
  closed: { label: "Closed", color: "var(--color-status-queued)" },
};

export function statusColor(kind: TaskStatusKind): string {
  return META[kind].color;
}

/** 8px status dot. `halo` adds the 3px ring the design uses for live focus. */
export function StatusGlyph({
  kind,
  halo = false,
  size = 8,
  className,
}: {
  kind: TaskStatusKind;
  halo?: boolean;
  size?: 6 | 8;
  className?: string;
}) {
  const color = META[kind].color;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: halo ? `0 0 0 3px color-mix(in oklab, ${color} 22%, transparent)` : undefined,
      }}
    />
  );
}

export function StatusBadge({
  kind,
  label,
  halo,
  className,
}: {
  kind: TaskStatusKind;
  /** Override the word (e.g. "needs you 38s"). */
  label?: string;
  halo?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <StatusGlyph kind={kind} halo={halo ?? false} />
      <span>{label ?? META[kind].label}</span>
    </span>
  );
}
