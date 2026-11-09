import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { deriveTaskLane, type TaskLane } from "@/lib/board";
import { useAllWorkspaces } from "@/lib/hooks/useAllWorkspaces";
import { gitKeys } from "@/lib/hooks/useGit";
import { tauri } from "@/lib/tauri";
import { useAgentStates } from "@/lib/hooks/useAgentSignals";
import { useTaskCards } from "@/lib/hooks/useTaskCards";
import type { Attention, BoardLane, Repository, TaskCard, Workspace } from "@/lib/types";

export interface BoardTask {
  workspace: Workspace;
  repository: Repository | null;
  lane: TaskLane;
  /** Uncommitted-change totals for finished tasks; null when unknown. */
  diff: { files: number; adds: number; removes: number } | null;
  /** What the agent is doing right now ("Editing src/x.ts"); running only. */
  activity: string | null;
  /** The dialog the agent is blocked on (lane needs-you). */
  attention: Attention | null;
  /** When it stopped working ("finished 18m ago"); backend cards only. */
  finishedAt: string | null;
  /** A queued task's dependency name ("waits for tauri-v2"). */
  dependsOnName: string | null;
  /** Never started (draft or queued) — "Start now" applies. */
  notStarted: boolean;
}

/** Backend lanes → the board's columns. Draft and queued share Queued; archived folds into Done. */
const LANE_FROM_BACKEND: Record<BoardLane, TaskLane> = {
  draft: "queued",
  queued: "queued",
  running: "running",
  "needs-you": "needs-you",
  "needs-review": "review",
  failed: "failed",
  done: "done",
  archived: "done",
};

function fromCard(card: TaskCard, repository: Repository | null): BoardTask {
  const st = card.agentState;
  return {
    workspace: card.workspace,
    repository,
    lane: LANE_FROM_BACKEND[card.lane],
    diff: card.diff,
    // "running" also covers a task whose worktree is still being set up
    // (status pending; the backend reports "Setting up the worktree…").
    activity:
      card.workspace.status === "running" || card.lane === "running" ? (st?.lastActivity ?? null) : null,
    attention: st?.state === "needs-you" ? (st.attention ?? null) : null,
    finishedAt: card.finishedAt,
    dependsOnName: card.dependsOnName,
    // A queued task that gave up after repeated failed starts is "failed"
    // with no branch: it never ran, so it keeps the Start now card.
    notStarted:
      card.lane === "draft" ||
      card.lane === "queued" ||
      (card.lane === "failed" && !card.workspace.branch && !card.workspace.worktreePath),
  };
}

