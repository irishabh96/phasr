import { GitBranch } from "lucide-react";
import { useGitBranchStatus } from "@/lib/hooks/useGit";
import { cn } from "@/lib/utils";

interface BranchChipProps {
  workspaceId: string;
  className?: string;
}

/**
 * Compact branch + ahead/behind indicator shown in the workspace
 * header. Pairs with the Push button in ChangesPanel — when ahead > 0,
 * Push is enabled; the chip lights up the count in the accent color so
 * the user knows there's something to push.
 *
 * Detached HEAD is displayed as a short SHA. "no upstream" is shown
 * only when a remote is configured but the branch has never been
 * pushed yet (the typical state right after `phasr/<slug>` is born).
 */
export function BranchChip({ workspaceId, className }: BranchChipProps) {
  const { data: status } = useGitBranchStatus(workspaceId);
  if (!status) return null;

  const label = status.detached ? status.branch.slice(0, 7) : status.branch;

  return (
    <span
      aria-label={
        status.upstream
          ? `Branch ${label}, ${status.ahead} ahead, ${status.behind} behind`
          : `Branch ${label}`
      }
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2",
        "border border-(--glass-border-hairline)",
        "bg-[color-mix(in_oklab,var(--color-bg-elevated)_70%,transparent)]",
        "text-[11px] font-medium leading-none text-(--color-text-secondary)",
        className,
      )}
    >
      <GitBranch size={11} className="shrink-0" />
      <code className="font-mono leading-none text-(--color-text-primary)">{label}</code>
      {status.upstream && (status.ahead > 0 || status.behind > 0) && (
        <span className="flex items-center gap-1 text-(--color-text-muted)">
          {status.ahead > 0 && (
            <span className="text-(--color-accent-400)">↑{status.ahead}</span>
          )}
          {status.behind > 0 && (
            <span className="text-(--color-warning)">↓{status.behind}</span>
          )}
        </span>
      )}
      {!status.upstream && status.hasRemote && !status.detached && (
        <span className="text-(--color-text-muted)">no upstream</span>
      )}
    </span>
  );
}
