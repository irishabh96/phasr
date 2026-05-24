import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useCreateRepository, useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";

/**
 * The "Open existing project" flow without an intermediate modal.
 *
 * Returns a callable that:
 *  1. Pops the native folder picker.
 *  2. On selection: validates the path, deduplicates against existing
 *     repos, and registers a new Repository with the folder basename.
 *  3. Routes the user — to the existing repo if duplicate, to the
 *     GitInitConfirmModal if the folder isn't git yet, or to the new
 *     repo's home (CreateFirstWorkspacePane).
 *
 * Errors from the picker / Tauri commands fail silently for v1 — the
 * picker enforces directory selection so the validate path is rarely
 * useful in practice.
 */
export function useOpenExistingFlow(): () => Promise<void> {
  const createRepository = useCreateRepository();
  const { data: existing } = useRepositories();
  const requestGitInit = useUiStore((s) => s.requestGitInit);
  const navigateToRepoEntry = useNavigateToRepoEntry();

  return async () => {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a folder to use as a repository",
      });
    } catch {
      return;
    }
    if (typeof selected !== "string") return;

    let status: Awaited<ReturnType<typeof tauri.validateRepositoryPath>>;
    try {
      status = await tauri.validateRepositoryPath(selected);
    } catch {
      return;
    }
    if (!status.exists || !status.isDir) return;

    const canonical = (status.absolutePath ?? selected).replace(/\/$/, "");

    const duplicate = existing?.find(
      (r) => r.localPath && r.localPath.replace(/\/$/, "") === canonical,
    );
    if (duplicate) {
      void navigateToRepoEntry(duplicate.id);
      return;
    }

    const segments = selected.split(/[/\\]/).filter(Boolean);
    const name = segments[segments.length - 1] ?? "Repository";

    let repository: Awaited<ReturnType<typeof createRepository.mutateAsync>>;
    try {
      repository = await createRepository.mutateAsync({
        name,
        localPath: selected,
      });
    } catch {
      return;
    }

    if (!status.isGitRepo) {
      requestGitInit(repository.id);
      return;
    }
    void navigateToRepoEntry(repository.id);
  };
}
