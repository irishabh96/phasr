import { listen } from "@tauri-apps/api/event";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type {
  ConflictSide,
  DiffScope,
  LogOptions,
  MergeStrategy,
} from "@/lib/types";

const gitKeys = {
  status: (workspaceId: string) => ["git", "status", workspaceId] as const,
  branchStatus: (workspaceId: string) =>
    ["git", "branchStatus", workspaceId] as const,
  mergeInProgress: (workspaceId: string) =>
    ["git", "mergeInProgress", workspaceId] as const,
  diff: (workspaceId: string, scope: DiffScope, path?: string) =>
    ["git", "diff", workspaceId, scope, path ?? null] as const,
  log: (
    workspaceId: string,
    opts: { branchOnly: boolean; messageGrep?: string },
  ) =>
    [
      "git",
      "log",
      workspaceId,
      opts.branchOnly,
      opts.messageGrep ?? "",
    ] as const,
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

/**
 * Invalidate git queries in response to an fs-watcher `worktree-changed`
 * event. Status / branch / merge always refresh (cheap, and a change can
 * flip any of them). Per-file diffs are the expensive part, so we
 * invalidate ONLY the diff keys for the paths the watcher actually
 * reported — instead of blowing away every open file's diff on every
 * keystroke-debounced burst. When `paths` is empty we don't know what
 * moved (e.g. a terminal commit only touched `.git`, which the backend
 * filters out), so we fall back to the full sweep — which also picks up
 * the commit log.
 */
function invalidateForWorktreeChange(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  paths: string[],
) {
  qc.invalidateQueries({ queryKey: gitKeys.status(workspaceId) });
  qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) });
  qc.invalidateQueries({ queryKey: gitKeys.mergeInProgress(workspaceId) });
  if (paths.length === 0) {
    qc.invalidateQueries({ queryKey: ["git", "diff", workspaceId] });
    qc.invalidateQueries({ queryKey: ["git", "log", workspaceId] });
    return;
  }
  const changed = new Set(paths);
  // Diff keys are ["git","diff",workspaceId,scope,path]; match any scope
  // for a changed path so both the staged and unstaged views refresh.
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey;
      return (
        Array.isArray(k) &&
        k[0] === "git" &&
        k[1] === "diff" &&
        k[2] === workspaceId &&
        typeof k[4] === "string" &&
        changed.has(k[4])
      );
    },
  });
}

interface WorktreeChangedPayload {
  workspaceId: string;
  /**
   * Worktree-relative paths that changed in this debounced burst. The
   * backend already filters out `.git`, `node_modules`, `target` and
   * `dist`. Empty when the change can't be attributed to a worktree file
   * (e.g. a commit that only moved `.git/HEAD`).
   */
  paths: string[];
}

/**
 * Start the OS-level fs-watcher for a workspace and invalidate its git
 * queries on `worktree-changed` events. Mount this EXACTLY ONCE per
 * workspace (at the route level) — `useGitStatus` used to install this
 * per instance, so with three status consumers a workspace ended up with
 * three watchers/listeners and an unwatch race. Keeping the lifecycle in
 * one place gives one watcher for the workspace's whole lifetime.
 */
export function useWatchWorkspaceGit(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    tauri.watchWorkspace(workspaceId).catch(() => {});
    listen<WorktreeChangedPayload>("worktree-changed", (e) => {
      if (e.payload.workspaceId !== workspaceId) return;
      invalidateForWorktreeChange(qc, workspaceId, e.payload.paths ?? []);
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
}

/**
 * Working-tree status for a workspace. A pure query — the fs-watcher that
 * refetches it lives in {@link useWatchWorkspaceGit}, mounted once at the
 * route level, so this can be read from as many components as needed
 * without spawning duplicate watchers.
 */
export function useGitStatus(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: gitKeys.status(workspaceId ?? ""),
    queryFn: () => tauri.gitStatus(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
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
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) });
      showToast({
        title: "Pushed",
        intent: "success",
        ...(data.pullRequestUrl
          ? {
              action: {
                label: `Open pull request${data.provider ? ` on ${data.provider}` : ""}`,
                url: data.pullRequestUrl,
              },
            }
          : {}),
        timeoutMs: 15000,
      });
    },
  });
}

export function useGitFetch(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.gitFetch(workspaceId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: gitKeys.branchStatus(workspaceId) }),
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

/**
 * Abort a merge stopped mid-flight in the repository's MAIN checkout — the
 * one-click recovery from a conflicted Ship (`ship_epic`). Repo-scoped: a
 * conflicted Ship lives in the main checkout, which no workspace id reaches.
 */
export function useGitRepoAbortMerge(repositoryId: string) {
  return useMutation({
    mutationFn: () => tauri.gitRepoAbortMerge(repositoryId),
  });
}

/**
 * Push the repository's default branch from the MAIN checkout — the explicit
 * post-Ship action (Ship itself never pushes, by decision).
 */
export function useGitPushDefaultBranch(repositoryId: string) {
  return useMutation({
    mutationFn: () => tauri.gitPushDefaultBranch(repositoryId),
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
