import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { tauri } from "@/lib/tauri";
import type { Repository, Workspace } from "@/lib/types";

/**
 * Every workspace across every repository, using the SAME per-repository
 * query keys as `useWorkspaces`, so `useTaskEvents` invalidation and any
 * other view's cache stay shared.
 */
export function useAllWorkspaces(): {
  repositories: Repository[];
  workspaces: Workspace[];
  isLoading: boolean;
} {
  const repos = useRepositories();
  const repositories = repos.data ?? [];
  const results = useQueries({
    queries: repositories.map((r) => ({
      queryKey: workspaceKeys.byRepository(r.id),
      queryFn: () => tauri.listWorkspaces(r.id),
    })),
  });
  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const workspaces = useMemo(
    () => results.flatMap((r) => r.data ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey],
  );
  return {
    repositories,
    workspaces,
    isLoading: repos.isLoading || results.some((r) => r.isLoading),
  };
}
