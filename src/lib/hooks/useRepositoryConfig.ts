import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taskCardKeys } from "@/lib/hooks/useTaskCards";
import { tauri, type UpdateRepositoryConfigInput } from "@/lib/tauri";
import type { ApiKeyName, RepositoryConfig } from "@/lib/types";

/**
 * Settings expansion (M11): per-repository rules (Worktrees / Branch rules),
 * the repository's worktrees with sizes and removal, agent API keys, and the
 * shells offered under Terminal. Repository rules are local to this machine
 * (never synced); API key values never reach the frontend.
 */

export const repositoryConfigKeys = {
  all: ["repository-config"] as const,
  config: (repositoryId: string) => [...repositoryConfigKeys.all, "config", repositoryId] as const,
  worktrees: (repositoryId: string) =>
    [...repositoryConfigKeys.all, "worktrees", repositoryId] as const,
  sizes: (repositoryId: string) => [...repositoryConfigKeys.all, "sizes", repositoryId] as const,
  apiKeys: () => [...repositoryConfigKeys.all, "api-keys"] as const,
  shells: () => [...repositoryConfigKeys.all, "shells"] as const,
};

export function useRepositoryConfig(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: repositoryConfigKeys.config(repositoryId ?? ""),
    queryFn: () => tauri.getRepositoryConfig(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}

/**
 * Save some rules ("Changes save instantly"). Optimistic per field; the
 * backend normalises (trimmed globs, blank → `null`) and the response
 * replaces the cache. Rejections are the backend's validation strings
 * (e.g. "`../x` may not contain `..`").
 */
export function useUpdateRepositoryConfig(repositoryId: string) {
  const queryClient = useQueryClient();
  const key = repositoryConfigKeys.config(repositoryId);
  return useMutation({
    // Serialize: a toggle pressed twice quickly must land in order.
    scope: { id: `repository-config:${repositoryId}` },
    mutationFn: (input: UpdateRepositoryConfigInput) =>
      tauri.updateRepositoryConfig(repositoryId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RepositoryConfig>(key);
      if (previous) {
        const next: RepositoryConfig = { ...previous };
        for (const [field, value] of Object.entries(input) as [keyof RepositoryConfig, unknown][]) {
          if (value !== undefined) (next as unknown as Record<string, unknown>)[field] = value;
        }
        queryClient.setQueryData(key, next);
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: (saved, input) => {
      queryClient.setQueryData(key, saved);
      // A new worktree location changes what counts as "orphaned".
      if (input.worktreeBasePath !== undefined) {
        void queryClient.invalidateQueries({ queryKey: repositoryConfigKeys.worktrees(repositoryId) });
      }
    },
  });
}

/** The repository's worktrees (main checkout excluded) with their task + lane. */
export function useRepositoryWorktrees(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: repositoryConfigKeys.worktrees(repositoryId ?? ""),
    queryFn: () => tauri.listRepositoryWorktrees(repositoryId ?? ""),
    enabled: !!repositoryId,
    staleTime: 10_000,
  });
}

/**
 * Disk usage per worktree (`du`, up to 20s each) — slow, so cached for a
 * while and fetched only when `enabled` (e.g. the Worktrees page is open).
 */
export function useWorktreeSizes(repositoryId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: repositoryConfigKeys.sizes(repositoryId ?? ""),
    queryFn: () => tauri.computeWorktreeSizes(repositoryId ?? ""),
    enabled: !!repositoryId && enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * Remove worktrees (branches are kept). All-or-nothing: rejects the batch
 * for the main checkout, a path outside phasr's worktree folders, or one
 * whose agent is running ("… stop the task first").
 */
export function useRemoveWorktrees(repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paths, force = false }: { paths: string[]; force?: boolean }) =>
      tauri.removeWorktrees(repositoryId, paths, force),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: repositoryConfigKeys.worktrees(repositoryId) });
      void queryClient.invalidateQueries({ queryKey: repositoryConfigKeys.sizes(repositoryId) });
      void queryClient.invalidateQueries({ queryKey: taskCardKeys.all });
    },
  });
}

/** Name / is-set / last-4 hint for each supported key. Never the value. */
export function useApiKeys() {
  return useQuery({
    queryKey: repositoryConfigKeys.apiKeys(),
    queryFn: () => tauri.listApiKeys(),
  });
}

export function useSetApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: ApiKeyName; value: string }) =>
      tauri.setApiKey(name, value),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repositoryConfigKeys.apiKeys() }),
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: ApiKeyName) => tauri.deleteApiKey(name),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repositoryConfigKeys.apiKeys() }),
  });
}

/** Shells from `/etc/shells` present here. `""` (login shell) isn't listed — offer it yourself. */
export function useShells() {
  return useQuery({
    queryKey: repositoryConfigKeys.shells(),
    queryFn: () => tauri.listShells(),
    staleTime: Infinity,
  });
}
