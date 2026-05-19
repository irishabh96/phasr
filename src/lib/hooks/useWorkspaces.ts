import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

const workspaceKeys = {
  all: ["workspaces"] as const,
  byRepository: (repositoryId: string) =>
    [...workspaceKeys.all, "repository", repositoryId] as const,
  detail: (id: string) => [...workspaceKeys.all, "detail", id] as const,
};

export const workspaceMutationKeys = {
  create: ["mirror", "createWorkspace"] as const,
  update: (id: string) => ["mirror", "updateWorkspace", id] as const,
  delete: ["mirror", "deleteWorkspace"] as const,
};

export function useWorkspaces(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: workspaceKeys.byRepository(repositoryId ?? ""),
    queryFn: () => tauri.listWorkspaces(repositoryId ?? ""),
    enabled: !!repositoryId,
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
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.byRepository(workspace.repositoryId),
      });
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
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.byRepository(workspace.repositoryId),
      });
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: workspaceMutationKeys.delete,
    mutationFn: ({ id }: { id: string; repositoryId: string }) => tauri.deleteWorkspace(id),
    onSuccess: (_v, { id, repositoryId }) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.byRepository(repositoryId) });
      queryClient.removeQueries({ queryKey: workspaceKeys.detail(id) });
    },
  });
}

export function useArchiveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    // Archive flows through `mirror:updateWorkspace` so the cloud
    // gets the same state change.
    mutationKey: ["mirror", "updateWorkspace", "archive"] as const,
    mutationFn: (id: string) => tauri.archiveWorkspace(id),
    onSuccess: (workspace: Workspace) => {
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.byRepository(workspace.repositoryId),
      });
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
    },
  });
}

export function useOpenPullRequest() {
  return useMutation({
    mutationFn: (id: string) => tauri.openPullRequest(id),
  });
}

export function useCheckWorkspaceDelete() {
  return useMutation({
    mutationFn: (id: string) => tauri.checkWorkspaceDelete(id),
  });
}
