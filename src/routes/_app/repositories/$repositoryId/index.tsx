import { Navigate, createFileRoute } from "@tanstack/react-router";
import { RepoHomeShell } from "@/components/RepoHomeShell";
import { useRepositories, useRepository } from "@/lib/hooks/useRepositories";

function RepoHome() {
  const { repositoryId } = Route.useParams();
  const { data: repos } = useRepositories();
  const { data: repo, isLoading } = useRepository(repositoryId);

  // The repo is gone (e.g. just deleted) — bounce home, which lands on
  // another repository or the welcome flow rather than a dead end.
  if (repos && !repos.some((r) => r.id === repositoryId)) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }
  if (!repo) {
    return <Navigate to="/" replace />;
  }

  return <RepoHomeShell repo={repo} />;
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/")({
  component: RepoHome,
});
