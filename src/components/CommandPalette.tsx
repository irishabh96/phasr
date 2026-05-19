import { useClerk } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Bot,
  FolderGit2,
  LogOut,
  Palette,
  Plus,
  Search,
  Settings,
  UserCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusDot } from "@/components/ui/StatusDot";
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

  const recentWorkspaces = useMemo(
    () =>
      workspaces.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [workspaces],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : close())}
      label="Command palette"
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/30 p-0 pt-[14vh] backdrop-blur-md"
      shouldFilter
    >
      <div className="relative w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        {/* Accent halo behind the modal */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-8 -z-10 rounded-[28px] opacity-60 blur-2xl"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, color-mix(in oklab, var(--color-accent-500) 35%, transparent), transparent)",
          }}
        />
        <div className="glass-modal animate-[modal-in_200ms_var(--ease-glass)] overflow-hidden">
          <div className="flex items-center gap-2 border-b border-(--glass-border-hairline) px-3">
            <Search size={13} className="text-(--color-text-muted)" />
            <Command.Input
              autoFocus
              placeholder="Type to search repositories, workspaces, settings…"
              value={query}
              onValueChange={setQuery}
              className="h-12 w-full border-0 bg-transparent text-[13.5px] focus:outline-none"
            />
            <kbd className="rounded-[5px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,white_4%,transparent)] px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">
              esc
            </kbd>
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-[12px] text-(--color-text-muted)">
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
                          params: { repositoryId: ws.repositoryId, workspaceId: ws.id },
                        }),
                      )
                    }
                    className={ITEM_CLS}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <StatusDot status={ws.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{ws.name}</div>
                      <div className="truncate text-[10.5px] text-(--color-text-muted)">
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
                    <FolderGit2 size={13} className="text-(--color-text-secondary)" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{repo.name}</div>
                      <div className="truncate text-[10.5px] text-(--color-text-muted)">
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
                  <Plus size={13} className="text-(--color-text-secondary)" />
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
                <UserCircle size={13} className="text-(--color-text-secondary)" />
                Account
              </Command.Item>
              <Command.Item
                value="settings appearance theme accent color"
                onSelect={() => go(() => navigate({ to: "/settings/appearance" }))}
                className={ITEM_CLS}
              >
                <Palette size={13} className="text-(--color-text-secondary)" />
                Appearance
              </Command.Item>
              <Command.Item
                value="settings agents ai claude codex cursor"
                onSelect={() => go(() => navigate({ to: "/settings/agents" }))}
                className={ITEM_CLS}
              >
                <Bot size={13} className="text-(--color-text-secondary)" />
                Agents
              </Command.Item>
              <Command.Item
                value="settings all"
                onSelect={() => go(() => navigate({ to: "/settings" }))}
                className={ITEM_CLS}
              >
                <Settings size={13} className="text-(--color-text-secondary)" />
                Open settings
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Theme" className={GROUP_CLS}>
              <Command.Item
                value="theme dark"
                onSelect={() => go(() => setTheme("dark"))}
                className={ITEM_CLS}
              >
                <Palette size={13} className="text-(--color-text-secondary)" />
                Switch to dark theme
              </Command.Item>
              <Command.Item
                value="theme light"
                onSelect={() => go(() => setTheme("light"))}
                className={ITEM_CLS}
              >
                <Palette size={13} className="text-(--color-text-secondary)" />
                Switch to light theme
              </Command.Item>
              <Command.Item
                value="theme system"
                onSelect={() => go(() => setTheme("system"))}
                className={ITEM_CLS}
              >
                <Palette size={13} className="text-(--color-text-secondary)" />
                Match system theme
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Session" className={GROUP_CLS}>
              <Command.Item
                value="sign out logout"
                onSelect={() => go(() => void signOut())}
                className={ITEM_CLS}
              >
                <LogOut size={13} className="text-(--color-danger)" />
                <span className="text-(--color-danger)">Sign out</span>
              </Command.Item>
            </Command.Group>
          </Command.List>

          <div className="flex items-center justify-between border-t border-(--glass-border-hairline) px-3 py-2 text-[10.5px] text-(--color-text-muted)">
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLS}>↑</kbd>
              <kbd className={KBD_CLS}>↓</kbd>
              <span className="ml-0.5">navigate</span>
              <kbd className={`${KBD_CLS} ml-2`}>↵</kbd>
              <span className="ml-0.5">open</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className={KBD_CLS}>⌘K</kbd>
              <span>toggle</span>
            </span>
          </div>
        </div>
      </div>
    </Command.Dialog>
  );
}

const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-(--color-text-muted)";

const ITEM_CLS = [
  "relative flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-2 text-[13px]",
  "text-(--color-text-secondary)",
  "transition-colors duration-100",
  "aria-selected:bg-[color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]",
  "aria-selected:text-(--color-text-primary)",
  "aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-1.5 aria-selected:before:bottom-1.5 aria-selected:before:w-0.5 aria-selected:before:rounded-r-full aria-selected:before:bg-(--color-accent-500)",
].join(" ");

const KBD_CLS =
  "inline-block rounded-[4px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,white_4%,transparent)] px-1 text-[9.5px] text-(--color-text-secondary)";
