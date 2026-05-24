import { createFileRoute } from "@tanstack/react-router";
import { RepoHomeShell } from "@/components/RepoHomeShell";
import { useRepository } from "@/lib/hooks/useRepositories";

function RepoHome() {
  const { repositoryId } = Route.useParams();
  const { data: repo, isLoading } = useRepository(repositoryId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Loading…
      </div>
    );
  }
  if (!repo) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
        Repository not found.
      </div>
    );
  }

  return <RepoHomeShell repo={repo} />;
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/")({
  component: RepoHome,
});
