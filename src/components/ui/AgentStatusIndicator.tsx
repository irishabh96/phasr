import type { CSSProperties } from "react";
import type { AgentUiState } from "@/lib/deriveAgentState";
import {
  agentActivityText,
  agentStatusMeta,
} from "@/components/ui/agentStatusMeta";
import { cn } from "@/lib/utils";

/**
 * The sidebar's honest-status glyph (Step 0 — S0.1-T2). A 16px slot holding
 * either a dot (Working pulses info; Idle/Stopped a calm muted dot) or a
 * colored lucide icon (Wedged hourglass, Done check, Failed alert, …). Pure —
 * the meaning-bearing neutral-AA label lives in the adjacent
 * `<AgentStatusMetaLine>`, so this glyph is never the sole signal.
 *
 * Wedged deliberately has NO animation — a frozen agent must not look alive.
 */
export function AgentStatusIndicator({
  state,
  className,
}: {
  state: AgentUiState;
  className?: string;
}) {
  const meta = agentStatusMeta(state);

  return (
    <span
      role="img"
      aria-label={meta.label}
      data-agent-state={state}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center",
        className,
      )}
    >
      {meta.dot ? (
        <span
          className="inline-block size-2 rounded-full"
          style={dotStyle(meta.colorVar, meta.pulse)}
        />
      ) : (
        <meta.Icon
          className={cn("size-[14px]", meta.spin && "animate-spin")}
          style={{ color: meta.colorVar }}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function dotStyle(colorVar: string, pulse: boolean): CSSProperties {
  const base: CSSProperties = { background: colorVar };
  if (!pulse) return base;
  return {
    ...base,
    // Reuse the existing `pulse-dot` keyframes (index.css). Reduced-motion is
    // handled globally there.
    ["--pulse-color" as string]: colorVar,
    animation: "pulse-dot 2s ease-in-out infinite",
  };
}

/**
 * The sidebar row's honest-status meta line — "Working · active 2s ago". The
 * label carries meaning in `--color-text-primary`; the "· Ns ago" suffix is
 * `--color-text-muted` (spec §S0.1 WCAG standard). Replaces the branch code
 * on agent rows (S0.1-T3).
 */
export function AgentStatusMetaLine({
  state,
  since,
  changeCount,
  exitCode,
  className,
}: {
  state: AgentUiState;
  since: number | null;
  changeCount?: number | null;
  exitCode?: number | null;
  className?: string;
}) {
  const meta = agentStatusMeta(state);
  const activity = agentActivityText({ state, since, changeCount, exitCode });

  return (
    <span
      data-agent-state={state}
      className={cn(
        "flex min-w-0 items-center gap-1 text-[10.5px] leading-none",
        className,
      )}
    >
      <span
        data-testid="agent-status-label"
        className="shrink-0 font-medium text-(--color-text-primary)"
      >
        {meta.label}
      </span>
      {activity ? (
        <span className="truncate text-(--color-text-muted)">
          · {activity}
        </span>
      ) : null}
    </span>
  );
}
