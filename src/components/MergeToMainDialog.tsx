import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  useGitBranchStatus,
  useGitMergeToMain,
} from "@/lib/hooks/useGit";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useRepository } from "@/lib/hooks/useRepositories";
import { cn } from "@/lib/utils";
import type { MergeStrategy, Workspace } from "@/lib/types";

interface MergeToMainDialogProps {
  workspace: Workspace;
  open: boolean;
  onClose(): void;
  onSyncRequested(): void;
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
  onSyncRequested,
}: MergeToMainDialogProps) {
  const { data: repository } = useRepository(workspace.repositoryId);
  const { data: status } = useGitBranchStatus(workspace.id);
  const { data: settings } = useUserSettings();
  const merge = useGitMergeToMain(workspace.id);

  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [error, setError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);

  // Reset state every time we open afresh.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflictNote(null);
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

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const targetBranch = repository?.defaultBranch ?? "main";
  const sourceBranch = workspace.branch ?? "(no branch)";
  const blockedReason =
    !workspace.branch
      ? "Workspace has no branch yet."
      : ahead === 0
        ? `Nothing to merge — branch is already on ${targetBranch}.`
        : behind > 0
          ? `Branch is ${behind} commit${behind === 1 ? "" : "s"} behind ${targetBranch}.`
          : null;
  const canMerge = blockedReason === null;

  const handleMerge = async () => {
    setError(null);
    setConflictNote(null);
    try {
      const outcome = await merge.mutateAsync(strategy);
      if (outcome.kind === "clean") {
        // Close after a brief moment so the success state registers.
        window.setTimeout(onClose, 800);
      } else {
        setConflictNote(
          `Conflicts in main repo working tree: ${outcome.files.join(", ")}. ` +
            "Resolve via the terminal — Phasr's conflict resolver only operates inside a workspace worktree.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[28vh] z-[190] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal overflow-hidden">
            <header className="flex h-11 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  Merge to {targetBranch}
                </h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>

            <div className="space-y-3 px-4 py-3">
              <Dialog.Description asChild>
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
              </Dialog.Description>

              {blockedReason && (
                <div className="space-y-2 rounded-md border border-(--color-warning)/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2.5">
                  <p className="text-[12px] text-(--color-text-primary)">
                    {blockedReason}
                  </p>
                  {behind > 0 && (
                    <GlassButton
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onClose();
                        onSyncRequested();
                      }}
                    >
                      Sync with {targetBranch} first
                    </GlassButton>
                  )}
                </div>
              )}

              {canMerge && (
                <fieldset className="space-y-1">
                  <legend className="mb-1 text-[11px] uppercase tracking-[0.12em] text-(--color-text-muted)">
                    Strategy
                  </legend>
                  <StrategyRow
                    value="merge"
                    current={strategy}
                    onSelect={setStrategy}
                    label="Merge commit"
                    hint={`Creates a no-ff merge commit on ${targetBranch}.`}
                  />
                  <StrategyRow
                    value="squash"
                    current={strategy}
                    onSelect={setStrategy}
                    label="Squash"
                    hint={`Collapses ${ahead} commit${ahead === 1 ? "" : "s"} into one on ${targetBranch}.`}
                  />
                  <StrategyRow
                    value="fastForward"
                    current={strategy}
                    onSelect={setStrategy}
                    label="Fast-forward"
                    hint={`Moves ${targetBranch} to point at ${sourceBranch}.`}
                  />
                </fieldset>
              )}

              {error && (
                <p className="rounded-md border border-(--color-danger)/30 bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-danger)">
                  {error}
                </p>
              )}
              {conflictNote && (
                <p className="rounded-md border border-(--color-warning)/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-text-primary)">
                  {conflictNote}
                </p>
              )}
              {merge.isSuccess && merge.data?.kind === "clean" && (
                <p className="text-[11.5px] text-(--color-success)">
                  Merged into {targetBranch}.
                </p>
              )}
            </div>

            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={onClose}>
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                size="sm"
                onClick={handleMerge}
                disabled={!canMerge || merge.isPending}
              >
                {merge.isPending ? "Merging…" : "Merge"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StrategyRow({
  value,
  current,
  onSelect,
  label,
  hint,
}: {
  value: MergeStrategy;
  current: MergeStrategy;
  onSelect: (v: MergeStrategy) => void;
  label: string;
  hint: string;
}) {
  const selected = value === current;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors duration-100",
        "hover:bg-(--color-bg-hover)",
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
        <span className="text-[11px] text-(--color-text-muted)">{hint}</span>
      </span>
    </button>
  );
}
