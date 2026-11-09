import type { Workspace } from "@/lib/types";

/**
 * Board lane for a task (A: Queued / Running / Needs review / Done, plus a
 * Failed group). Derived — no new status values — so older synced clients
 * keep parsing every row.
 *
 * Interim derivation from what the frontend can see today: the workspace
 * status plus whether its worktree has changes. The backend `derive_lane`
 * (task cards) replaces this once it lands; the column names stay.
 */
export type TaskLane = "queued" | "running" | "needs-you" | "review" | "failed" | "done";

export interface LaneSignals {
  /** Files changed in the worktree; undefined while unknown. */
  changedFiles?: number;
  /** The agent is blocked on the user (approval or question). */
  needsYou?: boolean;
}

export function deriveTaskLane(ws: Workspace, signals: LaneSignals = {}): TaskLane | null {
  if (ws.workspaceKind === "local") return null;
  switch (ws.status) {
    case "pending":
      return "queued";
    case "running":
      return signals.needsYou ? "needs-you" : "running";
    case "failed":
      return "failed";
    case "archived":
      return "done";
    case "stopped":
    case "completed":
      // Unknown change count reads as review: hiding finished work the user
      // has not looked at is the worse failure than one extra review card.
      return signals.changedFiles === 0 ? "done" : "review";
  }
}

/** Sidebar/board group order. */
export const LANE_ORDER: TaskLane[] = ["needs-you", "running", "review", "failed", "queued", "done"];

/** Compact elapsed time: "38s", "4m 12s", "21m", "2h 5m", "3d". */
export function formatElapsed(fromIso: string | null | undefined, now: number): string | null {
  if (!fromIso) return null;
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) return null;
  const s = Math.max(0, Math.floor((now - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${s % 60}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** "18m ago", "1h ago", "yesterday". */
export function formatAgo(iso: string | null | undefined, now: number): string | null {
  const e = formatElapsed(iso, now);
  if (!e) return null;
  if (e.endsWith("s") && !e.includes("m")) return "just now";
  if (e.endsWith("d")) return e === "1d" ? "yesterday" : `${e.slice(0, -1)} days ago`;
  return `${e.split(" ")[0]} ago`;
}

export function isToday(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date(now);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
