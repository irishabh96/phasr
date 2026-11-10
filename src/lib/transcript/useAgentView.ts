import { useMutation, useQueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import type { Workspace } from "@/lib/types";
import { transcriptApi, type AgentView } from "./contract";
import { transcriptKeys } from "./useTranscript";

/**
 * "View as terminal" / "View as transcript": `set_agent_view` switches the
 * process (same Claude session) and answers with the updated row, which
 * becomes the task's cached row so the pane swaps at once.
 */
export function useSetAgentView(workspace: Pick<Workspace, "id" | "repositoryId">) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (view: AgentView) => transcriptApi.setAgentView(workspace.id, view),
    onSuccess: (row, view) => {
      queryClient.setQueryData<Workspace>(workspaceKeys.detail(workspace.id), (prev) => {
        const base = row ?? prev;
        if (!base) return prev;
        // The row is authoritative; `view` only fills a field it lacks.
        const agentView = (row as { agentView?: unknown } | null)?.agentView ?? view;
        return { ...base, agentView } as Workspace;
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.byRepository(workspace.repositoryId) });
      // Back to the transcript: what happened in the terminal meanwhile is
      // only in the backend's JSONL, so reload it.
      if (view === "transcript") void queryClient.invalidateQueries({ queryKey: transcriptKeys.task(workspace.id) });
    },
  });
}
