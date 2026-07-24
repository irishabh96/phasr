import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  useGitBranchStatus,
  useGitMergeToMain,
  useGitSyncWithMain,
} from "@/lib/hooks/useGit";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useRepository } from "@/lib/hooks/useRepositories";
import { humanizeError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";
import type { MergeStrategy, Workspace } from "@/lib/types";

interface MergeToMainDialogProps {
  workspace: Workspace;
  open: boolean;
  onClose(): void;
}

/**
 * Confirm + execute Merge-to-main. Disabled when the workspace branch
 * is behind its upstream (the user must Sync first — clicking the
 * link there triggers the SyncButton's flow). The actual merge happens
 * in the REPOSITORY's main checkout, not the worktree.
 */
export function MergeToMainDialog({
  workspace,
  open,
  onClose,
}: MergeToMainDialogProps) {
  const { data: repository } = useRepository(workspace.repositoryId);
  const { data: status } = useGitBranchStatus(workspace.id);
  const { data: settings } = useUserSettings();
  const merge = useGitMergeToMain(workspace.id);
  const sync = useGitSyncWithMain(workspace.id);

  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [error, setError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  // True during the brief post-merge close delay so the primary action
  // can't be fired a second time before the dialog unmounts.
  const [closing, setClosing] = useState(false);
  // GIT-D5: once a merge lands in a conflicted working tree, re-clicking
  // Merge can't help — the user must resolve in the terminal — so the
  // primary action stays disabled until the dialog is reopened.
  const [hadConflict, setHadConflict] = useState(false);

  // Reset state every time we open afresh.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflictNote(null);
    setClosing(false);
    setHadConflict(false);
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
  }, [open, settings?.defaultMergeStrategy]);

  // Gate on ahead/behind-of-TARGET, not upstream. The upstream is
  // usually `origin/<this-branch>` which is in sync after a push;
  // what matters here is the relationship to the merge target.
  const ahead = status?.aheadOfTarget ?? 0;
  const behind = status?.behindOfTarget ?? 0;
  const targetBranch = repository?.defaultBranch ?? "main";
  const sourceBranch = workspace.branch ?? "(no branch)";
  const blockedReason = !workspace.branch
    ? "Workspace has no branch yet."
    : ahead === 0
      ? `Nothing to merge — branch is already on ${targetBranch}.`
      : behind > 0
        ? `Branch is ${behind} commit${behind === 1 ? "" : "s"} behind ${targetBranch}.`
        : null;
  const canMerge = blockedReason === null;
  // Disable the strategy rows / Cancel / Merge together while a merge is
  // in flight or the dialog is closing after a clean merge.
  const busy = merge.isPending || closing;

  const handleMerge = async () => {
    setError(null);
    setConflictNote(null);
    try {
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

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="480px"
      title={`Merge to ${targetBranch}`}
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
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            size="sm"
            onClick={handleMerge}
            disabled={!canMerge || busy || hadConflict}
          >
            {merge.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" aria-hidden />
                Merging…
              </>
            ) : (
              "Merge"
            )}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        {blockedReason && (
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
          <fieldset
            role="radiogroup"
            aria-label="Merge strategy"
            className="space-y-1"
          >
            <legend className="mb-1 text-[11px] uppercase tracking-[0.12em] text-(--color-text-muted)">
              Strategy
            </legend>
            <StrategyRow
              value="merge"
              current={strategy}
              onSelect={setStrategy}
              disabled={busy}
              label="Merge commit"
              hint={`Creates a no-ff merge commit on ${targetBranch}.`}
            />
            <StrategyRow
              value="squash"
              current={strategy}
              onSelect={setStrategy}
              disabled={busy}
              label="Squash"
              hint={`Collapses ${ahead} commit${ahead === 1 ? "" : "s"} into one on ${targetBranch}.`}
            />
            <StrategyRow
              value="fastForward"
              current={strategy}
              onSelect={setStrategy}
              disabled={busy}
              label="Fast-forward"
              hint={`Moves ${targetBranch} to point at ${sourceBranch}.`}
            />
          </fieldset>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-[color-mix(in_oklab,var(--color-danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-danger)">
            {error}
          </p>
        )}
        {conflictNote && (
          <p role="status" className="rounded-md border border-[color-mix(in_oklab,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-text-primary)">
            {conflictNote}
          </p>
        )}
        {merge.isSuccess && merge.data?.kind === "clean" && (
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
      </div>
    </Dialog>
  );
}

function StrategyRow({
  value,
  current,
  onSelect,
  label,
  hint,
  disabled,
}: {
  value: MergeStrategy;
  current: MergeStrategy;
  onSelect: (v: MergeStrategy) => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  const selected = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(value)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100",
        "hover:bg-(--color-bg-hover)",
        "focus-visible:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--color-accent-300)]",
        "disabled:opacity-40 disabled:pointer-events-none",
        selected && "bg-(--color-bg-active)",
      )}
    >
      <span
        className={cn(
          "mt-[3px] inline-block h-3 w-3 shrink-0 rounded-full border",
          selected
            ? "border-(--color-accent-500) bg-(--color-accent-500)"
            : "border-(--glass-border-hairline)",
        )}
        aria-hidden
      />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] leading-none text-(--color-text-primary)">
          {label}
        </span>
        <span className="text-[11px] text-(--color-text-secondary)">
          {hint}
        </span>
      </span>
    </button>
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
