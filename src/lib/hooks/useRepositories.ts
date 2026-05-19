import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";

const repositoryKeys = {
  all: ["repositories"] as const,
  list: () => [...repositoryKeys.all, "list"] as const,
  detail: (id: string) => [...repositoryKeys.all, "detail", id] as const,
};

export const repositoryMutationKeys = {
  create: ["mirror", "createRepository"] as const,
  update: (id: string) => ["mirror", "updateRepository", id] as const,
  delete: ["mirror", "deleteRepository"] as const,
};

export function useRepositories() {
  return useQuery({
    queryKey: repositoryKeys.list(),
    queryFn: () => tauri.listRepositories(),
  });
}

export function useRepository(id: string | null | undefined) {
  return useQuery({
    queryKey: repositoryKeys.detail(id ?? ""),
    queryFn: () => tauri.getRepository(id ?? ""),
    enabled: !!id,
  });
}

export function useCreateRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: repositoryMutationKeys.create,
    mutationFn: tauri.createRepository,
    onSuccess: (repository: Repository) => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
      queryClient.setQueryData(repositoryKeys.detail(repository.id), repository);
    },
  });
}

export function useUpdateRepository(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: repositoryMutationKeys.update(id),
    mutationFn: (input: Parameters<typeof tauri.updateRepository>[1]) =>
      tauri.updateRepository(id, input),
    onSuccess: (repository: Repository) => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
      queryClient.setQueryData(repositoryKeys.detail(repository.id), repository);
    },
  });
}

export function useDeleteRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: repositoryMutationKeys.delete,
    mutationFn: (id: string) => tauri.deleteRepository(id),
    onSuccess: (_v, id) => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
      queryClient.removeQueries({ queryKey: repositoryKeys.detail(id) });
    },
  });
}