function sameDiff(a: BoardTask["diff"], b: BoardTask["diff"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.files === b.files && a.adds === b.adds && a.removes === b.removes;
}

/** Shallow: every `Attention` field is a primitive. */
function sameAttention(a: Attention | null, b: Attention | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof Attention)[];
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

/** Field-wise equality of two derived rows — what a memoised row renders from. */
export function sameBoardTask(a: BoardTask, b: BoardTask): boolean {
  return (
    a.workspace === b.workspace &&
    a.repository === b.repository &&
    a.lane === b.lane &&
    sameDiff(a.diff, b.diff) &&
    a.activity === b.activity &&
    sameAttention(a.attention, b.attention) &&
    a.finishedAt === b.finishedAt &&
    a.dependsOnName === b.dependsOnName &&
    a.notStarted === b.notStarted
  );
}

/**
 * Keep the previous object for every row that did not change.
 *
 * Every derivation below builds fresh `BoardTask`s, so without this an
 * agent event for task A handed EVERY row a new `task` prop and defeated
 * `memo` on the sidebar's `TaskRow` and the board's `TaskCard` — one
 * tool call re-rendered the whole list. Pure; exported for tests.
 */
export function stabilizeBoardTasks(
  previous: ReadonlyMap<string, BoardTask>,
  next: BoardTask[],
): BoardTask[] {
  return next.map((t) => {
    const prev = previous.get(t.workspace.id);
    return prev && sameBoardTask(prev, t) ? prev : t;
  });
}

/** Statuses whose worktree diff decides review-vs-done. */
const NEEDS_DIFF = new Set(["stopped", "completed"]);

/**
 * Every agent task across repositories with its board lane. The in-place
 * `local` workspace of each repo is returned separately (`localWorkspaces`)
 * because it is not a task.
 */
export function useBoardTasks(repoFilter: string | null = null) {
  const { repositories, workspaces, isLoading } = useAllWorkspaces();
  const { data: agentStates } = useAgentStates();
  // Authoritative lanes (diff vs base, outcomes, queue) from the backend.
  // `null`/missing (older backend, test harness) falls back to deriving
  // lanes here from status + uncommitted changes.
  const cards = useTaskCards(null);
  const haveCards = Array.isArray(cards.data);
  // Per-task `git status` only for the fallback — backend cards carry the diff.
  const candidates = haveCards ? [] : workspaces.filter(
    (w) => w.workspaceKind === "agent" && NEEDS_DIFF.has(w.status) && !!w.worktreePath,
  );
  const statuses = useQueries({
    queries: candidates.map((w) => ({
      queryKey: gitKeys.status(w.id),
      queryFn: () => tauri.gitStatus(w.id),
      staleTime: 15_000,
      retry: false,
    })),
  });
  const statusKey = statuses.map((s) => s.dataUpdatedAt).join(",");

  const derived = useMemo(() => {
    const repoById = new Map(repositories.map((r) => [r.id, r]));
    const diffById = new Map<string, BoardTask["diff"]>();
    candidates.forEach((w, i) => {
      const files = statuses[i]?.data;
      if (!files) return;
      diffById.set(w.id, {
        files: files.length,
        adds: files.reduce((n, f) => n + (f.adds ?? 0), 0),
        removes: files.reduce((n, f) => n + (f.removes ?? 0), 0),
      });
    });
    const stateById = new Map((agentStates ?? []).map((st) => [st.taskId, st]));
    if (Array.isArray(cards.data)) {
      const tasks = cards.data
        .filter((c) => !repoFilter || c.workspace.repositoryId === repoFilter)
        .map((c) => fromCard(c, repoById.get(c.workspace.repositoryId) ?? null));
      const localWorkspaces = workspaces.filter(
        (w) => w.workspaceKind === "local" && (!repoFilter || w.repositoryId === repoFilter),
      );
      tasks.sort((a, b) =>
        (b.workspace.startedAt ?? b.workspace.createdAt).localeCompare(a.workspace.startedAt ?? a.workspace.createdAt),
      );
      return { tasks, localWorkspaces, repositories, isLoading: isLoading || cards.isLoading };
    }
    const tasks: BoardTask[] = [];
    const localWorkspaces: Workspace[] = [];
    for (const w of workspaces) {
      if (repoFilter && w.repositoryId !== repoFilter) continue;
      if (w.workspaceKind === "local") {
        localWorkspaces.push(w);
        continue;
      }
      const diff = diffById.get(w.id) ?? null;
      const st = stateById.get(w.id);
      const needsYou = st?.state === "needs-you";
      const lane = deriveTaskLane(w, { ...(diff ? { changedFiles: diff.files } : {}), needsYou });
      if (!lane) continue;
      tasks.push({
        workspace: w,
        repository: repoById.get(w.repositoryId) ?? null,
        lane,
        diff,
        activity: w.status === "running" ? (st?.lastActivity ?? null) : null,
        attention: needsYou ? (st?.attention ?? null) : null,
        finishedAt: w.finishedAt,
        dependsOnName: null,
        notStarted: w.status === "pending",
      });
    }
    tasks.sort((a, b) =>
      (b.workspace.startedAt ?? b.workspace.createdAt).localeCompare(a.workspace.startedAt ?? a.workspace.createdAt),
    );
    return { tasks, localWorkspaces, repositories, isLoading };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, repositories, statusKey, repoFilter, isLoading, agentStates, cards.data, cards.isLoading]);

  // Row identity across derivations — see `stabilizeBoardTasks`. Written
  // during render, but idempotent: the same `derived` always stabilises to
  // the same rows, so a discarded or doubled render cannot skew it.
  const previous = useRef<{ list: BoardTask[]; byId: Map<string, BoardTask> }>({
    list: [],
    byId: new Map(),
  });
  return useMemo(() => {
    const prev = previous.current;
    let tasks = stabilizeBoardTasks(prev.byId, derived.tasks);
    if (tasks.length === prev.list.length && tasks.every((t, i) => t === prev.list[i])) {
      tasks = prev.list;
    } else {
      previous.current = { list: tasks, byId: new Map(tasks.map((t) => [t.workspace.id, t])) };
    }
    return { ...derived, tasks };
  }, [derived]);
}
