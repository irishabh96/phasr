import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Task } from "@/lib/types";

const taskKeys = {
  all: ["tasks"] as const,
  byWorkspace: (workspaceId: string) => [...taskKeys.all, "workspace", workspaceId] as const,
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
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
    // Poll while the task is in flight so status badges reflect reality
    // even before the PTY exits.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return 1500;
      const settled = status === "completed" || status === "failed" || status === "archived";
      return settled ? false : 1500;
    },
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
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
    mutationFn: ({ id }: { id: string; workspaceId: string }) => tauri.deleteTask(id),
    onSuccess: (_v, { id, workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.byWorkspace(workspaceId) });
      queryClient.removeQueries({ queryKey: taskKeys.detail(id) });
    },
  });
}
