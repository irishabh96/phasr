import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

const workspaceKeys = {
  all: ["workspaces"] as const,
  list: () => [...workspaceKeys.all, "list"] as const,
  detail: (id: string) => [...workspaceKeys.all, "detail", id] as const,
};

/**
 * Mutation keys used by the cloud-sync layer to dispatch mirroring.
 * Adding/removing items here must stay in lockstep with
 * `src/lib/hooks/useCloudSync.ts` HANDLERS.
 */
export const workspaceMutationKeys = {
  create: ["mirror", "createWorkspace"] as const,
  update: (id: string) => ["mirror", "updateWorkspace", id] as const,
  delete: (id: string) => ["mirror", "deleteWorkspace", id] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: workspaceKeys.list(),
    queryFn: () => tauri.listWorkspaces(),
  });
}

export function useWorkspace(id: string | null | undefined) {
  return useQuery({
    queryKey: workspaceKeys.detail(id ?? ""),
    queryFn: () => tauri.getWorkspace(id ?? ""),
    enabled: !!id,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: workspaceMutationKeys.create,
    mutationFn: tauri.createWorkspace,
    onSuccess: (workspace: Workspace) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
    },
  });
}

export function useUpdateWorkspace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: workspaceMutationKeys.update(id),
    mutationFn: (input: Parameters<typeof tauri.updateWorkspace>[1]) =>
      tauri.updateWorkspace(id, input),
    onSuccess: (workspace: Workspace) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "deleteWorkspace"] as const,
    mutationFn: (id: string) => tauri.deleteWorkspace(id),
    onSuccess: (_v, id) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
      queryClient.removeQueries({ queryKey: workspaceKeys.detail(id) });
    },
  });
}
