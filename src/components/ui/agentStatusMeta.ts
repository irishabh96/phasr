import {
  Circle,
  CircleAlert,
  CircleCheck,
  Hourglass,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { AgentUiState } from "@/lib/deriveAgentState";
import { formatDuration } from "@/lib/formatDuration";

/**
 * How an agent state is drawn (spec §S0.1-T2 tiers). Meaning ALWAYS rides the
 * neutral-AA `label` (rendered in `--color-text-primary`); color/icon are
 * reinforcement, never the sole signal — so no state depends on a bare
 * sub-3:1 colored glyph.
 *
 * - `bare`  — colored icon + neutral label (Working, Done, Resolving).
 * - `soft`  — 14%-tint chip + colored icon + neutral label (Wedged, Failed,
 *             Interrupted). The frozen/attention states.
 * - `muted` — calm grey, no fanfare (Idle, Stopped).
 */
export type StatusTier = "bare" | "soft" | "muted";

export interface AgentStatusMeta {
  /** Neutral-AA meaning label — ALWAYS rendered in `--color-text-primary`. */
  label: string;
  /** The state's semantic color token as a `var(--color-…)` string. */
  colorVar: string;
  tier: StatusTier;
  /** Icon for the header badge (and sidebar, for non-dot states). */
  Icon: LucideIcon;
  /** Icon spins (the `Loader2` idiom) — Working & Resolving only. */
  spin: boolean;
  /**
   * The sidebar renders a small dot (not an icon) for these calm lifecycle
   * states; the header still renders `Icon` (Working → spinner, others → dot).
   */
  dot: boolean;
  /**
   * The dot pulses — Working ONLY. A frozen (Wedged) or quiet (Idle) agent must
   * never look alive, so nothing else pulses.
   */
  pulse: boolean;
}

const MUTED = "var(--color-text-muted)";

export function agentStatusMeta(state: AgentUiState): AgentStatusMeta {
  switch (state) {
    case "working":
      return {
        label: "Working",
        colorVar: "var(--color-info)",
        tier: "bare",
        Icon: Loader2,
        spin: true,
        dot: true,
        pulse: true,
      };
    case "resolving":
      return {
        label: "Starting…",
        colorVar: MUTED,
        tier: "muted",
        Icon: Loader2,
        spin: true,
        dot: false,
        pulse: false,
      };
    case "idle":
      return {
        label: "Idle",
        colorVar: MUTED,
        tier: "muted",
        Icon: Circle,
        spin: false,
        dot: true,
        pulse: false,
      };
    case "wedged":
      return {
        label: "Wedged",
        colorVar: "var(--color-warning)",
        tier: "soft",
        Icon: Hourglass,
        spin: false,
        dot: false,
        pulse: false,
      };
    case "done":
      return {
        label: "Done",
        colorVar: "var(--color-success)",
        tier: "bare",
        Icon: CircleCheck,
        spin: false,
        dot: false,
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        colorVar: "var(--color-danger)",
        tier: "soft",
        Icon: CircleAlert,
        spin: false,
        dot: false,
        pulse: false,
      };
    case "interrupted":
      return {
        label: "Interrupted",
        colorVar: "var(--color-warning)",
        tier: "soft",
        Icon: TriangleAlert,
        spin: false,
        dot: false,
        pulse: false,
      };
    case "stopped":
      return {
        label: "Stopped",
        colorVar: MUTED,
        tier: "muted",
        Icon: Circle,
        spin: false,
        dot: true,
        pulse: false,
      };
  }
}

/** Running-liveness states drive the 1 Hz "Ns ago" ticker; nothing else does. */
export function isLiveState(state: AgentUiState): boolean {
  return state === "working" || state === "idle" || state === "wedged";
}

/**
 * The honest "· Ns ago" activity phrasing for a state (spec copy). Returns
 * `null` when there's nothing meaningful to append (e.g. `resolving`, whose
 * meaning is already in the label).
 */
export function agentActivityText(args: {
  state: AgentUiState;
  since: number | null;
  changeCount?: number | null | undefined;
  exitCode?: number | null | undefined;
}): string | null {
  const { state, since, changeCount, exitCode } = args;
  const ago = since != null ? formatDuration(since) : null;
  switch (state) {
    case "working":
      return ago ? `active ${ago} ago` : "active";
    case "idle":
      return ago ? `quiet ${ago}` : "quiet";
    case "wedged":
      return ago ? `no output ${ago}` : "no output";
    case "resolving":
      return null;
    case "done":
      if (changeCount != null && changeCount > 0) {
        return `review · ${changeCount} ${changeCount === 1 ? "change" : "changes"}`;
      }
      return ago ? `finished ${ago} ago` : "needs review";
    case "failed":
      if (exitCode != null) return `exit code ${exitCode}`;
      return ago ? `failed ${ago} ago` : "failed";
    case "interrupted":
      return "interrupted on relaunch";
    case "stopped":
      return ago ? `stopped ${ago} ago` : "stopped";
  }
}
