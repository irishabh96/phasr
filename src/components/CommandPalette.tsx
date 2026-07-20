import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Check,
  Eye,
  FolderGit2,
  GitMerge,
  LogOut,
  Palette,
  Plus,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Undo2,
  UserCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useGateCommands, type GateCommand } from "@/components/board/useGateCommands";
import { StatusDot } from "@/components/ui/StatusDot";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import type { GateVerb } from "@/lib/deriveNextGate";
import { cn } from "@/lib/utils";
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
import { signOutDesktopSession } from "@/lib/desktopAuth";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { reportP0Warning } from "@/lib/sentry";
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
  const activeContext = useUiStore((s) => s.activeWorkspaceContext);

  const { data: repositories } = useRepositories();
  // The contextual ticket/epic for the Commands group — deduped with the
  // workspace detail route's own `useWorkspace`, so this adds no extra IPC.
  const { data: contextWorkspace } = useWorkspace(activeContext?.workspaceId);

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
        reportP0Warning("Command palette failed to load workspaces", {
          area: "workspace",
          operation: "palette_load_workspaces",
          repositoryCount: repositories.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repositories]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchShortcut(e, SHORTCUTS.togglePalette)) {
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

  // The gate Commands group (G2) — the human mirror of the `phasr` CLI verbs for
  // the contextual ticket/epic. Reuses the SAME `deriveNextGate` ladder + the
  // SAME `tauri.ts` mutations as the NextGateButton; owns its own confirm/
  // comment/merge dialogs (rendered at a STABLE mount below, outside the palette
  // dialog, so they survive the palette closing on select).
  const gate = useGateCommands({
    workspace: contextWorkspace,
    active: open,
    onDispatch: close,
  });

  const recentWorkspaces = useMemo(
    () =>
      workspaces.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [workspaces],
  );

  return (
    <>
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

            {gate.hasContext && gate.commands.length > 0 && (
              <PaletteGroup heading="Commands">
                {gate.commands.map((cmd) => (
                  <GateCommandItem
                    key={`${cmd.scope}-${cmd.verb}`}
                    cmd={cmd}
                  />
                ))}
              </PaletteGroup>
            )}

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
                  <PaletteShortcut keys={SHORTCUTS.newWorkspace.display} />
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

            <SignOutGroup onPick={go} />
          </Command.List>

          <PaletteFooter />
        </div>
      </div>
    </Command.Dialog>
    {gate.dialogs}
    </>
  );
}

const GATE_ICON: Record<GateVerb, typeof Check> = {
  start: ShieldCheck,
  validate: ShieldCheck,
  "request-review": Eye,
  approve: Check,
  bounce: Undo2,
  integrate: GitMerge,
  ship: Rocket,
};

/**
 * One gate command row (G2). Neutral by doctrine — only honest status carries
 * semantic color, never a verb. A disabled command is NEVER hidden: it renders
 * muted with its `reason` inline + as `title` (+ `aria-disabled`), the ⌘K mirror
 * of the NextGateButton's disabled-with-reason gate.
 */
function GateCommandItem({ cmd }: { cmd: GateCommand }) {
  const Icon = GATE_ICON[cmd.verb];
  return (
    <Command.Item
      data-testid={`gate-command-${cmd.verb}`}
      data-gate-enabled={cmd.enabled}
      value={`command gate ${cmd.label} ${cmd.keywords}`}
      disabled={!cmd.enabled}
      onSelect={() => {
        if (cmd.enabled) cmd.select();
      }}
      className={cn(ITEM_CLS, !cmd.enabled && "opacity-55")}
      {...(cmd.reason ? { title: cmd.reason } : {})}
    >
      <Icon size={15} className="shrink-0 text-(--color-text-secondary)" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{cmd.label}</div>
        <div className="truncate text-[11.5px] text-(--color-text-muted)">
          {cmd.enabled ? cmd.description : cmd.reason}
        </div>
      </div>
      {cmd.confirm && cmd.enabled ? (
        <span className="shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-(--color-text-muted)">
          Confirm
        </span>
      ) : null}
    </Command.Item>
  );
}

function SignOutGroup({ onPick }: { onPick: (fn: () => void) => void }) {
  return (
    <PaletteGroup heading="Session">
      <Command.Item
        value="sign out logout"
        onSelect={() =>
          onPick(() => {
            void signOutDesktopSession().then(() => {
              window.location.href = "/sign-in";
            });
          })
        }
        className={ITEM_CLS}
      >
        <LogOut size={15} className="shrink-0 text-(--color-danger)" />
        <span className="flex-1 text-[15px] text-(--color-danger)">Sign out</span>
      </Command.Item>
    </PaletteGroup>
  );
}
