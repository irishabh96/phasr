import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { disposeMainXterm } from "@/components/Terminal";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { worklistKeys } from "@/lib/hooks/useWorklist";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Repository, Workspace } from "@/lib/types";

export const repositoryKeys = {
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
  const navigate = useNavigate();
  const router = useRouter();
  return useMutation({
    mutationKey: repositoryMutationKeys.delete,
    mutationFn: (id: string) => tauri.deleteRepository(id),
    onSuccess: (_v, id) => {
      // Tear down the deleted repo's open tabs + cached terminals before
      // its rows disappear, mirroring the per-workspace close path.
      const workspaces =
        queryClient.getQueryData<Workspace[]>(workspaceKeys.byRepository(id)) ??
        [];
      const store = useUiStore.getState();
      for (const ws of workspaces) {
        store.innerTabs[ws.id]?.tabs.forEach((t) =>
          t.kind === "terminal"
            ? disposeSessionXterm(t.id)
            : disposeMainXterm(ws.id),
        );
        disposeMainXterm(ws.id);
      }
      store.forgetRepository(
        id,
        workspaces.map((w) => w.id),
      );

      // Optimistically drop the repo from the list so the home redirect,
      // sidebar, and route guards see the new truth immediately — an
      // invalidate alone serves the stale (deleted) repo until the
      // refetch lands, which bounced the user right back into it.
      queryClient.setQueryData<Repository[]>(repositoryKeys.list(), (prev) =>
        prev ? prev.filter((r) => r.id !== id) : prev,
      );
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
      queryClient.removeQueries({ queryKey: repositoryKeys.detail(id) });
      queryClient.removeQueries({ queryKey: workspaceKeys.byRepository(id) });
      // The cross-repo Worklist/Home is a separate aggregate query — invalidate
      // it too, or it keeps showing the just-deleted repo's tickets (the DB rows
      // are already cascade-gone, so a refetch returns them empty).
      queryClient.invalidateQueries({ queryKey: worklistKeys.all });

      // If the user is currently on the just-deleted repo's home or any
      // of its workspace routes, bounce them to `/` — which lands on the
      // first remaining repo's workspace, or the welcome flow if none.
      const currentPath = router.state.location.pathname;
      if (currentPath.startsWith(`/repositories/${id}`)) {
        void navigate({ to: "/" });
      }
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
