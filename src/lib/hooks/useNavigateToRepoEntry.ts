import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useUiStore } from "@/lib/store";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

/**
 * "Enter" a repository in the new workspace-centric flow. Resolves to:
 *  - navigate to the repo's first workspace, if any
 *  - else open NewWorkspaceModal for that repo
 *
 * Replaces all navigations to the deleted `/repositories/$repositoryId`
 * route. Reads workspaces via the query cache (with a `fetchQuery`
 * fallback) so callsites can stay synchronous-ish without each pulling
 * `useWorkspaces` themselves.
 */
export function useNavigateToRepoEntry() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);

  return async (repositoryId: string) => {
    let workspaces = queryClient.getQueryData<Workspace[]>(
      workspaceKeys.byRepository(repositoryId),
    );
    if (!workspaces) {
      try {
        workspaces = await queryClient.fetchQuery({
          queryKey: workspaceKeys.byRepository(repositoryId),
          queryFn: () => tauri.listWorkspaces(repositoryId),
        });
      } catch {
        workspaces = [];
      }
    }
    const first = workspaces?.[0];
    if (first) {
      await navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId, workspaceId: first.id },
      });
    } else {
      requestNewWorkspace(repositoryId);
    }
  };
}
