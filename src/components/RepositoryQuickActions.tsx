import { Code2, FileSearch, Plus, Terminal as TerminalIcon } from "lucide-react";
import { useEffect } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import { labelForLauncher } from "@/lib/launchers";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { Repository } from "@/lib/types";

interface QuickActionsProps {
  repository: Repository;
  onNewWorkspace: () => void;
}

/**
 * The empty state shown on the workspaces tab when no workspaces exist
 * yet. Three quick actions:
 *   ⌘T → opens a Terminal tab in the repo's tab strip (in-app PTY)
 *   ⌘E → launches the user's default external editor at the repo path
 *   ⌘P → opens the repo file-search modal (which itself opens a Preview tab)
 *
 * Plus a primary "+ New workspace" CTA. Listeners use capture-phase
 * + stopImmediatePropagation so the keystrokes survive any default
 * webview handling (e.g. Chromium's `⌘T` "new tab" reservation).
 */
export function RepositoryQuickActions({ repository, onNewWorkspace }: QuickActionsProps) {
  const { data: settings } = useUserSettings();
  const openFileSearch = useUiStore((s) => s.openFileSearch);
  const openTerminalTab = useUiStore((s) => s.openTerminalTab);

  const path = repository.localPath ?? "";
  const editorId = settings?.defaultEditor ?? "vscode";

  const openTerminal = () => {
    if (!path) return;
    openTerminalTab(repository.id);
  };

  const openEditor = async () => {
    if (!path) return;
    try {
      await tauri.launchApp(editorId, path);
    } catch (err) {
      console.error("launchApp editor failed", err);
    }
  };

  const openFiles = () => {
    if (!path) return;
    openFileSearch(repository.id, path);
  };

  // Global ⌘T / ⌘E / ⌘P, registered in capture phase so they fire
  // before any default browser/webview handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        e.stopImmediatePropagation();
        openTerminal();
      } else if (key === "e") {
        e.preventDefault();
        e.stopImmediatePropagation();
        void openEditor();
      } else if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openFiles();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editorId, repository.id]);

  return (
    <div className="w-full max-w-md">
      <div className="flex flex-col gap-0.5">
        <ActionRow
          icon={<TerminalIcon size={14} />}
          label="Open terminal"
          shortcut="⌘ T"
          onClick={openTerminal}
        />
        <ActionRow
          icon={<Code2 size={14} />}
          label={`Open in ${labelForLauncher(editorId)}`}
          shortcut="⌘ E"
          onClick={openEditor}
        />
        <ActionRow
          icon={<FileSearch size={14} />}
          label="Search files in this project"
          shortcut="⌘ P"
          onClick={openFiles}
        />
      </div>

      <div className="mt-6 flex justify-center">
        <GlassButton variant="primary" size="md" onClick={onNewWorkspace}>
          <Plus size={13} />
          New workspace
        </GlassButton>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-[10px] bg-transparent px-3 py-2 text-left",
        "transition-colors duration-150",
        "hover:bg-white/15",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-(--color-accent-500)/15 text-(--color-accent-400)">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[0.875rem] font-medium leading-none text-(--color-text-primary)">
        {label}
      </span>
      <kbd className="shrink-0 rounded-[6px] border border-(--glass-border-hairline) bg-white/5 px-1.5 py-0.5 text-[1em] font-medium leading-none text-(--color-text-secondary) group-hover:text-(--color-text-primary)">
        {shortcut}
      </kbd>
    </button>
  );
}
