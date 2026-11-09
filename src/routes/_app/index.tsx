import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BoardPage } from "@/components/board/BoardPage";
import { FirstRunPage } from "@/components/firstrun/FirstRunPage";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";

/**
 * Cold launch reopens the task you were last in (continuity across
 * relaunches); every later visit to "/" is the board. Module-level, so it
 * resets only when the app reloads.
 */
let restoredOnLaunch = false;

function Home() {
  const { data: repositories, isLoading } = useRepositories();
  const lastWorkspace = useUiStore((s) => s.lastWorkspace);
  const navigate = useNavigate();
  // Decided once per launch; state (not just the module flag) so this
  // component re-renders into the board even if "/" is revisited before the
  // redirect lands.
  const [restoring, setRestoring] = useState(() => !restoredOnLaunch && !!lastWorkspace);
  const { data: lastWs, isLoading: lastLoading, isError: lastMissing } = useWorkspace(
    restoring ? lastWorkspace?.workspaceId : null,
  );

  useEffect(() => {
    if (!restoring || isLoading || lastLoading) return;
    restoredOnLaunch = true;
    setRestoring(false);
    if (!lastMissing && lastWs && repositories?.some((r) => r.id === lastWs.repositoryId)) {
      void navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId: lastWs.repositoryId, workspaceId: lastWs.id },
        replace: true,
      });
    }
  }, [restoring, isLoading, lastLoading, lastMissing, lastWs, repositories, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    restoredOnLaunch = true;
    return <FirstRunPage />;
  }

  if (restoring) return null;
  restoredOnLaunch = true;
  return <BoardPage />;
}

export const Route = createFileRoute("/_app/")({
  component: Home,
});
