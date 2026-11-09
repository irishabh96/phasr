import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

/**
 * "Enter" a repository. Resolves to:
 *  - navigate to the repo's first workspace, if any,
 *  - else navigate to `/repositories/$repositoryId` — the repo home,
 *    which renders the inner-tab bar + CreateFirstWorkspacePane.
 *
 * Used by the sidebar's repo rows, the GitInitConfirmModal's Cancel /
 * Initialize Git handlers, and the command palette's repo items. No
 * longer pops a legacy modal — the workspace-less path lands on a real
 * route now.
 */
export function useNavigateToRepoEntry() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /** Resolves to the workspace id it landed on, or null for the repo home. */
  return async (repositoryId: string): Promise<string | null> => {
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
      return first.id;
    }
    await navigate({
      to: "/repositories/$repositoryId",
      params: { repositoryId },
    });
    return null;
  };
}
