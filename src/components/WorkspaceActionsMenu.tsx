import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowDownToLine,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  MoreHorizontal,
  Play,
  Plus,
  Rocket,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { useGateCommands } from "@/components/board/useGateCommands";
import { ConfirmDialog, ErrorDialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import type { GateVerb } from "@/lib/deriveNextGate";
import {
  useGitBranchStatus,
  useGitFetch,
  useGitSyncWithMain,
} from "@/lib/hooks/useGit";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import {
  useArchiveWorkspace,
  useCheckWorkspaceDelete,
  useDeleteWorkspace,
  useOpenPullRequest,
} from "@/lib/hooks/useWorkspaces";
import { reportP0Error } from "@/lib/sentry";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { dismissToast, showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { LauncherKind, Workspace } from "@/lib/types";

interface WorkspaceActionsMenuProps {
  workspace: Workspace;
  /**
   * The header is width-constrained and has folded the standalone Sync control
   * away (H2). Surface a one-click "Sync with main" here (default strategy from
   * settings) so the action stays reachable when the toolbar is compact — the
   * full merge/rebase popover returns with the header Sync button once wide.
   */
  compact?: boolean;
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function WorkspaceActionsMenu({
  workspace,
  compact = false,
}: WorkspaceActionsMenuProps) {
  const { data: repository } = useRepository(workspace.repositoryId);
  const { data: branchStatus } = useGitBranchStatus(workspace.id);
  const { data: settings } = useUserSettings();
  const navigate = useNavigate();
  const archive = useArchiveWorkspace();
  const openPr = useOpenPullRequest();
  const checkDelete = useCheckWorkspaceDelete();
  const deleteWorkspace = useDeleteWorkspace();
  const fetch = useGitFetch(workspace.id);
  const sync = useGitSyncWithMain(workspace.id);

  // Lower-frequency header controls folded into this ⋯ overflow (M3): the repo
  // Run picker + the "Open in <app>" launchers, so the 40px ticket header keeps
  // only branch · status · tabs · Changes · the one next gate · ⋯.
  const { data: runCommands } = useRunCommands(workspace.repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);
  const { data: launchers } = useQuery({
    queryKey: ["launchers"],
    queryFn: () => tauri.listLaunchers(),
    staleTime: 60_000,
  });

  // After archive/delete, kick the user back to home — the sidebar will
  // surface a different workspace to select.
  const leaveWorkspace = () => {
    void navigate({ to: "/" });
  };

  const [open, setOpen] = useState(false);
  const [errorState, setErrorState] = useState<{
    title: string;
    error: unknown;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // The gate verbs as context-menu items (G3) — the same `deriveNextGate` ladder
  // + `tauri.ts` mutations as the ⌘K Commands group and the NextGateButton.
  // Promotes Ship out of the overflow into a first-class, ConfirmDialog-guarded
  // action (R7). `dialogs` (confirm / bounce / MergeToMainDialog) render at this
  // component's stable mount, so they survive the menu closing on select.
  const gate = useGateCommands({
    workspace,
    active: open,
    onDispatch: () => setOpen(false),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isLocalWorkspace = workspace.workspaceKind === "local";
  const canOpenPr =
    !isLocalWorkspace && !!workspace.branch && !!repository?.remoteUrl;
  const canArchive = !isLocalWorkspace && workspace.status !== "archived";
  const canMergeToMain =
    !isLocalWorkspace && !!workspace.branch && !!repository?.localPath;
  const mergeBlocked = !branchStatus
    ? null
    : branchStatus.aheadOfTarget === 0
      ? "Nothing to merge"
      : branchStatus.behindOfTarget > 0
        ? `Branch is behind ${repository?.defaultBranch ?? "main"} — sync first`
        : null;

  // Raw error is humanized inside ErrorDialog (never shown raw).
  const showError = (title: string, error: unknown) => {
    setErrorState({ title, error });
  };

  const handleArchive = () => {
    setOpen(false);
    archive.mutate(workspace.id, {
      onSuccess: leaveWorkspace,
      onError: (err) => showError("Couldn't archive workspace", err),
    });
  };

  const handleOpenPr = async () => {
    setOpen(false);
    // Open PR pushes the branch then opens the compare page — several
    // seconds during which the menu is already gone. Surface a toast so
    // the action isn't silent; dismiss it once the browser opens (or an
    // error dialog takes over).
    const toastId = showToast({
      title: "Opening pull request…",
      message: "Pushing your branch, then opening the compare page.",
      intent: "info",
      timeoutMs: 30000,
    });
    try {
      const result = await openPr.mutateAsync(workspace.id);
      dismissToast(toastId);
      await openUrl(result.url);
    } catch (err) {
      dismissToast(toastId);
      showError("Couldn't open pull request", err);
    }
  };

  const handleDelete = async () => {
    setOpen(false);
    let warning = "";
    try {
      const check = await checkDelete.mutateAsync(workspace.id);
      if (check.hasUnpushedCommits) {
        warning =
          "\n\nThis branch has commits that haven't been pushed to origin.";
      }
    } catch {
      /* non-blocking */
    }
    setConfirmState({
      title: `Delete workspace "${workspace.name}"?`,
      body:
        `This stops the agent, removes the worktree, and deletes the branch ` +
        `${workspace.branch ?? ""}. The agent's commits on this branch will be gone.${warning}`,
      confirmLabel: "Delete workspace",
      destructive: true,
      onConfirm: () => {
        setConfirmState(null);
        deleteWorkspace.mutate(
          { id: workspace.id, repositoryId: workspace.repositoryId },
          {
            onSuccess: leaveWorkspace,
            onError: (err) => showError("Couldn't delete workspace", err),
          },
        );
      },
    });
  };

  const handleLaunch = async (id: string) => {
    const launcher = launchers?.find((item) => item.id === id);
    if (launcher && !launcher.available) return;
    setOpen(false);
    if (!workspace.worktreePath) return;
    try {
      await tauri.launchApp(id, workspace.worktreePath);
    } catch (err) {
      reportP0Error(`Failed to open via ${id}`, err, {
        area: "launcher",
        operation: "open_external_tool",
        launcherId: id,
      });
    }
  };

  const handlePickRun = (id: string) => {
    setOpen(false);
    runPanel.openTab(id);
  };

  const handleAddRunCommand = () => {
    setOpen(false);
    void navigate({
      to: "/repositories/$repositoryId/settings",
      params: { repositoryId: workspace.repositoryId },
    });
  };

  // Compact-only "Sync with main": the same gating as SyncButton (behind the
  // merge target, not detached), run with the user's default strategy so the
  // menu stays a single tap. The full strategy popover returns with the header
  // Sync button once the toolbar has room.
  const syncBehind = branchStatus?.behindOfTarget ?? 0;
  // Friendly, prefix-stripped target name so this item matches the header Sync
  // button's copy ("Sync with main", not "…origin/main").
  const syncTarget = (branchStatus?.targetRef ?? "main").replace(
    /^origin\//,
    "",
  );
  const syncBlockReason = !branchStatus
    ? "Loading branch status…"
    : branchStatus.detached
      ? "Detached HEAD — checkout a branch to sync"
      : syncBehind === 0
        ? `Up to date with ${syncTarget}`
        : null;
  const syncBusy = fetch.isPending || sync.isPending;
  const handleCompactSync = () => {
    setOpen(false);
    const strategy =
      settings?.defaultMergeStrategy === "rebase" ? "rebase" : "merge";
    void (async () => {
      try {
        await fetch.mutateAsync().catch(() => {
          /* stale-ref failure surfaces on the sync call below */
        });
        await sync.mutateAsync(strategy);
      } catch (err) {
        showError("Couldn't sync with main", err);
      }
    })();
  };

  // Local workspaces expose no gate / merge / PR / archive / delete here — the
  // destructive "Remove from Phasr" still lives in the sidebar's right-click
  // menu. They DO keep the utility Run + Open-in sections that used to sit in
  // the header, so consolidating the header (M3) doesn't strip a local
  // workspace of them.
  const hasWorktree = !!workspace.worktreePath;
  const launcherList = launchers ?? [];
  const runList = runCommands ?? [];

  return (
    <>
      <div ref={containerRef} className="relative">
        <GlassButton
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          title="Workspace actions"
          className="gap-0.5 px-1.5"
        >
          <MoreHorizontal size={13} />
          <ChevronDown size={11} />
        </GlassButton>

        {open && (
          <div className="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden glass-modal animate-[modal-in_180ms_var(--ease-glass)]">
            <ul className="p-1 text-[12.5px]">
              {gate.hasContext && gate.commands.length > 0 && (
                <>
                  {gate.commands.map((cmd) => (
                    <MenuItem
                      key={`${cmd.scope}-${cmd.verb}`}
                      icon={<GateMenuIcon verb={cmd.verb} />}
                      label={cmd.label}
                      onClick={cmd.select}
                      disabled={!cmd.enabled}
                      {...(cmd.reason ? { title: cmd.reason } : {})}
                    />
                  ))}
                  <li
                    className="my-1 h-px bg-(--glass-border-hairline)"
                    aria-hidden
                  />
                </>
              )}

              {/* Sync with main, folded in from the header when the toolbar is
                  compact (H2) so the primary gate is never pushed off-screen. */}
              {compact && hasWorktree && !isLocalWorkspace && (
                <>
                  <MenuItem
                    icon={<ArrowDownToLine size={12} />}
                    label={
                      syncBusy
                        ? "Syncing…"
                        : `Sync with ${syncTarget}${syncBehind > 0 ? ` (${syncBehind})` : ""}`
                    }
                    onClick={handleCompactSync}
                    disabled={syncBusy || !!syncBlockReason}
                    {...(syncBlockReason ? { title: syncBlockReason } : {})}
                  />
                  <li
                    className="my-1 h-px bg-(--glass-border-hairline)"
                    aria-hidden
                  />
                </>
              )}

              {/* Run a repository command (folded in from the header — M3). */}
              <MenuLabel>Run</MenuLabel>
              {runList.length === 0 ? (
                <MenuItem
                  icon={
                    <Plus size={12} className="text-(--color-text-muted)" />
                  }
                  label="Add run command…"
                  onClick={handleAddRunCommand}
                />
              ) : (
                runList.map((rc) => (
                  <MenuItem
                    key={rc.id}
                    icon={<Play size={11} fill="currentColor" />}
                    label={rc.name}
                    title={rc.command}
                    onClick={() => handlePickRun(rc.id)}
                  />
                ))
              )}

              {/* Open the worktree in another app (folded in from the header — M3). */}
              {hasWorktree && launcherList.length > 0 && (
                <>
                  <li
                    className="my-1 h-px bg-(--glass-border-hairline)"
                    aria-hidden
                  />
                  <MenuLabel>Open in</MenuLabel>
                  {launcherList.map((launcher) => (
                    <MenuItem
                      key={launcher.id}
                      icon={<LauncherIcon kind={launcher.kind} />}
                      label={launcher.name}
                      disabled={!launcher.available}
                      title={
                        launcher.available
                          ? launcher.name
                          : "Not installed or not found"
                      }
                      onClick={() => handleLaunch(launcher.id)}
                    />
                  ))}
                </>
              )}

              {(canMergeToMain || canOpenPr || canArchive) && (
                <li
                  className="my-1 h-px bg-(--glass-border-hairline)"
                  aria-hidden
                />
              )}
              {canMergeToMain && (
                <MenuItem
                  icon={<GitMerge size={12} />}
                  label={`Merge to ${repository?.defaultBranch ?? "main"}`}
                  onClick={() => {
                    setOpen(false);
                    setMergeOpen(true);
                  }}
                  disabled={!!mergeBlocked}
                  {...(mergeBlocked ? { title: mergeBlocked } : {})}
                />
              )}
              {canOpenPr && (
                <MenuItem
                  icon={<GitPullRequest size={12} />}
                  label={
                    openPr.isPending
                      ? "Pushing & opening…"
                      : "Open pull request"
                  }
                  onClick={handleOpenPr}
                  disabled={openPr.isPending}
                />
              )}
              {canArchive && (
                <MenuItem
                  icon={<Archive size={12} />}
                  label="Archive"
                  onClick={handleArchive}
                  disabled={archive.isPending}
                />
              )}
              {!isLocalWorkspace && (
                <>
                  <li
                    className="my-1 h-px bg-(--glass-border-hairline)"
                    aria-hidden
                  />
                  <MenuItem
                    icon={<Trash2 size={12} />}
                    label="Delete workspace"
                    onClick={handleDelete}
                    disabled={deleteWorkspace.isPending}
                    danger
                  />
                </>
              )}
            </ul>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmState !== null}
        onOpenChange={(o) => !o && setConfirmState(null)}
        title={confirmState?.title ?? ""}
        description={confirmState?.body ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        destructive={confirmState?.destructive ?? false}
        onConfirm={() => confirmState?.onConfirm()}
      />

      <ErrorDialog
        open={errorState !== null}
        onOpenChange={(o) => !o && setErrorState(null)}
        title={errorState?.title}
        error={errorState?.error}
      />

      <MergeToMainDialog
        workspace={workspace}
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
      />

      {gate.dialogs}
    </>
  );
}

const GATE_MENU_ICON: Record<GateVerb, typeof Check> = {
  start: ShieldCheck,
  validate: ShieldCheck,
  "request-review": Eye,
  approve: Check,
  bounce: Undo2,
  integrate: GitMerge,
  ship: Rocket,
};

/** Neutral gate glyph for the ⋯ menu (only status carries color, never a verb). */
function GateMenuIcon({ verb }: { verb: GateVerb }) {
  const Icon = GATE_MENU_ICON[verb];
  return <Icon size={12} />;
}

/** Muted section header inside the ⋯ menu (Run / Open in groups). */
function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <li
      aria-hidden
      className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-(--color-text-muted)"
    >
      {children}
    </li>
  );
}

/** Per-kind launcher glyph for the "Open in" group. */
function LauncherIcon({ kind }: { kind: LauncherKind }) {
  if (kind === "editor") return <ExternalLink size={12} />;
  if (kind === "terminal") return <TerminalSquare size={12} />;
  return <FolderOpen size={12} />;
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={cn(
          "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left",
          "transition-colors duration-100",
          "hover:bg-(--color-bg-hover)",
          danger
            ? "text-(--color-danger) hover:bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)]"
            : "text-(--color-text-primary)",
          "disabled:opacity-60",
        )}
      >
        {icon}
        <span className="flex-1 leading-none">{label}</span>
      </button>
    </li>
  );
}
