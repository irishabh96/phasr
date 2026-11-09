import type { BoardColumnId, TaskLane } from "@/lib/board";

/**
 * Board/List status words and dot colours (A-Polish): running blue, needs
 * you amber, review violet, done green, failed red, queued faint.
 */
export const LANE_META: Record<TaskLane, { label: string; color: string }> = {
  queued: { label: "Queued", color: "var(--color-status-queued)" },
  "needs-you": { label: "Needs you", color: "var(--color-status-attention)" },
  running: { label: "Running", color: "var(--color-status-running)" },
  review: { label: "Review", color: "var(--color-status-review)" },
  failed: { label: "Failed", color: "var(--color-status-danger)" },
  done: { label: "Done", color: "var(--color-status-success)" },
};

export const COLUMN_COLOR: Record<BoardColumnId, string> = {
  queued: LANE_META.queued.color,
  "needs-you": LANE_META["needs-you"].color,
  running: LANE_META.running.color,
  review: LANE_META.review.color,
};

/** P5: lists render every item up to this many, and only the visible window above it. */
export const VIRTUALIZE_ABOVE = 200;
