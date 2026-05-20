import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { tauri } from "@/lib/tauri";
import type { DiffScope } from "@/lib/types";

const gitKeys = {
  status: (workspaceId: string) => ["git", "status", workspaceId] as const,
  diff: (workspaceId: string, scope: DiffScope, path?: string) =>
    ["git", "diff", workspaceId, scope, path ?? null] as const,
};

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
      qc.invalidateQueries({ queryKey: gitKeys.status(workspaceId) });
      qc.invalidateQueries({ queryKey: ["git", "diff", workspaceId] });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", workspaceId] }),
  });
}

export function useGitUnstage(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitUnstage(workspaceId, paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", workspaceId] }),
  });
}

export function useGitDiscard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitDiscard(workspaceId, paths),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["git", "status", workspaceId] });
      qc.invalidateQueries({ queryKey: ["git", "diff", workspaceId] });
    },
  });
}

export function useGitCommit(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => tauri.gitCommit(workspaceId, message),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", workspaceId] }),
  });
}

export function useGitPush(workspaceId: string) {
  return useMutation({
    mutationFn: () => tauri.gitPush(workspaceId),
  });
}
