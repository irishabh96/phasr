import { ArrowDownToLine, ChevronDown } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
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
  /**
   * `button` (default): the boxed "Sync (n) ▾" control. `link`: a plain
   * "Sync" text action, as next to Base in the inspector (A-Workspace).
   */
  appearance?: "button" | "link";
}

/**
 * Sync-with-main control. Shown next to the BranchChip whenever the
 * workspace branch is behind its upstream. Click opens a popover with
 * Merge vs Rebase, defaulted from UserSettings.defaultMergeStrategy.
 * After firing, the result (clean or conflicts) lands automatically in
 * the ChangesPanel — no extra UI here.
 */
export function SyncButton({ workspaceId, appearance = "button" }: SyncButtonProps) {
  const { data: status } = useGitBranchStatus(workspaceId);
  const { data: settings } = useUserSettings();
  const fetch = useGitFetch(workspaceId);
  const sync = useGitSyncWithMain(workspaceId);

  const [open, setOpen] = useState(false);
  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [error, setError] = useState<string | null>(null);

  // Seed the strategy from settings the first time settings load. We
  // intentionally don't sync it on every settings change — once the
  // user opens the popover they own the choice for that session.
  const settingsStrategy = settings?.defaultMergeStrategy;
  useEffect(() => {
    if (settingsStrategy === "merge" || settingsStrategy === "rebase") {
      setStrategy(settingsStrategy);
    }
  }, [settingsStrategy]);

  // SyncButton is gated on "behind the merge target," NOT "behind
  // upstream" — the upstream is usually `origin/<this-branch>`, which
  // is in sync after a push; what we care about is whether `main`
  // moved. We keep the button visible (with a disabled state +
  // tooltip) so the action is always discoverable.
  const behind = status?.behindOfTarget ?? 0;
  const detached = !!status?.detached;
  const targetLabel = status?.targetRef ?? "main";
  const blockReason = !status
    ? "Loading branch status…"
    : detached
      ? "Detached HEAD — checkout a branch to sync"
      : behind === 0
        ? `Up to date with ${targetLabel}`
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

  const title = blockReason
    ? blockReason
    : `Sync with ${targetLabel} (${behind} commit${behind === 1 ? "" : "s"} behind)`;

  // A Radix popover (portalled) rather than an absolutely-positioned box:
  // the inspector scrolls, and an in-flow popover would be clipped by it.
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {appearance === "link" ? (
          <button
            type="button"
            title={title}
            disabled={busy || !canSync}
            className="shrink-0 rounded-(--radius-chip) text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-primary) disabled:text-(--color-text-faint) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            {busy ? "Syncing…" : "Sync"}
          </button>
        ) : (
          <GlassButton variant="outline" size="sm" title={title} disabled={busy || !canSync} className="gap-1">
            <ArrowDownToLine size={11} />
            Sync{behind > 0 ? ` (${behind})` : ""}
            <ChevronDown size={11} className="opacity-60" />
          </GlassButton>
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-(--z-popover) w-72 overflow-hidden surface-floating data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <header className="border-b border-(--glass-border-hairline) px-3 py-2">
            <p className="group-header">
              Sync with {status?.baseBranch || targetLabel}
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
              hint="Replays this branch's commits on top of main."
            />
          </div>
          {error && (
            <p className="border-t border-(--glass-border-hairline) px-3 py-2 text-[11px] text-(--color-danger)">
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
        "flex w-full items-start gap-2 rounded-(--radius-control) px-2 py-1.5 text-left transition-colors duration-100",
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
        <span className="text-[12px] leading-none text-(--color-text-primary)">
          {label}
        </span>
        <span className="text-[11px] text-(--color-text-muted)">{hint}</span>
      </span>
    </button>
  );
}
