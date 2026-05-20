import { useClerk } from "@clerk/react";
import { isClerkConfigured } from "@/lib/clerk";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Bot,
  CornerDownLeft,
  FolderGit2,
  LogOut,
  Palette,
  Plus,
  Search,
  Settings,
  UserCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusDot } from "@/components/ui/StatusDot";
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
      className="fixed inset-0 z-[200] flex items-start justify-center bg-(--color-bg-overlay) p-0 pt-[14vh] backdrop-blur-md"
      shouldFilter
    >
      <div className="relative w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-hidden rounded-[var(--radius-modal)] bg-(--glass-modal) backdrop-blur-xl animate-[modal-in_200ms_var(--ease-glass)]">
          <div className="flex items-center gap-3 px-5 pt-5 pb-2">
            <Search size={18} className="shrink-0 text-(--color-text-muted)" />
            <Command.Input
              autoFocus
              placeholder="Type a command…"
              value={query}
              onValueChange={setQuery}
              className="h-10 w-full border-0 bg-transparent text-[17px] placeholder:text-(--color-text-muted) shadow-none! outline-none focus:border-transparent! focus:shadow-none! focus:outline-none"
            />
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto px-3 pb-2">
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
                  <Shortcut keys={["⌘", "N"]} />
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

          <div className="flex items-center gap-4 border-t border-(--glass-border-hairline) px-4 py-2.5 text-[11.5px] text-(--color-text-muted)">
            <FooterHint icon={<span className="text-[12px] leading-none">↕</span>} label="Navigate" />
            <FooterHint icon={<CornerDownLeft size={11} />} label="Select" />
            <FooterHint icon={<span className="text-[10px]">esc</span>} label="Close" boxed />
          </div>
        </div>
      </div>
    </Command.Dialog>
  );
}

/**
 * cmdk's internal `scrollIntoView` calls `scrollIntoView({ block: "nearest" })`
 * on the group HEADING — but only when the selected item is the very first
 * child of its group's items container. That heading-scroll drags the new
 * item up toward the top of the viewport, producing the "jump back to top"
 * flicker when arrow-keying across group boundaries.
 *
 * `<PaletteGroup>` wraps `<Command.Group>` and prepends a hidden dummy
 * element as the first child of the items container. Because cmdk's check
 * (`e.parentElement?.firstChild === e`) sees the dummy as the firstChild
 * instead of the actual first item, the heading-scroll branch is always
 * skipped. cmdk falls through to plain `item.scrollIntoView({ block: "nearest" })`,
 * which keeps the highlight at the edge as the list scrolls.
 *
 * The dummy has no `cmdk-item` attribute, so cmdk's item queries ignore it.
 */
function PaletteGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group heading={heading} className={GROUP_CLS}>
      <span hidden aria-hidden="true" />
      {children}
    </Command.Group>
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

function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className={KBD_CLS}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

function FooterHint({
  icon,
  label,
  boxed = false,
}: {
  icon: ReactNode;
  label: string;
  boxed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={
          boxed
            ? "inline-flex h-5 items-center rounded-[5px] bg-(--color-bg-hover) px-1.5 text-(--color-text-secondary)"
            : "inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-(--color-bg-hover) text-(--color-text-secondary)"
        }
      >
        {icon}
      </span>
      {label}
    </span>
  );
}

const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:text-(--color-text-muted)";

const ITEM_CLS = [
  "flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5",
  "scroll-my-2",
  "text-(--color-text-primary)",
  "transition-colors duration-100",
  "aria-selected:bg-(--color-bg-hover)",
].join(" ");

const KBD_CLS =
  "inline-flex h-5 min-w-[20px] items-center justify-center rounded-[5px] bg-(--color-bg-hover) px-1 text-[10.5px] font-medium text-(--color-text-secondary)";
