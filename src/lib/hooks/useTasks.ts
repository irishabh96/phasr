import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Task } from "@/lib/types";

const taskKeys = {
  all: ["tasks"] as const,
  byWorkspace: (workspaceId: string) => [...taskKeys.all, "workspace", workspaceId] as const,
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
};

export const taskMutationKeys = {
  create: ["mirror", "createTask"] as const,
  update: (id: string) => ["mirror", "updateTask", id] as const,
  delete: ["mirror", "deleteTask"] as const,
};

export function useTasks(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: taskKeys.byWorkspace(workspaceId ?? ""),
    queryFn: () => tauri.listTasks(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
}

export function useTask(id: string | null | undefined) {
  return useQuery({
    queryKey: taskKeys.detail(id ?? ""),
    queryFn: () => tauri.getTask(id ?? ""),
    enabled: !!id,
    // No polling: Rust emits `phasr://task-status` whenever a task row
    // transitions, and `useTaskEvents` invalidates this query.
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: taskMutationKeys.create,
    mutationFn: tauri.createTask,
    onSuccess: (task: Task) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.byWorkspace(task.workspaceId) });
      queryClient.setQueryData(taskKeys.detail(task.id), task);
    },
  });
}

export function useUpdateTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: taskMutationKeys.update(id),
    mutationFn: (input: Parameters<typeof tauri.updateTask>[1]) => tauri.updateTask(id, input),
    onSuccess: (task: Task) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.byWorkspace(task.workspaceId) });
      queryClient.setQueryData(taskKeys.detail(task.id), task);
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: taskMutationKeys.delete,
    mutationFn: ({ id }: { id: string; workspaceId: string }) => tauri.deleteTask(id),
    onSuccess: (_v, { id, workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.byWorkspace(workspaceId) });
      queryClient.removeQueries({ queryKey: taskKeys.detail(id) });
    },
  });
}
