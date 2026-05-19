import { useClerk } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Bot,
  FileCode,
  FolderGit2,
  LogOut,
  Palette,
  Plus,
  Search,
  Settings,
  UserCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Repository, Workspace } from "@/lib/types";

interface WorkspaceEntry extends Workspace {
  repositoryName: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const { setTheme } = useUiStore();

  const { data: repositories } = useRepositories();

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);

  // Refresh the workspace list each time the palette opens (cheap enough
  // at our expected scale; avoids stale data without another query hook).
  useEffect(() => {
    if (!open || !repositories) return;
    let cancelled = false;
    (async () => {
      try {
        const all: WorkspaceEntry[] = [];
        for (const repo of repositories) {
          const list = await tauri.listWorkspaces(repo.id);
          for (const ws of list) {
            all.push({ ...ws, repositoryName: repo.name });
          }
        }
        if (!cancelled) setWorkspaces(all);
      } catch (err) {
        console.warn("palette: failed to load workspaces", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repositories]);

  // ⌘K / Ctrl+K → toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const go = (fn: () => void) => {
    close();
    fn();
  };

  // Pre-sort: most-recent workspaces first.
  const recentWorkspaces = useMemo(
    () =>
      workspaces
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [workspaces],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : close())}
      label="Command palette"
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 p-0 pt-[12vh] backdrop-blur-sm"
      shouldFilter
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-(--color-border-default) bg-(--color-bg-elevated) shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-(--color-border-subtle) px-3">
          <Search size={14} className="text-(--color-text-muted)" />
          <Command.Input
            autoFocus
            placeholder="Type to search repositories, workspaces, settings…"
            value={query}
            onValueChange={setQuery}
            className="h-11 w-full border-0 bg-transparent text-sm focus:outline-none"
          />
          <kbd className="rounded border border-(--color-border-default) bg-(--color-bg-input) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">
            esc
          </kbd>
        </div>

        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-xs text-(--color-text-muted)">
            No matches.
          </Command.Empty>

          {recentWorkspaces.length > 0 && (
            <Command.Group heading="Workspaces" className={GROUP_CLS}>
              {recentWorkspaces.map((ws) => (
                <Command.Item
                  key={ws.id}
                  value={`workspace ${ws.repositoryName} ${ws.name} ${ws.command} ${ws.prompt ?? ""}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/repositories/$repositoryId/workspaces/$workspaceId",
                        params: {
                          repositoryId: ws.repositoryId,
                          workspaceId: ws.id,
                        },
                      }),
                    )
                  }
                  className={ITEM_CLS}
                >
                  <FileCode size={14} className="text-(--color-text-secondary)" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{ws.name}</div>
                    <div className="truncate text-[10px] text-(--color-text-muted)">
                      {ws.repositoryName} · {ws.status}
                    </div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {repositories && repositories.length > 0 && (
            <Command.Group heading="Repositories" className={GROUP_CLS}>
              {repositories.map((repo: Repository) => (
                <Command.Item
                  key={repo.id}
                  value={`repository ${repo.name} ${repo.localPath ?? ""} ${repo.remoteUrl ?? ""}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/repositories/$repositoryId",
                        params: { repositoryId: repo.id },
                      }),
                    )
                  }
                  className={ITEM_CLS}
                >
                  <FolderGit2 size={14} className="text-(--color-text-secondary)" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{repo.name}</div>
                    <div className="truncate text-[10px] text-(--color-text-muted)">
                      {repo.localPath ?? "(no local path)"}
                    </div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Actions" className={GROUP_CLS}>
            {repositories?.map((repo) => (
              <Command.Item
                key={`new-${repo.id}`}
                value={`action new workspace in ${repo.name}`}
                onSelect={() =>
                  go(() =>
                    navigate({
                      to: "/repositories/$repositoryId",
                      params: { repositoryId: repo.id },
                    }),
                  )
                }
                className={ITEM_CLS}
              >
                <Plus size={14} className="text-(--color-text-secondary)" />
                <span>
                  New workspace in <span className="font-medium">{repo.name}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Settings" className={GROUP_CLS}>
            <Command.Item
              value="settings account profile sign out user"
              onSelect={() => go(() => navigate({ to: "/settings/account" }))}
              className={ITEM_CLS}
            >
              <UserCircle size={14} className="text-(--color-text-secondary)" />
              Account
            </Command.Item>
            <Command.Item
              value="settings appearance theme accent color"
              onSelect={() => go(() => navigate({ to: "/settings/appearance" }))}
              className={ITEM_CLS}
            >
              <Palette size={14} className="text-(--color-text-secondary)" />
              Appearance
            </Command.Item>
            <Command.Item
              value="settings agents ai claude codex cursor"
              onSelect={() => go(() => navigate({ to: "/settings/agents" }))}
              className={ITEM_CLS}
            >
              <Bot size={14} className="text-(--color-text-secondary)" />
              Agents
            </Command.Item>
            <Command.Item
              value="settings all"
              onSelect={() => go(() => navigate({ to: "/settings" }))}
              className={ITEM_CLS}
            >
              <Settings size={14} className="text-(--color-text-secondary)" />
              Open settings
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Theme" className={GROUP_CLS}>
            <Command.Item
              value="theme dark"
              onSelect={() => go(() => setTheme("dark"))}
              className={ITEM_CLS}
            >
              <Palette size={14} className="text-(--color-text-secondary)" />
              Switch to dark theme
            </Command.Item>
            <Command.Item
              value="theme light"
              onSelect={() => go(() => setTheme("light"))}
              className={ITEM_CLS}
            >
              <Palette size={14} className="text-(--color-text-secondary)" />
              Switch to light theme
            </Command.Item>
            <Command.Item
              value="theme system"
              onSelect={() => go(() => setTheme("system"))}
              className={ITEM_CLS}
            >
              <Palette size={14} className="text-(--color-text-secondary)" />
              Match system theme
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Session" className={GROUP_CLS}>
            <Command.Item
              value="sign out logout"
              onSelect={() => go(() => void signOut())}
              className={ITEM_CLS}
            >
              <LogOut size={14} className="text-(--color-danger)" />
              Sign out
            </Command.Item>
          </Command.Group>
        </Command.List>

        <div className="flex items-center justify-between border-t border-(--color-border-subtle) px-3 py-1.5 text-[10px] text-(--color-text-muted)">
          <span>
            <kbd className={KBD_CLS}>↑</kbd> <kbd className={KBD_CLS}>↓</kbd> to navigate ·{" "}
            <kbd className={KBD_CLS}>↵</kbd> to open
          </span>
          <span>
            <kbd className={KBD_CLS}>⌘ K</kbd> to toggle
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}

const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-(--color-text-muted)";

const ITEM_CLS =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-(--color-text-primary) aria-selected:bg-(--color-bg-base)";

const KBD_CLS =
  "inline-block rounded border border-(--color-border-default) bg-(--color-bg-input) px-1 text-[9px] text-(--color-text-muted)";
