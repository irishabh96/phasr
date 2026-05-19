import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

const runCommandKeys = {
  byRepository: (repositoryId: string) =>
    ["runCommands", "repository", repositoryId] as const,
};

export function useRunCommands(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: runCommandKeys.byRepository(repositoryId ?? ""),
    queryFn: () => tauri.listRunCommands(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}

export function useCreateRunCommand(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Parameters<typeof tauri.createRunCommand>[0], "repositoryId">) =>
      tauri.createRunCommand({ ...input, repositoryId }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: runCommandKeys.byRepository(repositoryId) }),
  });
}

export function useUpdateRunCommand(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Parameters<typeof tauri.updateRunCommand>[1];
    }) => tauri.updateRunCommand(id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: runCommandKeys.byRepository(repositoryId) }),
  });
}

export function useDeleteRunCommand(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.deleteRunCommand(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: runCommandKeys.byRepository(repositoryId) }),
  });
}
