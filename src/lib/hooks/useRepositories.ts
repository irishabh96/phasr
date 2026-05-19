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

export function useGitInitRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    // Mirrors as an updateRepository so the cloud sees the new
    // default_branch — same key as a manual edit.
    mutationKey: ["mirror", "updateRepository", "init"] as const,
    mutationFn: (id: string) => tauri.gitInitRepository(id),
    onSuccess: (repository: Repository) => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
      queryClient.setQueryData(repositoryKeys.detail(repository.id), repository);
    },
  });
}

export function useDefaultProjectsDir() {
  return useQuery({
    queryKey: ["defaultProjectsDir"],
    queryFn: () => tauri.defaultProjectsDir(),
    staleTime: Infinity,
  });
}

export function useGitCloneRepository() {
  return useMutation({
    mutationFn: ({ url, destinationPath }: { url: string; destinationPath: string }) =>
      tauri.gitCloneRepository(url, destinationPath),
  });
}

export function useGitInitFromTemplate() {
  return useMutation({
    mutationFn: ({
      templateGitUrl,
      destinationPath,
    }: {
      templateGitUrl: string;
      destinationPath: string;
    }) => tauri.gitInitFromTemplate(templateGitUrl, destinationPath),
  });
}
