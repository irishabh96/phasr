import { GitBranch, GitCommit } from "lucide-react";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { useGitBranchStatus } from "@/lib/hooks/useGit";
import { useUiStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";
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
  const theme = useUiStore((s) => s.theme);
  const isLight = resolveTheme(theme) === "light";
  if (!status) return null;

  const label = status.detached ? status.branch.slice(0, 7) : status.branch;
  const Icon = status.detached ? GitCommit : GitBranch;

  const chip = (
    <span
      aria-label={
        status.detached
          ? `Detached HEAD at ${label}`
          : status.upstream
            ? `Branch ${label}, ${status.ahead} ahead, ${status.behind} behind`
            : `Branch ${label}`
      }
      className={cn(
        // Flex-SHRINKS in the header so the branch name truncates (native
        // tooltip on the <code>) instead of shoving the primary gate off-screen
        // (H2). A min-width floor keeps a few chars + the hover target visible.
        "inline-flex h-6 min-w-[3.5rem] items-center gap-1.5 rounded-full px-2",
        "border border-(--glass-border-hairline)",
        "bg-[color-mix(in_oklab,var(--color-bg-elevated)_70%,transparent)]",
        "text-[11px] font-medium leading-none text-(--color-text-secondary)",
        className,
      )}
    >
      <Icon size={11} className="shrink-0" />
      <code
        title={status.detached ? undefined : status.branch}
        className="min-w-0 max-w-[160px] truncate font-mono leading-none text-(--color-text-primary)"
      >
        {label}
      </code>
      {status.upstream && (status.ahead > 0 || status.behind > 0) && (
        <span className="flex shrink-0 items-center gap-1 text-(--color-text-muted)">
          {status.ahead > 0 && (
            // Small count text needs AA body (4.5:1) on the chip's near-white
            // surface in light — accent-text (accent-700) only reaches 4:1
            // there, so light steps to accent-800 (5.7:1). Dark keeps the pale
            // accent-text (7.8:1 on the dark chip).
            <span
              className={
                isLight
                  ? "text-(--color-accent-800)"
                  : "text-(--color-accent-text)"
              }
            >
              ↑{status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            // Use the AA-tuned soft-chip warning glyph token (light b45309 =
            // 4.8:1) — raw --color-warning falls to 3.2:1 on white.
            <span className="text-(--chip-warning-fg)">↓{status.behind}</span>
          )}
        </span>
      )}
      {!status.upstream && status.hasRemote && !status.detached && (
        <span className="text-(--color-text-muted)">no upstream</span>
      )}
    </span>
  );

  if (status.detached) {
    return (
      <GlassTooltip content={`Detached HEAD at ${label}`} side="bottom">
        {chip}
      </GlassTooltip>
    );
  }

  return chip;
}
