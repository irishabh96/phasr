import type { CSSProperties } from "react";
import { RotateCcw } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  agentActivityText,
  agentStatusMeta,
  isLiveState,
} from "@/components/ui/agentStatusMeta";
import { deriveAgentState, type AgentUiState } from "@/lib/deriveAgentState";
import { useAgentLiveness } from "@/lib/agentLiveness";
import { useRestartAgent } from "@/lib/hooks/useRestartAgent";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";

const RECOVERABLE: ReadonlySet<AgentUiState> = new Set<AgentUiState>([
  "wedged",
  "failed",
  "interrupted",
]);

/**
 * The workspace-header honest-status badge (Step 0 — S0.1-T2). Pure/presentational
 * so `/design-test` can render every state headlessly. Three tiers: bare
 * (colored icon + neutral label), soft (14%-tint chip), muted (calm grey). The
 * live region is polite (`role="status"`) — an ambient indicator, not an alert;
 * assertive announcements are reserved for the terminal overlay + DDR-003 toast.
 *
 * A compact Restart is one click away for the recoverable states so no
 * Wedged/Failed/Interrupted surface is a dead end (DDR-002 / S0.2-T2).
 */
export function AgentStatusBadgeView({
  state,
  since,
  changeCount,
  exitCode,
  onRestart,
}: {
  state: AgentUiState;
  since: number | null;
  changeCount?: number | null;
  exitCode?: number | null;
  onRestart?: () => void;
}) {
  const meta = agentStatusMeta(state);
  const activity = agentActivityText({ state, since, changeCount, exitCode });
  const isSoft = meta.tier === "soft";
  const showRestart = onRestart != null && RECOVERABLE.has(state);

  const chipStyle: CSSProperties | undefined = isSoft
    ? {
        background: `color-mix(in oklab, ${meta.colorVar} 14%, var(--color-bg-surface))`,
        borderColor: `color-mix(in oklab, ${meta.colorVar} 34%, transparent)`,
      }
    : undefined;

  return (
    <div
      data-agent-state={state}
      data-testid="agent-status-badge"
      className="flex shrink-0 items-center gap-1.5"
    >
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2",
          "text-[12px] font-medium leading-none",
          isSoft && "border",
        )}
        style={chipStyle}
      >
        {meta.dot && !meta.spin ? (
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: meta.colorVar }}
            aria-hidden="true"
          />
        ) : (
          <meta.Icon
            className={cn("size-[13px] shrink-0", meta.spin && "animate-spin")}
            style={{ color: meta.colorVar }}
            aria-hidden="true"
          />
        )}
        <span
          data-testid="agent-badge-label"
          className="text-(--color-text-primary)"
        >
          {meta.label}
        </span>
        {activity ? (
          <span className="text-(--color-text-muted)">{activity}</span>
        ) : null}
      </span>

      {showRestart ? (
        <GlassButton
          variant="outline"
          size="sm"
          onClick={onRestart}
          className="h-6 gap-1 px-2 text-[11px]"
          data-testid="agent-restart"
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          Restart
        </GlassButton>
      ) : null}
    </div>
  );
}

/**
 * Connected header badge: reads the workspace row + latest liveness snapshot,
 * runs the 1 Hz "Ns ago" ticker (only while the row is running), and derives
 * the honest state. Mounts only on agent workspaces.
 */
export function AgentStatusBadge({
  workspaceId,
  repositoryId,
  changeCount,
}: {
  workspaceId: string;
  repositoryId: string;
  changeCount?: number;
}) {
  const { data: workspace } = useWorkspace(workspaceId);
  const live = useAgentLiveness(workspaceId);
  const restart = useRestartAgent(workspaceId, repositoryId);
  // Tick only while the live counter is meaningful: a running-liveness state,
  // or a running row still resolving (optimistic Working). Never for terminal
  // states (done/failed/stopped) — they don't count up second-by-second.
  const now = useNow(
    isLiveState(
      live?.derivedState ??
        (workspace?.status === "running" ? "working" : "stopped"),
    ),
  );

  if (!workspace || workspace.workspaceKind !== "agent") return null;

  const { state, since } = deriveAgentState(workspace, live, now);

  return (
    <AgentStatusBadgeView
      state={state}
      since={since}
      exitCode={workspace.exitCode}
      {...(changeCount != null ? { changeCount } : {})}
      onRestart={restart}
    />
  );
}
