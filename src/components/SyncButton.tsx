import { ArrowDownToLine, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  useGitBranchStatus,
  useGitFetch,
  useGitSyncWithMain,
} from "@/lib/hooks/useGit";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { cn } from "@/lib/utils";
import type { MergeStrategy } from "@/lib/types";

interface SyncButtonProps {
  workspaceId: string;
}

/**
 * Sync-with-main control. Shown next to the BranchChip whenever the
 * workspace branch is behind its upstream. Click opens a popover with
 * Merge vs Rebase, defaulted from UserSettings.defaultMergeStrategy.
 * After firing, the result (clean or conflicts) lands automatically in
 * the ChangesPanel — no extra UI here.
 */
export function SyncButton({ workspaceId }: SyncButtonProps) {
  const { data: status } = useGitBranchStatus(workspaceId);
  const { data: settings } = useUserSettings();
  const fetch = useGitFetch(workspaceId);
  const sync = useGitSyncWithMain(workspaceId);

  const [open, setOpen] = useState(false);
  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Seed the strategy from settings the first time settings load. We
  // intentionally don't sync it on every settings change — once the
  // user opens the popover they own the choice for that session.
  const settingsStrategy = settings?.defaultMergeStrategy;
  useEffect(() => {
    if (settingsStrategy === "merge" || settingsStrategy === "rebase") {
      setStrategy(settingsStrategy);
    }
  }, [settingsStrategy]);

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

  // SyncButton is gated on "behind the merge target," NOT "behind
  // upstream" — the upstream is usually `origin/<this-branch>`, which
  // is in sync after a push; what we care about is whether `main`
  // moved. We keep the button visible (with a disabled state +
  // tooltip) so the action is always discoverable.
  const behind = status?.behindOfTarget ?? 0;
  const detached = !!status?.detached;
  // Full ref (e.g. "origin/main") for the precise body line; a friendly, prefix-
  // stripped name (e.g. "main"/"master") for titles + hints so a non-"main"
  // default branch is named correctly and every surface stays consistent.
  const targetLabel = status?.targetRef ?? "main";
  const targetName = targetLabel.replace(/^origin\//, "");
  const blockReason = !status
    ? "Loading branch status…"
    : detached
      ? "Detached HEAD — checkout a branch to sync"
      : behind === 0
        ? `Up to date with ${targetName}`
        : null;
  const canSync = blockReason === null;

  const handleSync = async () => {
    setError(null);
    try {
      // Fetch first so we're up to date with the remote. If there's
      // no network we still try to sync against the local tracking
      // ref — gitFetch will fail loudly but we want to see that.
      await fetch.mutateAsync().catch(() => {
        /* surfaced by the sync call below if the ref is stale */
      });
      await sync.mutateAsync(strategy);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = fetch.isPending || sync.isPending;

  return (
    <div ref={containerRef} className="relative">
      <GlassButton
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={
          blockReason
            ? blockReason
            : `Sync with ${targetName} (${behind} commit${behind === 1 ? "" : "s"} behind)`
        }
        disabled={busy || !canSync}
        className="gap-1"
      >
        <ArrowDownToLine size={11} />
        Sync{behind > 0 ? ` (${behind})` : ""}
        <ChevronDown size={11} className="opacity-60" />
      </GlassButton>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 overflow-hidden glass-modal animate-[modal-in_180ms_var(--ease-glass)]">
          <header className="border-b border-(--glass-border-hairline) px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-(--color-text-muted)">
              Sync with {targetName}
            </p>
            <p className="mt-0.5 text-[12px] text-(--color-text-secondary)">
              Pull{" "}
              <code className="font-mono text-(--color-text-primary)">
                {targetLabel}
              </code>{" "}
              into this branch.
            </p>
          </header>
          <div className="p-2">
            <StrategyRow
              value="merge"
              current={strategy}
              onSelect={setStrategy}
              label="Merge"
              hint="Creates a merge commit on this branch."
            />
            <StrategyRow
              value="rebase"
              current={strategy}
              onSelect={setStrategy}
              label="Rebase"
              hint={`Replays this branch's commits on top of ${targetName}.`}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="border-t border-(--glass-border-hairline) px-3 py-2 text-[11px] text-(--color-danger)"
            >
              {error}
            </p>
          )}
          <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-3 py-2.5">
            <GlassButton variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </GlassButton>
            <GlassButton
              variant="primary"
              size="sm"
              onClick={handleSync}
              disabled={busy}
            >
              {busy ? "Syncing…" : "Sync"}
            </GlassButton>
          </footer>
        </div>
      )}
    </div>
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
