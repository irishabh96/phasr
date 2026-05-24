import { listen } from "@tauri-apps/api/event";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { tauri } from "@/lib/tauri";
import type { ConflictSide, DiffScope, LogOptions, MergeStrategy } from "@/lib/types";

const gitKeys = {
  status: (workspaceId: string) => ["git", "status", workspaceId] as const,
  branchStatus: (workspaceId: string) => ["git", "branchStatus", workspaceId] as const,
  mergeInProgress: (workspaceId: string) =>
    ["git", "mergeInProgress", workspaceId] as const,
  diff: (workspaceId: string, scope: DiffScope, path?: string) =>
    ["git", "diff", workspaceId, scope, path ?? null] as const,
  log: (workspaceId: string, opts: { branchOnly: boolean; messageGrep?: string }) =>
    ["git", "log", workspaceId, opts.branchOnly, opts.messageGrep ?? ""] as const,
  commitFiles: (workspaceId: string, sha: string) =>
    ["git", "commitFiles", workspaceId, sha] as const,
  commitDiff: (workspaceId: string, sha: string, path: string) =>
    ["git", "commitDiff", workspaceId, sha, path] as const,
};

function invalidateWorkspaceGit(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) {
  qc.invalidateQueries({ queryKey: gitKeys.status(workspaceId) });
  qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) });
  qc.invalidateQueries({ queryKey: gitKeys.mergeInProgress(workspaceId) });
  qc.invalidateQueries({ queryKey: ["git", "diff", workspaceId] });
  qc.invalidateQueries({ queryKey: ["git", "log", workspaceId] });
}

interface WorktreeChangedPayload {
  workspaceId: string;
}

export function useGitStatus(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: gitKeys.status(workspaceId ?? ""),
    queryFn: () => tauri.gitStatus(workspaceId ?? ""),
    enabled: !!workspaceId,
  });

  // Refetch on fs-watcher events from the backend instead of polling.
  // The watcher debounces bursts of fs changes server-side, so this
  // only fires ~300ms after the user actually stops editing.
  // We tell the backend to start/stop watching as the user navigates
  // in and out of this workspace so only one OS-level watcher exists
  // at a time.
  useEffect(() => {
    if (!workspaceId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    tauri.watchWorkspace(workspaceId).catch(() => {});
    listen<WorktreeChangedPayload>("worktree-changed", (e) => {
      if (e.payload.workspaceId !== workspaceId) return;
      // Local commits (made via the terminal) bump HEAD without
      // changing the worktree, but `.git/HEAD` is inside the watched
      // tree, so the same event flushes branch status and merge
      // progress along with status + diffs.
      invalidateWorkspaceGit(qc, workspaceId);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      tauri.unwatchWorkspace(workspaceId).catch(() => {});
    };
  }, [workspaceId, qc]);

  return query;
}

export function useGitDiff(
  workspaceId: string | null | undefined,
  scope: DiffScope,
  path?: string | null,
) {
  return useQuery({
    queryKey: gitKeys.diff(workspaceId ?? "", scope, path ?? undefined),
    queryFn: () => tauri.gitDiff(workspaceId ?? "", scope, path ?? undefined),
    enabled: !!workspaceId && !!path,
  });
}

export function useGitStage(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitStage(workspaceId, paths),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitUnstage(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitUnstage(workspaceId, paths),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitDiscard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitDiscard(workspaceId, paths),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitCommit(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => tauri.gitCommit(workspaceId, message),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitPush(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.gitPush(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) }),
  });
}

export function useGitFetch(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.gitFetch(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) }),
  });
}

export function useGitSyncWithMain(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (strategy: MergeStrategy) =>
      tauri.gitSyncWithMain(workspaceId, strategy),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitMergeToMain(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (strategy: MergeStrategy) =>
      tauri.gitMergeToMain(workspaceId, strategy),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitAbortMerge(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.gitAbortMerge(workspaceId),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitContinueMerge(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.gitContinueMerge(workspaceId),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

export function useGitResolveConflict(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, side }: { path: string; side: ConflictSide }) =>
      tauri.gitResolveConflict(workspaceId, path, side),
    onSuccess: () => invalidateWorkspaceGit(qc, workspaceId),
  });
}

/**
 * Whether the worktree is in the middle of a merge or rebase, and
 * which files are still conflicting. Drives ChangesPanel's
 * Conflicts section + the in-progress banner.
 */
export function useGitMergeInProgress(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: gitKeys.mergeInProgress(workspaceId ?? ""),
    queryFn: () => tauri.gitMergeInProgress(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
}

/**
 * Current branch + ahead/behind tracking for a workspace's worktree.
 * The chip in the workspace header and the Push button's enablement
 * both feed off this. Invalidated by fs-watcher events (which catch
 * commits made via the embedded terminal) and after our own mutations.
 */
export function useGitBranchStatus(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: gitKeys.branchStatus(workspaceId ?? ""),
    queryFn: () => tauri.gitBranchStatus(workspaceId ?? ""),
    enabled: !!workspaceId,
    refetchInterval: 60_000,
  });
}

/**
 * Sorted list of local branch names for a repo path. Used by the
 * CreateFirstWorkspacePane base-branch dropdown.
 */
export function useGitBranches(repoPath: string | null | undefined) {
  return useQuery({
    queryKey: ["git", "branches", repoPath ?? ""],
    queryFn: () => tauri.listLocalBranches(repoPath ?? ""),
    enabled: !!repoPath,
    staleTime: 10_000,
  });
}

const LOG_PAGE_SIZE = 50;

/**
 * Paginated commit history for the History tab. Pages are 50 commits;
 * `fetchNextPage` walks forward via `--skip`. Invalidated by the
 * fs-watcher (commits land in .git/HEAD, which is inside the watched
 * tree) and by our own commit/sync/merge mutations.
 */
export function useGitLog(
  workspaceId: string | null | undefined,
  filters: { branchOnly: boolean; messageGrep?: string },
) {
  return useInfiniteQuery({
    queryKey: gitKeys.log(workspaceId ?? "", filters),
    queryFn: ({ pageParam }) => {
      const opts: LogOptions = {
        branchOnly: filters.branchOnly,
        limit: LOG_PAGE_SIZE,
        skip: pageParam as number,
      };
      if (filters.messageGrep && filters.messageGrep.trim().length > 0) {
        opts.messageGrep = filters.messageGrep.trim();
      }
      return tauri.gitLog(workspaceId ?? "", opts);
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length < LOG_PAGE_SIZE ? undefined : all.length * LOG_PAGE_SIZE,
    enabled: !!workspaceId,
  });
}

export function useGitCommitFiles(
  workspaceId: string | null | undefined,
  sha: string | null | undefined,
) {
  return useQuery({
    queryKey: gitKeys.commitFiles(workspaceId ?? "", sha ?? ""),
    queryFn: () => tauri.gitCommitFiles(workspaceId ?? "", sha ?? ""),
    enabled: !!workspaceId && !!sha,
    // Commits are immutable — once we have a file list it never
    // changes. Keep it cached for the session.
    staleTime: Infinity,
  });
}
