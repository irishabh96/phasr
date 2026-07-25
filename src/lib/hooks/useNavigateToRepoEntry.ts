import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";

/**
 * "Enter" a repository. Resolves to:
 *  - navigate to the repo's first NON-LOCAL workspace (real agent/workflow
 *    work), if any,
 *  - else navigate to `/repositories/$repositoryId` — the repo home, which
 *    renders the RepoEntryChoice onboarding screen (New task / New workflow /
 *    Open terminal).
 *
 * Every repo is auto-seeded a `local` (terminal) workspace on add
 * (`ensure_local_workspace`). If we treated that as a real entry target, a
 * freshly-added or terminal-only repo would route straight to a bare terminal
 * and never show the choice screen — so we skip `local` rows and let a repo
 * with no real work land on the onboarding choice instead.
 *
 * Used by the sidebar's repo rows, add-repo (`NewProjectPane` /
 * `useOpenExistingFlow`), the GitInitConfirmModal handlers, and the command
 * palette's repo items.
 */
export function useNavigateToRepoEntry() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
    // Skip the auto-seeded `local` (terminal) workspace: a repo whose only
    // workspace is that default terminal should land on the RepoEntryChoice
    // onboarding screen, not route straight into the bare terminal.
    const first = workspaces?.find((w) => w.workspaceKind !== "local");
    if (first) {
      await navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId, workspaceId: first.id },
      });
    } else {
      await navigate({
        to: "/repositories/$repositoryId",
        params: { repositoryId },
      });
    }
  };
}
