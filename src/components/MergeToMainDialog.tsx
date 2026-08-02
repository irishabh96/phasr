import { Check, ExternalLink, Loader2, Undo2, UploadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { StrategyRadioGroup } from "@/components/ui/StrategyRadioGroup";
import { useShipEpic } from "@/lib/hooks/useBoard";
import {
  useGitBranchStatus,
  useGitMergeToMain,
  useGitPushDefaultBranch,
  useGitRepoAbortMerge,
  useGitSyncWithMain,
} from "@/lib/hooks/useGit";
import { useOpenPullRequest } from "@/lib/hooks/useWorkspaces";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useRepository } from "@/lib/hooks/useRepositories";
import { humanizeError } from "@/lib/humanizeError";
import type { MergeStrategy, Workspace } from "@/lib/types";

interface MergeToMainDialogProps {
  workspace: Workspace;
  open: boolean;
  onClose(): void;
}

/** Merge-to-main never rebases (`git/merge.rs` rejects it) — the dialog's
 *  strategy space is the three merge-shaped options only. */
type MainMergeStrategy = Extract<
  MergeStrategy,
  "merge" | "squash" | "fastForward"
>;

const STRATEGY_OPTIONS = (
  targetBranch: string,
  sourceBranch: string,
  ahead: number,
) =>
  [
    {
      value: "merge",
      label: "Merge commit",
      hint: `Creates a no-ff merge commit on ${targetBranch}.`,
    },
    {
      value: "squash",
      label: "Squash",
      hint: `Collapses ${ahead} commit${ahead === 1 ? "" : "s"} into one on ${targetBranch}.`,
    },
    {
      value: "fastForward",
      label: "Fast-forward",
      hint: `Moves ${targetBranch} to point at ${sourceBranch}.`,
    },
  ] as const satisfies readonly {
    value: MainMergeStrategy;
    label: string;
    hint: string;
  }[];

/**
 * Confirm + execute Merge-to-main — TWO callers, one surface:
 *
 * - A LOOSE workspace (`agent`/`local`): the existing `git_merge_to_main`
 *   flow, unchanged — merge, brief success, auto-close.
 * - A WORKFLOW parent (`kind === "parent"`, the epic Ship gate): `ship_epic`.
 *   Ship is LOCAL-MERGE-ONLY by decision; on a clean ship the dialog stays
 *   open and offers the explicit follow-ups — Push to origin / Open a PR
 *   (remote repos only) — plus a durable `shippedAt` stamped by the backend.
 *   A conflicted ship is never a dead end: the MAIN checkout is left
 *   mid-merge and the dialog offers the one-click repo-scoped Abort.
 *
 * The merge itself always happens in the REPOSITORY's main checkout, not the
 * worktree. Disabled while the branch is behind its target (Sync first).
 */
