import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { WORKTREE_CHANGED_EVENT } from "@/lib/events";
import { gitKeys } from "@/lib/hooks/useGit";
import { reviewKeys } from "@/lib/hooks/useReview";
import { taskCardKeys } from "@/lib/hooks/useTaskCards";
import { tauri } from "@/lib/tauri";
import type { RevertHunkScope, WorkspaceFile } from "@/lib/types";

/**
 * Files tab (M9): a worktree's file tree, one file's contents for the
 * editor, saving with an on-disk conflict check, and reverting one hunk.
 *
 * Freshness: the fs watcher's `worktree-changed` event (emitted while the
 * workspace is watched — `useWatchWorkspaceGit` at the route) refetches the
 * tree and any open file whose path changed. An open file's new `hash`
 * tells the editor the agent touched it; a save with the old hash then
 * rejects with {@link FILE_CHANGED_ON_DISK}.
 */

/** `write_workspace_file` rejects with exactly this when the file moved on. */
export const FILE_CHANGED_ON_DISK = "file changed on disk";
/** `revert_hunk` rejects with exactly this when the diff moved on. */
export const HUNK_NO_LONGER_MATCHES = "hunk no longer matches";

export const isFileChangedOnDisk = (err: unknown) => String(err) === FILE_CHANGED_ON_DISK;
export const isHunkNoLongerMatching = (err: unknown) => String(err) === HUNK_NO_LONGER_MATCHES;

export const workspaceFileKeys = {
  all: ["workspace-files"] as const,
  tree: (workspaceId: string) => [...workspaceFileKeys.all, "tree", workspaceId] as const,
  file: (workspaceId: string, path: string) =>
    [...workspaceFileKeys.all, "file", workspaceId, path] as const,
};

interface WorktreeChangedPayload {
  workspaceId: string;
  /** Empty = unknown (refetch everything for the workspace). */
  paths: string[];
}

/** Refetch this workspace's tree + changed open files on fs-watcher events. */
function useWorktreeFileEvents(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<WorktreeChangedPayload>(WORKTREE_CHANGED_EVENT, (event) => {
      if (event.payload.workspaceId !== workspaceId) return;
      void queryClient.invalidateQueries({ queryKey: workspaceFileKeys.tree(workspaceId) });
      const changed = new Set(event.payload.paths ?? []);
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const [root, kind, ws, path] = q.queryKey as unknown[];
          return (
            root === workspaceFileKeys.all[0] &&
            kind === "file" &&
            ws === workspaceId &&
            (changed.size === 0 || (typeof path === "string" && changed.has(path)))
          );
        },
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workspaceId, queryClient]);
}

/** The worktree's files (tracked + untracked, `.gitignore` honoured) with git badges. */
export function useWorkspaceTree(workspaceId: string | null | undefined) {
  useWorktreeFileEvents(workspaceId);
  return useQuery({
    queryKey: workspaceFileKeys.tree(workspaceId ?? ""),
    queryFn: () => tauri.listWorkspaceTree(workspaceId ?? ""),
    enabled: !!workspaceId,
    staleTime: 5_000,
  });
}

/**
 * One file for the editor: contents, `hash` (pass to save), size and the
 * agent's last edit. Errors are the backend's strings ("file is not text
 * (invalid UTF-8)", "file is too large to open …", path-guard refusals).
 */
export function useWorkspaceFile(
  workspaceId: string | null | undefined,
  path: string | null | undefined,
) {
  useWorktreeFileEvents(workspaceId);
  return useQuery({
    queryKey: workspaceFileKeys.file(workspaceId ?? "", path ?? ""),
    queryFn: () => tauri.readWorkspaceFile(workspaceId ?? "", path ?? ""),
    enabled: !!workspaceId && !!path,
    staleTime: Infinity,
    retry: false,
  });
}

/** Everything a write or a hunk revert can change for this workspace. */
function invalidateAfterEdit(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) {
  void queryClient.invalidateQueries({ queryKey: workspaceFileKeys.tree(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: gitKeys.status(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: ["git", "diff", workspaceId] });
  void queryClient.invalidateQueries({ queryKey: reviewKeys.files(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: taskCardKeys.all });
}

export interface WriteWorkspaceFileArgs {
  path: string;
  contents: string;
  /** The `hash` the editor loaded; `null` = new file / overwrite anyway. */
  expectedHash: string | null;
}

/**
 * ⌘S. On success the cached file takes the saved contents + new hash (no
 * refetch flash). Rejects with {@link FILE_CHANGED_ON_DISK} when the agent
 * edited the file since it was loaded — offer reload / overwrite (save again
 * with `expectedHash: null`).
 */
export function useWriteWorkspaceFile(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, contents, expectedHash }: WriteWorkspaceFileArgs) =>
      tauri.writeWorkspaceFile(workspaceId, path, contents, expectedHash),
    onSuccess: (result, { path, contents }) => {
      queryClient.setQueryData<WorkspaceFile>(workspaceFileKeys.file(workspaceId, path), (prev) =>
        prev
          ? { ...prev, contents, hash: result.hash, sizeBytes: new TextEncoder().encode(contents).length }
          : prev,
      );
      invalidateAfterEdit(queryClient, workspaceId);
    },
    onError: (err, { path }) => {
      // Show the user what's on disk now.
      if (isFileChangedOnDisk(err)) {
        void queryClient.invalidateQueries({ queryKey: workspaceFileKeys.file(workspaceId, path) });
      }
    },
  });
}

export interface RevertHunkArgs {
  path: string;
  /** The hunk's `@@ -a,b +c,d @@ …` line, exactly as rendered. */
  hunkHeader: string;
  scope: RevertHunkScope;
}

/**
 * "Revert hunk". Rejects with {@link HUNK_NO_LONGER_MATCHES} when the diff
 * changed since it was rendered (nothing is touched) — refetch and retry.
 */
export function useRevertHunk(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, hunkHeader, scope }: RevertHunkArgs) =>
      tauri.revertHunk(workspaceId, path, hunkHeader, scope),
    onSettled: (_data, _err, { path }) => {
      // Success or a stale hunk: either way the diff on screen is outdated.
      void queryClient.invalidateQueries({ queryKey: workspaceFileKeys.file(workspaceId, path) });
      invalidateAfterEdit(queryClient, workspaceId);
    },
  });
}
