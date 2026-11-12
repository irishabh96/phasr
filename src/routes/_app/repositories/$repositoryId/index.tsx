import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useUiStore } from "@/lib/store";

/**
 * A repository's home is the board narrowed to that repository. The URL
 * survives for links (and ⌘W on a task's last tab) and lands there.
 */
function RepoHome() {
  const { repositoryId } = Route.useParams();
  const setRepoFilter = useUiStore((s) => s.setRepoFilter);
  useEffect(() => {
    setRepoFilter(repositoryId);
  }, [repositoryId, setRepoFilter]);
  return <Navigate to="/" replace />;
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/")({
  component: RepoHome,
});