export function MergeToMainDialog({
  workspace,
  open,
  onClose,
}: MergeToMainDialogProps) {
  const isEpic = workspace.workspaceKind === "parent";
  const { data: repository } = useRepository(workspace.repositoryId);
  const { data: status } = useGitBranchStatus(workspace.id);
  const { data: settings } = useUserSettings();
  const merge = useGitMergeToMain(workspace.id);
  const ship = useShipEpic(workspace.id);
  const sync = useGitSyncWithMain(workspace.id);
  const pushMain = useGitPushDefaultBranch(workspace.repositoryId);
  const abortShip = useGitRepoAbortMerge(workspace.repositoryId);
  const openPr = useOpenPullRequest();

  const [strategy, setStrategy] = useState<MainMergeStrategy>("merge");
  const [error, setError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  // True during the brief post-merge close delay (LOOSE path only) so the
  // primary action can't be fired a second time before the dialog unmounts.
  const [closing, setClosing] = useState(false);
  // GIT-D5: once a merge lands in a conflicted working tree, re-clicking the
  // primary can't help until the conflict is dealt with. On the EPIC path the
  // in-dialog Abort clears this (Ship becomes retryable); the loose path keeps
  // the original reopen-to-retry behavior.
  const [hadConflict, setHadConflict] = useState(false);
  // Epic path: the clean-ship terminal state (explicit follow-ups, no
  // auto-close) + the post-abort reassurance line.
  const [shippedMsg, setShippedMsg] = useState<string | null>(null);
  const [abortedNote, setAbortedNote] = useState<string | null>(null);
  const [prNote, setPrNote] = useState<string | null>(null);

  // Reset state every time we open afresh.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflictNote(null);
    setClosing(false);
    setHadConflict(false);
    setShippedMsg(null);
    setAbortedNote(null);
    setPrNote(null);
    pushMain.reset();
    abortShip.reset();
    openPr.reset();
    const candidate = settings?.defaultMergeStrategy;
    if (
      candidate === "merge" ||
      candidate === "squash" ||
      candidate === "fastForward"
    ) {
      setStrategy(candidate);
    } else {
      setStrategy("merge");
    }
    // The mutation objects are stable references from react-query; this effect
    // must run only on open/default-strategy changes.
  }, [open, settings?.defaultMergeStrategy]);

  // Gate on ahead/behind-of-TARGET, not upstream. The upstream is
  // usually `origin/<this-branch>` which is in sync after a push;
  // what matters here is the relationship to the merge target.
  const ahead = status?.aheadOfTarget ?? 0;
  const behind = status?.behindOfTarget ?? 0;
  const targetBranch = repository?.defaultBranch ?? "main";
  const sourceBranch = workspace.branch ?? "(no branch)";
  const hasRemote = !!repository?.remoteUrl;
  const shipDone = shippedMsg !== null;
  const blockedReason = !workspace.branch
    ? isEpic
      ? "Workflow has no integration branch yet — integrate first."
      : "Workspace has no branch yet."
    : ahead === 0 && !shipDone
      ? `Nothing to merge — branch is already on ${targetBranch}.`
      : behind > 0
        ? `Branch is ${behind} commit${behind === 1 ? "" : "s"} behind ${targetBranch}.`
        : null;
  const canMerge = blockedReason === null && !shipDone;
  const primaryPending = isEpic ? ship.isPending : merge.isPending;
  // Disable the strategy rows / Cancel / primary together while a merge is
  // in flight or the dialog is closing after a clean merge.
  const busy = primaryPending || closing || abortShip.isPending;

  const handleMerge = async () => {
    setError(null);
    setConflictNote(null);
    setAbortedNote(null);
    try {
      if (isEpic) {
        const outcome = await ship.mutateAsync(strategy);
        if (outcome.kind === "clean") {
          // Terminal state — the follow-ups are explicit, never bundled.
          setShippedMsg(`Shipped — ${sourceBranch} merged into ${targetBranch}.`);
        } else {
          setHadConflict(true);
          setConflictNote(
            `Ship stopped on conflicts in the ${targetBranch} checkout: ${formatFileList(outcome.files)}.`,
          );
        }
        return;
      }
      const outcome = await merge.mutateAsync(strategy);
      if (outcome.kind === "clean") {
        // Close after a brief moment so the success state registers.
        // Flag `closing` so the button stays disabled through the delay.
        setClosing(true);
        window.setTimeout(onClose, 800);
      } else {
        setHadConflict(true);
        setConflictNote(
          `Conflicts in main repo working tree: ${formatFileList(outcome.files)}. ` +
            "Resolve via the terminal — Phasr's conflict resolver only operates inside a workspace worktree.",
        );
      }
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  const handleAbortShip = async () => {
    setError(null);
    try {
      await abortShip.mutateAsync();
      setConflictNote(null);
      setHadConflict(false);
      setAbortedNote(
        `Merge aborted — ${targetBranch} is clean again. You can ship once the conflict source is addressed.`,
      );
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  const handlePush = async () => {
    setError(null);
    try {
      await pushMain.mutateAsync();
    } catch {
      // Surfaced inline via pushMain.error below — never silent, never a toast
      // the user might miss while the dialog is open.
    }
  };

  const handleOpenPr = async () => {
    setError(null);
    setPrNote(null);
    try {
      const outcome = await openPr.mutateAsync(workspace.id);
      await openUrl(outcome.url);
      setPrNote(
        `Opened the ${outcome.provider} compare page for ${outcome.headBranch} → ${outcome.baseBranch}.`,
      );
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="480px"
      title={isEpic ? `Ship to ${targetBranch}` : `Merge to ${targetBranch}`}
      description={
        <div className="rounded-md border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-3 py-2 text-[12px] leading-relaxed text-(--color-text-secondary)">
          Merge{" "}
          <code className="font-mono text-(--color-text-primary)">
            {sourceBranch}
          </code>{" "}
          →{" "}
          <code className="font-mono text-(--color-text-primary)">
            {targetBranch}
          </code>{" "}
          in the repository's main checkout.
          {isEpic ? " Pushing is a separate step — nothing leaves this machine." : ""}
        </div>
      }
      footer={
        <>
          <GlassButton
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            {shipDone ? "Close" : "Cancel"}
          </GlassButton>
          {!shipDone && (
            <GlassButton
              variant="primary"
              size="sm"
              onClick={handleMerge}
              disabled={!canMerge || busy || hadConflict}
            >
              {primaryPending ? (
                <>
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                  {isEpic ? "Shipping…" : "Merging…"}
                </>
              ) : isEpic ? (
                "Ship"
              ) : (
                "Merge"
              )}
            </GlassButton>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {blockedReason && !shipDone && (
          <div className="space-y-2 rounded-md border border-[color-mix(in_oklab,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2.5">
            <p className="text-[12px] text-(--color-text-primary)">
              {blockedReason}
            </p>
            {behind > 0 && (
              <GlassButton
                variant="outline"
                size="sm"
                disabled={sync.isPending}
                onClick={async () => {
                  setError(null);
                  setConflictNote(null);
                  try {
                    const outcome = await sync.mutateAsync("merge");
                    if (outcome.kind === "conflicts") {
                      setConflictNote(
                        `Sync hit conflicts in ${outcome.files.length} file${outcome.files.length === 1 ? "" : "s"} — resolve them in the Changes panel, then merge.`,
                      );
                    }
                    // On a clean sync, branch status refetches and the
                    // "behind" gate clears, enabling Merge below.
                  } catch (err) {
                    setError(humanizeError(err));
                  }
                }}
              >
                {sync.isPending
                  ? "Syncing…"
                  : `Sync with ${targetBranch} first`}
              </GlassButton>
            )}
          </div>
        )}

        {canMerge && (
          <StrategyRadioGroup
            legend="Strategy"
            options={STRATEGY_OPTIONS(targetBranch, sourceBranch, ahead)}
            value={strategy}
            onChange={setStrategy}
            disabled={busy}
          />
        )}

        {error && (
          <p role="alert" className="rounded-md border border-[color-mix(in_oklab,var(--color-danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-danger)">
            {error}
          </p>
        )}
        {conflictNote && (
          <div role="status" className="space-y-2 rounded-md border border-[color-mix(in_oklab,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2">
            <p className="text-[11.5px] text-(--color-text-primary)">
              {conflictNote}
            </p>
            {isEpic && hadConflict && (
              <div className="flex flex-wrap items-center gap-2">
                <GlassButton
                  variant="outline"
                  size="sm"
                  onClick={handleAbortShip}
                  disabled={abortShip.isPending}
                >
                  {abortShip.isPending ? (
                    <>
                      <Loader2 size={13} className="animate-spin" aria-hidden />
                      Aborting…
                    </>
                  ) : (
                    <>
                      <Undo2 size={13} aria-hidden />
                      Abort merge
                    </>
                  )}
                </GlassButton>
                <span className="text-[11px] text-(--color-text-secondary)">
                  Restores a clean {targetBranch} — or resolve in your
                  terminal, then Ship again.
                </span>
              </div>
            )}
          </div>
        )}
        {abortedNote && (
          <p role="status" className="rounded-md border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-3 py-2 text-[11.5px] text-(--color-text-secondary)">
            {abortedNote}
          </p>
        )}

        {/* Loose-workspace clean merge: the brief auto-close success. */}
        {!isEpic && merge.isSuccess && merge.data?.kind === "clean" && (
          <div role="status" className="flex items-center gap-2 rounded-md border border-[color-mix(in_oklab,var(--color-success)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-success)_8%,transparent)] px-3 py-2">
            <Check
              size={14}
              className="shrink-0 text-(--color-success)"
              aria-hidden
            />
            <p className="text-[11.5px] text-(--color-text-primary)">
              Merged into {targetBranch}.
            </p>
          </div>
        )}

        {/* Epic clean ship: the terminal state with EXPLICIT follow-ups. */}
        {shipDone && (
          <div className="space-y-3">
            <div role="status" className="flex items-center gap-2 rounded-md border border-[color-mix(in_oklab,var(--color-success)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-success)_8%,transparent)] px-3 py-2">
              <Check
                size={14}
                className="shrink-0 text-(--color-success)"
                aria-hidden
              />
              <p className="text-[11.5px] text-(--color-text-primary)">
                {shippedMsg}
              </p>
            </div>

            {hasRemote ? (
              <div className="space-y-2 rounded-md border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.12em] text-(--color-text-muted)">
                  Publish
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <GlassButton
                    variant="outline"
                    size="sm"
                    onClick={handlePush}
                    disabled={pushMain.isPending || pushMain.isSuccess}
                  >
                    {pushMain.isPending ? (
                      <>
                        <Loader2 size={13} className="animate-spin" aria-hidden />
                        Pushing…
                      </>
                    ) : pushMain.isSuccess ? (
                      <>
                        <Check size={13} aria-hidden />
                        Pushed
                      </>
                    ) : (
                      <>
                        <UploadCloud size={13} aria-hidden />
                        Push {targetBranch} to origin
                      </>
                    )}
                  </GlassButton>
                  <GlassButton
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenPr}
                    disabled={openPr.isPending}
                  >
                    {openPr.isPending ? (
                      <>
                        <Loader2 size={13} className="animate-spin" aria-hidden />
                        Opening…
                      </>
                    ) : (
                      <>
                        <ExternalLink size={13} aria-hidden />
                        Open a PR instead
                      </>
                    )}
                  </GlassButton>
                </div>
                {pushMain.isError && (
                  <p role="alert" className="text-[11.5px] text-(--color-danger)">
                    Push failed: {humanizeError(pushMain.error)}{" "}
                    <button
                      type="button"
                      onClick={handlePush}
                      className="underline underline-offset-2 hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                    >
                      Retry
                    </button>
                  </p>
                )}
                {pushMain.isSuccess && (
                  <p role="status" className="text-[11.5px] text-(--color-text-secondary)">
                    Pushed {targetBranch} to origin.
                  </p>
                )}
                {prNote && (
                  <p role="status" className="text-[11.5px] text-(--color-text-secondary)">
                    {prNote}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11.5px] text-(--color-text-secondary)">
                This repository has no remote — the merge is complete.
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Renders a comma-joined file list, capping at `max` entries so a large
 * conflict set can't blow out the dialog layout. Surplus is summarized as
 * "…, and N more".
 */
function formatFileList(files: string[], max = 8): string {
  if (files.length <= max) return files.join(", ");
  return `${files.slice(0, max).join(", ")}, and ${files.length - max} more`;
}
