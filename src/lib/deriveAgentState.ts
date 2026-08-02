import type { DerivedAgentState, Workspace } from "@/lib/types";

/**
 * The UI-facing agent state. Superset of the wire `DerivedAgentState`
 * (`working | idle | wedged | done | failed`) plus three frontend-only buckets
 * the backend never emits:
 *
 * - `resolving` — a just-spawned running row before its first liveness event,
 *   so the very first frame says "Starting…", never an untrue "Working".
 * - `interrupted` — a `stopped` row whose `interruptedAt` is set: a relaunch
 *   orphan (amber, Wedged-family honesty), distinct from a calm user-stop.
 * - `stopped` — a calm user `stop_task` (neutral, no `interruptedAt`).
 *
 * Product decision — honest-neutral: a quiet agent is a neutral `idle` that
 * escalates to amber `wedged`. There is no coral "needs-attention" state at P0.
 */
export type AgentUiState =
  | "resolving"
  | "working"
  | "idle"
  | "wedged"
  | "done"
  | "failed"
  | "interrupted"
  | "stopped";

/** The liveness snapshot the poller pushed for a task (from `agentLiveness`). */
export interface AgentLiveness {
  derivedState: DerivedAgentState;
  /** ISO-8601 UTC of last output; the "Ns ago" counter reads from it. */
  lastActivityAt: string | null;
  /**
   * E-P1: the agent's process subtree was burning CPU over the last poll —
   * why a long-quiet agent can honestly stay Working ("busy, no output").
   * Additive; absent/false whenever the sensor degrades (non-macOS, no pid,
   * sampling failure) — exactly the P0 output-recency behavior.
   */
  busy?: boolean;
}

export interface AgentStateResult {
  state: AgentUiState;
  /**
   * Milliseconds elapsed for the cosmetic "Ns ago" counter — since last
   * activity for the running-liveness states, since finish/interrupt for the
   * terminal ones. `null` when there is no meaningful elapsed time to show
   * (e.g. `resolving`).
   */
  since: number | null;
}

/**
 * A running row younger than this — with no liveness event yet — renders a
 * calm "Starting…" grace instead of an optimistic "Working", so the first
 * frame never claims activity that hasn't happened (spec §C RESOLVING_GRACE).
 */
export const RESOLVING_GRACE_MS = 2000;

type Row = Pick<
  Workspace,
  "status" | "exitCode" | "startedAt" | "finishedAt" | "interruptedAt"
>;

function elapsedSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, now - parsed);
}

/**
 * Derive the honest UI state of an agent from its persisted row, the latest
 * liveness snapshot, and the current wall clock. Pure — unit-tested across
 * every precedence branch. Precedence (spec §S0.1-T1):
 *
 *   completed(exit 0) → done · completed(exit≠0)/failed → failed
 *   running → live.derivedState, else <2s → resolving, else working
 *   stopped + interruptedAt → interrupted · stopped → stopped
 */
export function deriveAgentState(
  row: Row,
  live: AgentLiveness | undefined,
  now: number,
): AgentStateResult {
  switch (row.status) {
    case "completed":
      // The exit-watcher only lands `completed` on a clean exit, but stay
      // honest if a nonzero code ever rides a completed row.
      return row.exitCode != null && row.exitCode !== 0
        ? { state: "failed", since: elapsedSince(row.finishedAt, now) }
        : { state: "done", since: elapsedSince(row.finishedAt, now) };

    case "failed":
      return { state: "failed", since: elapsedSince(row.finishedAt, now) };

    case "running": {
      // Prefer the backend-derived liveness state — it is authoritative and
      // carries the real last-activity stamp.
      if (
        live &&
        (live.derivedState === "working" ||
          live.derivedState === "idle" ||
          live.derivedState === "wedged")
      ) {
        return {
          state: live.derivedState,
          since: elapsedSince(live.lastActivityAt ?? row.startedAt, now),
        };
      }
      // No liveness event yet: a brief grace so the first frame reads
      // "Starting…" instead of "Working", then optimistic Working until the
      // poller's first tick lands (≤ one poll interval).
      const sinceStart = elapsedSince(row.startedAt, now);
      if (sinceStart == null || sinceStart < RESOLVING_GRACE_MS) {
        return { state: "resolving", since: null };
      }
      return { state: "working", since: sinceStart };
    }

    case "stopped":
      // A relaunch orphan (recovery set `interruptedAt`) is the honest amber
      // "interrupted" state; a calm user-stop stays neutral.
      return row.interruptedAt != null
        ? { state: "interrupted", since: elapsedSince(row.interruptedAt, now) }
        : { state: "stopped", since: elapsedSince(row.finishedAt, now) };

    case "pending":
      // About to spawn — the same calm grace as a fresh running row.
      return { state: "resolving", since: null };

    case "archived":
    default:
      return { state: "stopped", since: elapsedSince(row.finishedAt, now) };
  }
}
