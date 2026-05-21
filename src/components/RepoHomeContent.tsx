import {
  ExternalLink,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useDeleteRepository } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RepoHomeContentProps {
  repo: Repository;
}

/**
 * "Home" tab body for the repo inner-tab bar: the quick-action list
 * (Open Terminal / Open in VS Code / Search Files) plus a Delete
 * repository control. Local keyboard bindings (⌘T / ⌘O / ⌘P) are wired
 * here since the global handlers in `_app.tsx` require an active
 * workspace context.
 */
export function RepoHomeContent({ repo }: RepoHomeContentProps) {
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const openFileSearch = useUiStore((s) => s.openFileSearch);
  const deleteRepo = useDeleteRepository();
  const [confirming, setConfirming] = useState(false);

  const openTerminal = useCallback(() => {
    requestNewWorkspace(repo.id);
  }, [repo.id, requestNewWorkspace]);

  const openInEditor = useCallback(() => {
    if (!repo.localPath) return;
    void tauri.launchApp("vscode", repo.localPath).catch(() => {
      /* VS Code not installed; future wire-up should surface a toast */
    });
  }, [repo.localPath]);

  const searchFiles = useCallback(() => {
    if (!repo.localPath) return;
    openFileSearch(repo.id, repo.localPath);
  }, [repo.id, repo.localPath, openFileSearch]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (key === "t") {
        e.preventDefault();
        e.stopImmediatePropagation();
        openTerminal();
      } else if (key === "o") {
        e.preventDefault();
        openInEditor();
      } else if (key === "p") {
        e.preventDefault();
        searchFiles();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [openTerminal, openInEditor, searchFiles]);

  const handleDelete = async () => {
    await deleteRepo.mutateAsync(repo.id);
    setConfirming(false);
  };

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-md">
        <ul className="flex flex-col">
          <ActionRow
            icon={<SquareTerminal size={15} />}
            label="Open Terminal"
            shortcut={["⌘", "T"]}
            onClick={openTerminal}
          />
          <ActionRow
            icon={<ExternalLink size={15} />}
            label="Open in VS Code"
            shortcut={["⌘", "O"]}
            onClick={openInEditor}
            disabled={!repo.localPath}
          />
          <ActionRow
            icon={<Search size={15} />}
            label="Search Files"
            shortcut={["⌘", "P"]}
            onClick={searchFiles}
            disabled={!repo.localPath}
          />
        </ul>

        <div className="mt-8 flex justify-center">
          {confirming ? (
            <div className="flex items-center gap-2 text-[12px] text-(--color-text-secondary)">
              <span>
                Delete <span className="font-medium">{repo.name}</span>?
              </span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteRepo.isPending}
                className="rounded px-2 py-0.5 text-(--color-danger) hover:bg-(--color-bg-hover)"
              >
                {deleteRepo.isPending ? "Deleting…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded px-2 py-0.5 text-(--color-text-muted) hover:bg-(--color-bg-hover)"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12.5px] text-(--color-text-muted)/60 transition-colors hover:text-(--color-danger)"
            >
              <Trash2 size={12} />
              Delete repository
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string[];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "enabled:hover:bg-(--color-bg-hover)",
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-(--color-text-muted) group-enabled:group-hover:text-(--color-text-primary)">
          {icon}
        </span>
        <span className="flex-1 truncate text-[13px] text-(--color-text-secondary) group-enabled:group-hover:text-(--color-text-primary)">
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
          {shortcut.map((k, i) => (
            <kbd
              key={i}
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-1.5 text-(--color-text-muted)"
            >
              {k}
            </kbd>
          ))}
        </span>
      </button>
    </li>
  );
}
