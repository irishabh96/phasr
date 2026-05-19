import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { DiffScope } from "@/lib/types";

const gitKeys = {
  status: (taskId: string) => ["git", "status", taskId] as const,
  diff: (taskId: string, scope: DiffScope, path?: string) =>
    ["git", "diff", taskId, scope, path ?? null] as const,
};

export function useGitStatus(taskId: string | null | undefined) {
  return useQuery({
    queryKey: gitKeys.status(taskId ?? ""),
    queryFn: () => tauri.gitStatus(taskId ?? ""),
    enabled: !!taskId,
    // Conservative: status only changes when the agent (or user) writes,
    // and we refresh manually after stage/unstage/discard/commit
    // mutations via invalidate.
    refetchInterval: 6000,
  });
}

export function useGitDiff(
  taskId: string | null | undefined,
  scope: DiffScope,
  path?: string | null,
) {
  return useQuery({
    queryKey: gitKeys.diff(taskId ?? "", scope, path ?? undefined),
    queryFn: () => tauri.gitDiff(taskId ?? "", scope, path ?? undefined),
    enabled: !!taskId && !!path,
  });
}

export function useGitStage(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitStage(taskId, paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", taskId] }),
  });
}

export function useGitUnstage(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitUnstage(taskId, paths),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", taskId] }),
  });
}

export function useGitDiscard(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => tauri.gitDiscard(taskId, paths),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["git", "status", taskId] });
      qc.invalidateQueries({ queryKey: ["git", "diff", taskId] });
    },
  });
}

export function useGitCommit(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => tauri.gitCommit(taskId, message),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git", "status", taskId] }),
  });
}

export function useGitPush(taskId: string) {
  return useMutation({
    mutationFn: () => tauri.gitPush(taskId),
  });
}
