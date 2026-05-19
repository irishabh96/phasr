import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { OpenInMenu } from "@/components/OpenInMenu";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { Terminal } from "@/components/Terminal";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";

function WorkspaceDetail() {
  const { repositoryId, workspaceId } = Route.useParams();
  const { data: workspace } = useWorkspace(workspaceId);
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", workspaceId] });
    queryClient.invalidateQueries({
      queryKey: ["workspaces", "repository", repositoryId],
    });
  }, [queryClient, workspaceId, repositoryId]);

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-(--color-text-muted)">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/repositories/$repositoryId"
            params={{ repositoryId }}
            className="text-(--color-text-secondary) hover:text-(--color-text-primary)"
          >
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{workspace.name}</div>
            <code className="block truncate text-xs text-(--color-text-muted)">
              {workspace.command}
            </code>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RunCommandPicker repositoryId={repositoryId} />
          {workspace.worktreePath && <OpenInMenu path={workspace.worktreePath} />}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <Terminal
            workspaceId={workspaceId}
            status={workspace.status}
            onExit={refresh}
          />
        </div>
        {workspace.worktreePath && (
          <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-(--color-border-subtle) bg-(--color-bg-surface)">
            <ChangesPanel workspaceId={workspaceId} />
          </aside>
        )}
      </div>
      <RunCommandsPane repositoryId={repositoryId} />
    </div>
  );
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/workspaces/$workspaceId",
)({
  component: WorkspaceDetail,
});
