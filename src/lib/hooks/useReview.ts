import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CHECK_OUTPUT_EVENT,
  CHECK_RUN_EVENT,
  RUN_COMMAND_STATE_EVENT,
  TASK_CARDS_CHANGED_EVENT,
} from "@/lib/events";
import { createKeyedCoalescer } from "@/lib/coalesce";
import { taskCardKeys } from "@/lib/hooks/useTaskCards";
import { runningIn } from "@/lib/runScope";
import {
  tauri,
  type ApproveInput,
  type CreateReviewCommentInput,
  type UpdateReviewCommentInput,
} from "@/lib/tauri";
import type {
  CheckOutputPayload,
  CheckRun,
  CheckSummary,
  RunningCommand,
} from "@/lib/types";

/**
 * Review (M8): checks, the task's diff vs its base, diff comments sent to
 * the agent, closing the task out, and run commands per task worktree.
 *
 * Freshness without polling:
 * - `phasr://check-run` patches the run into its task's `CheckSummary` and
 *   refetches it (the gate / staleness are computed by the backend).
 * - `phasr://check-output` appends to an open `useCheckOutput` view.
 * - `phasr://task-cards-changed` (files / lanes moved) refetches mounted
 *   summaries and file lists — that's when staleness can change.
 * - `phasr://run-command-state` upserts `useRunningCommands`.
 */

export const reviewKeys = {
  all: ["review"] as const,
  checks: (workspaceId: string) => [...reviewKeys.all, "checks", workspaceId] as const,
  checkOutput: (checkRunId: string) => [...reviewKeys.all, "check-output", checkRunId] as const,
  files: (workspaceId: string) => [...reviewKeys.all, "files", workspaceId] as const,
  comments: (workspaceId: string) => [...reviewKeys.all, "comments", workspaceId] as const,
  running: (workspaceId: string | null) =>
    [...reviewKeys.all, "running", workspaceId ?? "*"] as const,
  detectedScripts: (repositoryId: string) =>
    [...reviewKeys.all, "detected-scripts", repositoryId] as const,
};

/** Replace (or add) a run in a summary's `runs`, keyed by run command. Pure; exported for tests. */
export function upsertCheckRun(
  summary: CheckSummary | undefined,
  run: CheckRun,
): CheckSummary | undefined {
  if (!summary) return summary;
  const i = summary.runs.findIndex(
    (r) => r.id === run.id || (run.runCommandId !== null && r.runCommandId === run.runCommandId),
  );
  const runs = summary.runs.slice();
  if (i === -1) runs.push(run);
  else runs[i] = run;
  return { ...summary, runs };
}

/** Replace (or add) one running command by (runCommandId, workspaceId). Pure. */
export function upsertRunningCommand(
  list: RunningCommand[] | undefined,
  next: RunningCommand,
): RunningCommand[] {
  const prev = list ?? [];
  const i = prev.findIndex(
    (r) => r.runCommandId === next.runCommandId && r.workspaceId === next.workspaceId,
  );
  if (i === -1) return [...prev, next];
  const copy = prev.slice();
  copy[i] = next;
  return copy;
}

/** Subscribe helper: run `register` once, tear every listener down on unmount. */
function useTauriListeners(
  register: (keep: (unlisten: () => void) => void) => void,
  deps: unknown[],
) {
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };
    register(keep);
    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
    // `register` is a fresh closure every render; `deps` says when it
    // actually changes.
  }, deps);
}

/** Check-run + task-change events → summaries and file lists. Idempotent if mounted twice. */
export function useCheckEvents() {
  const queryClient = useQueryClient();
  useTauriListeners(
    (keep) => {
      void listen<CheckRun>(CHECK_RUN_EVENT, (event) => {
        const run = event.payload;
        const key = reviewKeys.checks(run.workspaceId);
        queryClient.setQueryData<CheckSummary>(key, (prev) => upsertCheckRun(prev, run));
        // Settled runs move the gate; the backend owns that computation.
        if (run.status !== "queued" && run.status !== "running") {
          queryClient.invalidateQueries({ queryKey: key });
          queryClient.invalidateQueries({ queryKey: reviewKeys.checkOutput(run.id) });
        }
      }).then(keep);
      void listen<CheckOutputPayload>(CHECK_OUTPUT_EVENT, (event) => {
        const { checkRunId, chunk } = event.payload;
        // Only views that are open (have data) get appended to.
        queryClient.setQueryData<string>(reviewKeys.checkOutput(checkRunId), (prev) =>
          prev === undefined ? prev : prev + chunk,
        );
      }).then(keep);
      // The invalidation ignores the payload, so a burst of cards-changed
      // (one per repository) is one refetch, not one per event. See
      // `lib/coalesce.ts`.
      const cardsChanged = createKeyedCoalescer<true>(() => {
        queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === reviewKeys.all[0] &&
            (q.queryKey[1] === "checks" || q.queryKey[1] === "files"),
        });
      });
      keep(() => {
        cardsChanged.flush();
        cardsChanged.dispose();
      });
      void listen(TASK_CARDS_CHANGED_EVENT, () => {
        cardsChanged.push("all", true);
      }).then(keep);
    },
    [queryClient],
  );
}

/** The task's checks: latest run each, the approve gate, stale + unconfirmed ids. */
export function useChecks(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: reviewKeys.checks(workspaceId ?? ""),
    queryFn: () => tauri.listCheckRuns(workspaceId ?? ""),
    enabled: !!workspaceId,
    staleTime: 10_000,
  });
}

