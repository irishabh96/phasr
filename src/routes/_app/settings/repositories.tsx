import { createFileRoute } from "@tanstack/react-router";
import { FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { RunCommandsSection } from "@/components/RunCommandsSection";
import { useRepositories } from "@/lib/hooks/useRepositories";

function RepositoriesSettingsPage() {
  const { data: repositories, isLoading } = useRepositories();
  const [showAddMap, setShowAddMap] = useState<Record<string, boolean>>({});

  const toggleAdd = (repoId: string) => {
    setShowAddMap((m) => ({ ...m, [repoId]: !m[repoId] }));
  };

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Run commands</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Run and manage repository workflows from the terminal like npm run dev, pnpm test:watch,
          or turbo build. Pin essential commands for instant access from the repository header.
        </p>
      </header>

      {isLoading && <p className="text-[12px] text-(--color-text-muted)">Loading…</p>}

      {repositories?.map((repo) => (
        <section key={repo.id}>
          <div className="mb-3 flex items-center gap-2">
            <FolderGit2 size={13} className="shrink-0 text-(--color-text-muted)" />
            <span className="text-[13px] font-medium">{repo.name}</span>
            <span className="truncate text-[11px] text-(--color-text-muted)">{repo.localPath}</span>
            <GlassButton
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0"
              onClick={() => toggleAdd(repo.id)}
            >
              <Plus size={12} />
              Add
            </GlassButton>
          </div>
          <RunCommandsSection
            repositoryId={repo.id}
            showAdd={showAddMap[repo.id] ?? false}
            onToggleAdd={() => toggleAdd(repo.id)}
          />
        </section>
      ))}

      {!isLoading && repositories?.length === 0 && (
        <p className="text-[12px] text-(--color-text-muted)">No repositories yet.</p>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/repositories")({
  component: RepositoriesSettingsPage,
});
