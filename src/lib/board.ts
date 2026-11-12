import type { Workspace } from "@/lib/types";

/**
 * A task's lane: what it needs. The sidebar groups by lane; the board maps
 * lanes onto its four columns (`boardColumnFor`). Derived — no new status
 * values — so older synced clients keep parsing every row.
 *
 * Backend cards (`TaskCard.lane`) are mapped onto these in
 * `useBoardTasks`; `deriveTaskLane` is the fallback for a backend without
 * task cards (status + whether the worktree has changes).
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

/**
 * Board columns (A-Polish Main): Queued · Needs you · Running · Review.
 * Done is not a column (a "✓ N merged today · Show" line under Review), and
 * Failed has no column of its own: a failed task needs the user, so it sits
 * in Needs you with a red dot (A-States).
 */
export type BoardColumnId = "queued" | "needs-you" | "running" | "review";

export const BOARD_COLUMNS: readonly { id: BoardColumnId; title: string }[] = [
  { id: "queued", title: "Queued" },
  { id: "needs-you", title: "Needs you" },
  { id: "running", title: "Running" },
  { id: "review", title: "Review" },
];

/** Which column a lane lands in; `null` = off the board (done). */
export function boardColumnFor(lane: TaskLane): BoardColumnId | null {
  switch (lane) {
    case "queued":
      return "queued";
    case "needs-you":
    case "failed":
      return "needs-you";
    case "running":
      return "running";
    case "review":
      return "review";
    case "done":
      return null;
  }
}

/** When a done task finished, for "merged today": outcome, then archive, then exit. */
export function doneAt(ws: Pick<Workspace, "archivedAt" | "finishedAt" | "updatedAt" | "outcomeAt">): string {
  return ws.outcomeAt ?? ws.archivedAt ?? ws.finishedAt ?? ws.updatedAt;
}

type GroupableTask = {
  lane: TaskLane;
  workspace: Pick<Workspace, "agent" | "archivedAt" | "finishedAt" | "updatedAt" | "outcome" | "outcomeAt">;
};

export interface BoardGroups<T> {
  columns: Record<BoardColumnId, T[]>;
  /** Every done task after the agent filter, newest first (the List's done filter). */
  done: T[];
  /** Done tasks that finished today. */
  doneToday: number;
  /** …of which merged: the Review footer says "merged" only when they all were. */
  mergedToday: number;
}

/**
 * Split the board's tasks into its four columns, in one pass. Input order
 * is kept within a column, except that Needs you leads with the tasks
 * blocked on an answer and follows with the failed ones: an approval
 * unblocks an agent that is waiting right now.
 */
export function groupBoardTasks<T extends GroupableTask>(
  tasks: readonly T[],
  agentFilter: string | null,
  now: number,
): BoardGroups<T> {
  const columns: Record<BoardColumnId, T[]> = { queued: [], "needs-you": [], running: [], review: [] };
  const failed: T[] = [];
  const done: T[] = [];
  let doneToday = 0;
  let mergedToday = 0;
  for (const t of tasks) {
    if (agentFilter && t.workspace.agent !== agentFilter) continue;
    if (t.lane === "failed") {
      failed.push(t);
      continue;
    }
    const col = boardColumnFor(t.lane);
    if (col) {
      columns[col].push(t);
      continue;
    }
    done.push(t);
    if (isToday(doneAt(t.workspace), now)) {
      doneToday++;
      if (t.workspace.outcome === "merged") mergedToday++;
    }
  }
  for (const t of failed) columns["needs-you"].push(t);
  done.sort((a, b) => doneAt(b.workspace).localeCompare(doneAt(a.workspace)));
  return { columns, done, doneToday, mergedToday };
}

/** "✓ 2 merged today" / "3 done today" / "12 done" — `null` when nothing is done. */
export function doneSummary(g: Pick<BoardGroups<unknown>, "done" | "doneToday" | "mergedToday">): string | null {
  if (g.doneToday > 0) {
    return `${g.doneToday} ${g.mergedToday === g.doneToday ? "merged" : "done"} today`;
  }
  return g.done.length > 0 ? `${g.done.length} done` : null;
}

/** How many Done tasks the board keeps when none finished today. */
export const RECENT_DONE = 5;

/**
 * The board's tasks after the agent filter, with Done narrowed to "done
 * recently": finished today, or among the first `RECENT_DONE` Done tasks
 * (in board order). Linear: the recent set is built once, not an
 * `indexOf` scan per task.
 */
export function visibleBoardTasks<
  T extends { lane: string; workspace: Pick<Workspace, "agent" | "archivedAt" | "finishedAt" | "updatedAt"> },
>(tasks: readonly T[], agentFilter: string | null, now: number): T[] {
  const recentDone = new Set<T>();
  for (const t of tasks) {
    if (recentDone.size >= RECENT_DONE) break;
    if (t.lane === "done") recentDone.add(t);
  }
  return tasks.filter(
    (t) =>
      (!agentFilter || t.workspace.agent === agentFilter) &&
      (t.lane !== "done" ||
        recentDone.has(t) ||
        isToday(t.workspace.archivedAt ?? t.workspace.finishedAt ?? t.workspace.updatedAt, now)),
  );
}