/** Run checks now (`runCommandIds`, or every check when omitted). */
export function useRunChecks(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runCommandIds?: string[]) => tauri.runChecks(workspaceId, runCommandIds),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: reviewKeys.checks(workspaceId) }),
  });
}

export function useCancelChecks(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.cancelChecks(workspaceId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: reviewKeys.checks(workspaceId) }),
  });
}

/** A check's full output, kept live while it runs (appended from events). */
export function useCheckOutput(checkRunId: string | null | undefined) {
  return useQuery({
    queryKey: reviewKeys.checkOutput(checkRunId ?? ""),
    queryFn: () => tauri.getCheckOutput(checkRunId ?? ""),
    enabled: !!checkRunId,
    staleTime: Infinity,
  });
}

/** Files changed vs the merge-base with the task's base (committed work included). */
export function useReviewFiles(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: reviewKeys.files(workspaceId ?? ""),
    queryFn: () => tauri.gitReviewFiles(workspaceId ?? ""),
    enabled: !!workspaceId,
    staleTime: 5_000,
  });
}

// ── comments ─────────────────────────────────────────────────────────

export function useReviewComments(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: reviewKeys.comments(workspaceId ?? ""),
    queryFn: () => tauri.listReviewComments(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
}

function useCommentMutation<TArgs, TResult>(
  workspaceId: string,
  fn: (args: TArgs) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: reviewKeys.comments(workspaceId) }),
  });
}

export function useCreateReviewComment(workspaceId: string) {
  return useCommentMutation(workspaceId, (input: Omit<CreateReviewCommentInput, "workspaceId">) =>
    tauri.createReviewComment({ ...input, workspaceId }),
  );
}

export function useUpdateReviewComment(workspaceId: string) {
  return useCommentMutation(
    workspaceId,
    ({ id, input }: { id: string; input: UpdateReviewCommentInput }) =>
      tauri.updateReviewComment(id, input),
  );
}

export function useDeleteReviewComment(workspaceId: string) {
  return useCommentMutation(workspaceId, (id: string) => tauri.deleteReviewComment(id));
}

/** "Send all comments to {agent}". Rejects with "agent not running" when there's no PTY. */
export function useSendReviewComments(workspaceId: string) {
  return useCommentMutation(workspaceId, (message?: string) =>
    tauri.sendReviewComments(workspaceId, message),
  );
}

/** "Request changes": pending comments and/or a message to the agent. */
export function useRequestChanges(workspaceId: string) {
  return useCommentMutation(workspaceId, (message?: string) =>
    tauri.requestChanges(workspaceId, message),
  );
}

// ── closing out ──────────────────────────────────────────────────────

function useCloseOutMutation<TArgs, TResult>(
  workspaceId: string,
  fn: (args: TArgs) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskCardKeys.all });
      queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["git"] });
      queryClient.invalidateQueries({ queryKey: reviewKeys.checks(workspaceId) });
    },
  });
}

/**
 * Approve & create PR. Rejects with "required checks not passing: …"
 * unless `overrideChecks`; `viaGh: false` means open `url` to finish.
 */
export function useApproveAndCreatePr(workspaceId: string) {
  return useCloseOutMutation(workspaceId, (input: ApproveInput = {}) =>
    tauri.approveAndCreatePr(workspaceId, input),
  );
}


/** Remove the worktree + branch; the task is closed, its row and notes kept. */
export function useDiscardWorkspace(workspaceId: string) {
  return useCloseOutMutation(workspaceId, () => tauri.discardWorkspace(workspaceId));
}

/** Re-read open PRs (call on window focus). */
export function useRefreshPrStates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId?: string | null) => tauri.refreshPrStates(repositoryId),
    onSuccess: (changed) => {
      if (Array.isArray(changed) && changed.length > 0) {
        queryClient.invalidateQueries({ queryKey: taskCardKeys.all });
        queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      }
    },
  });
}

// ── run commands per task ────────────────────────────────────────────

/**
 * Run commands running (or exited this session) in exactly one run target:
 * a task's worktree id, or `null` = the repository checkout. The backend
 * answers `null` with EVERY scope, so the result is narrowed here — a
 * worktree-less task never lists another task's commands as its own.
 */
export function useRunningCommands(workspaceId: string | null) {
  const queryClient = useQueryClient();
  useTauriListeners(
    (keep) => {
      void listen<RunningCommand>(RUN_COMMAND_STATE_EVENT, (event) => {
        const next = event.payload;
        for (const scope of [next.workspaceId, null]) {
          queryClient.setQueryData<RunningCommand[]>(reviewKeys.running(scope), (prev) =>
            prev === undefined ? prev : upsertRunningCommand(prev, next),
          );
        }
      }).then(keep);
    },
    [queryClient],
  );
  return useQuery({
    queryKey: reviewKeys.running(workspaceId),
    queryFn: () => tauri.listRunningCommands(workspaceId),
    select: (rows) => runningIn(rows, workspaceId),
    staleTime: Infinity,
  });
}

/** `package.json` scripts offered as run commands. */
export function useDetectedScripts(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: reviewKeys.detectedScripts(repositoryId ?? ""),
    queryFn: () => tauri.detectPackageScripts(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}

/** "Allow on this machine" for a synced run command flagged `needsConfirmation`. */
export function useConfirmRunCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.confirmRunCommand(id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === reviewKeys.all[0] && q.queryKey[1] === "checks",
      }),
  });
}
