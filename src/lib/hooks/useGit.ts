import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { DiffScope } from "@/lib/types";

const gitKeys = {
  status: (workspaceId: string) => ["git", "status", workspaceId] as const,
  diff: (workspaceId: string, scope: DiffScope, path?: string) =>
    ["git", "diff", workspaceId, scope, path ?? null] as const,
};

export function useGitStatus(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: gitKeys.status(workspaceId ?? ""),
    queryFn: () => tauri.gitStatus(workspaceId ?? ""),
    enabled: !!workspaceId,
    refetchInterval: 6000,
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
