import { useClerk } from "@clerk/react";
import { isClerkConfigured } from "@/lib/clerk";
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
import {
  ITEM_CLS,
  PALETTE_DIALOG_CLS,
  PALETTE_INPUT_CLS,
  PALETTE_INPUT_ROW_CLS,
  PALETTE_LIST_CLS,
  PALETTE_SHELL_CLS,
} from "@/components/ui/palette";
import {
  PaletteFooter,
  PaletteGroup,
  PaletteShortcut,
} from "@/components/ui/PaletteParts";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Repository, Workspace } from "@/lib/types";

interface WorkspaceEntry extends Workspace {
  repositoryName: string;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const openPalette = useUiStore((s) => s.openCommandPalette);
  const closePalette = useUiStore((s) => s.closeCommandPalette);
  const togglePalette = useUiStore((s) => s.toggleCommandPalette);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { setTheme } = useUiStore();
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const navigateToRepoEntry = useNavigateToRepoEntry();

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
        togglePalette();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [togglePalette]);

  const close = () => {
    closePalette();
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
      onOpenChange={(o) => (o ? openPalette() : close())}
      label="Command palette"
      className={PALETTE_DIALOG_CLS}
      shouldFilter
    >
      <div className="relative w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className={PALETTE_SHELL_CLS}>
          <div className={PALETTE_INPUT_ROW_CLS}>
            <Search size={18} className="shrink-0 text-(--color-text-muted)" />
            <Command.Input
              autoFocus
              placeholder="Type a command…"
              value={query}
              onValueChange={setQuery}
              className={PALETTE_INPUT_CLS}
            />
          </div>

          <Command.List className={PALETTE_LIST_CLS}>
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-(--color-text-muted)">
              No matches.
            </Command.Empty>

            {recentWorkspaces.length > 0 && (
              <PaletteGroup heading="Workspaces">
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
                      <div className="truncate text-[15px]">{ws.name}</div>
                      <div className="truncate text-[11.5px] text-(--color-text-muted)">
                        {ws.repositoryName} · {ws.status}
                      </div>
                    </div>
                  </Command.Item>
                ))}
              </PaletteGroup>
            )}

            {repositories && repositories.length > 0 && (
              <PaletteGroup heading="Repositories">
                {repositories.map((repo: Repository) => (
                  <Command.Item
                    key={repo.id}
                    value={`repository ${repo.name} ${repo.localPath ?? ""} ${repo.remoteUrl ?? ""}`}
                    onSelect={() => go(() => void navigateToRepoEntry(repo.id))}
                    className={ITEM_CLS}
                  >
                    <FolderGit2 size={15} className="shrink-0 text-(--color-text-secondary)" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px]">{repo.name}</div>
                      <div className="truncate text-[11.5px] text-(--color-text-muted)">
                        {repo.localPath ?? "(no local path)"}
                      </div>
                    </div>
                  </Command.Item>
                ))}
              </PaletteGroup>
            )}

            <PaletteGroup heading="Actions">
              {repositories?.map((repo) => (
                <Command.Item
                  key={`new-${repo.id}`}
                  value={`action new workspace in ${repo.name}`}
                  onSelect={() => go(() => requestNewWorkspace(repo.id))}
                  className={ITEM_CLS}
                >
                  <Plus size={15} className="shrink-0 text-(--color-text-secondary)" />
                  <span className="flex-1 text-[15px]">
                    New workspace in <span className="font-medium">{repo.name}</span>
                  </span>
                  <PaletteShortcut keys={["⌘", "N"]} />
                </Command.Item>
              ))}
            </PaletteGroup>

            <PaletteGroup heading="Settings">
              <Command.Item
                value="settings account profile sign out user"
                onSelect={() => go(() => navigate({ to: "/settings/account" }))}
                className={ITEM_CLS}
              >
                <UserCircle size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Account</span>
              </Command.Item>
              <Command.Item
                value="settings appearance theme accent color"
                onSelect={() => go(() => navigate({ to: "/settings/appearance" }))}
                className={ITEM_CLS}
              >
                <Palette size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Appearance</span>
              </Command.Item>
              <Command.Item
                value="settings agents ai claude codex cursor"
                onSelect={() => go(() => navigate({ to: "/settings/agents" }))}
                className={ITEM_CLS}
              >
                <Bot size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Agents</span>
              </Command.Item>
              <Command.Item
                value="settings all"
                onSelect={() => go(() => navigate({ to: "/settings" }))}
                className={ITEM_CLS}
              >
                <Settings size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Open settings</span>
              </Command.Item>
            </PaletteGroup>

            <PaletteGroup heading="Theme">
              <Command.Item
                value="theme dark"
                onSelect={() => go(() => setTheme("dark"))}
                className={ITEM_CLS}
              >
                <Palette size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Switch to dark theme</span>
              </Command.Item>
              <Command.Item
                value="theme light"
                onSelect={() => go(() => setTheme("light"))}
                className={ITEM_CLS}
              >
                <Palette size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Switch to light theme</span>
              </Command.Item>
              <Command.Item
                value="theme system"
                onSelect={() => go(() => setTheme("system"))}
                className={ITEM_CLS}
              >
                <Palette size={15} className="shrink-0 text-(--color-text-secondary)" />
                <span className="flex-1 text-[15px]">Match system theme</span>
              </Command.Item>
            </PaletteGroup>

            {isClerkConfigured && <SignOutGroup onPick={go} />}
          </Command.List>

          <PaletteFooter />
        </div>
      </div>
    </Command.Dialog>
  );
}

/**
 * Sign-out entry. Lives in its own component so `useClerk()` is only
 * called when Clerk is configured — without a ClerkProvider in the
 * tree the hook would throw.
 */
function SignOutGroup({ onPick }: { onPick: (fn: () => void) => void }) {
  const { signOut } = useClerk();
  return (
    <PaletteGroup heading="Session">
      <Command.Item
        value="sign out logout"
        onSelect={() => onPick(() => void signOut())}
        className={ITEM_CLS}
      >
        <LogOut size={15} className="shrink-0 text-(--color-danger)" />
        <span className="flex-1 text-[15px] text-(--color-danger)">Sign out</span>
      </Command.Item>
    </PaletteGroup>
  );
}
