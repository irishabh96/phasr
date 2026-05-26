import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { RunCommandsSection } from "@/components/RunCommandsSection";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepository } from "@/lib/hooks/useRepositories";

function RepositorySettingsPage() {
  const { repositoryId } = Route.useParams();
  const { data: repository } = useRepository(repositoryId);
  const navigateToRepoEntry = useNavigateToRepoEntry();

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <button
        type="button"
        onClick={() => void navigateToRepoEntry(repositoryId)}
        className="flex items-center gap-1.5 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary)"
      >
        <ArrowLeft size={12} />
        Back to {repository?.name ?? "repository"}
      </button>

      <header className="mt-4">
        <h1 className="text-xl font-semibold tracking-tight">Repository settings</h1>
        <p className="mt-1 truncate text-xs text-(--color-text-muted)">
          {repository?.name} · {repository?.localPath ?? "(no local path)"}
        </p>
        <p className="mt-3 text-[12px] text-(--color-text-muted)">
          Run and manage repository workflows from the terminal like npm run dev, pnpm test:watch,
          or turbo build. Pin essential commands for instant access from the repository header.
        </p>
      </header>

      <div className="mt-8">
        <RunCommandsSection repositoryId={repositoryId} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/settings")({
  component: RepositorySettingsPage,
});
