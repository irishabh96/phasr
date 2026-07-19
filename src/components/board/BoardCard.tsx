import type { CSSProperties } from "react";
import { Check, Eye, Loader2, Lock } from "lucide-react";
import { AgentStatusBadgeView } from "@/components/AgentStatusBadge";
import { AgentStatusIndicator } from "@/components/ui/AgentStatusIndicator";
import { GlassButton } from "@/components/ui/GlassButton";
import type { BoardCardState } from "@/lib/deriveBoardState";
import type { AgentUiState } from "@/lib/deriveAgentState";
import { cn } from "@/lib/utils";

/** A board-card state that is a plain honest agent state (Step 0). */
function isAgentUiState(state: BoardCardState): state is AgentUiState {
  return state !== "blocked" && state !== "needs-review";
}

export interface BoardCardViewProps {
  /** DAG slot label, e.g. "backend" / "frontend". `null` renders the name only. */
  role: string | null;
  name: string;
  state: BoardCardState;
  since: number | null;
  exitCode?: number | null;
  /**
   * Producer roles this card is blocked on (for the "waiting for backend"
   * chip). Only meaningful when `state === "blocked"`.
   */
  blockedOnRoles?: string[];
  /**
   * "Mark done" override (E2-T4). Supplied ONLY for a producer subtask that
   * hasn't published its handoff contract yet — clicking manually publishes it
   * so a stuck agent never leaves its dependent silently blocked. Omit to hide
   * the affordance entirely (blocked consumers, already-published producers).
   */
  onMarkDone?: () => void;
  /** Disables the "Mark done" button + shows a spinner while publishing. */
  markDonePending?: boolean;
}

/**
 * A read-only board card (S2-T1). PURE/presentational so `/design-test` renders
 * every state headlessly. For a live subtask it REUSES Step 0's honest
 * `AgentStatusIndicator` + `AgentStatusBadgeView` (no card ever lies). The two
 * board-only buckets get calm, purpose-built chips:
 *
 * - `blocked`      — NEUTRAL/MUTED lock chip, "waiting for backend". Never coral:
 *                    a blocked agent is not the user's fault and not an alert.
 * - `needs-review` — a soft `info` chip inviting the human's integrate review.
 *
 * The card is NOT draggable — its lane is derived, not user-assigned.
 */
export function BoardCardView({
  role,
  name,
  state,
  since,
  exitCode,
  blockedOnRoles = [],
  onMarkDone,
  markDonePending = false,
}: BoardCardViewProps) {
  return (
    <article
      data-testid="board-card"
      data-board-state={state}
      data-role={role ?? undefined}
      className="flex flex-col gap-2 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) p-3"
    >
      <div className="flex items-center gap-2">
        <CardGlyph state={state} />
        {role && (
          <span
            data-testid="board-card-role"
            className="rounded-full border border-(--glass-border-hairline) bg-(--color-bg-input) px-2 py-0.5 text-[11px] font-medium text-(--color-text-primary)"
          >
            {role}
          </span>
        )}
        <span className="min-w-0 truncate text-[12px] text-(--color-text-secondary)">
          {name}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isAgentUiState(state) ? (
          <AgentStatusBadgeView
            state={state}
            since={since}
            {...(exitCode != null ? { exitCode } : {})}
          />
        ) : state === "blocked" ? (
          <BlockedChip blockedOnRoles={blockedOnRoles} />
        ) : (
          <ReviewChip />
        )}
        {onMarkDone && (
          <GlassButton
            variant="ghost"
            size="sm"
            data-testid="board-mark-done"
            className="ml-auto shrink-0 gap-1"
            disabled={markDonePending}
            onClick={onMarkDone}
            title="Publish this subtask's handoff contract so its dependents unblock."
          >
            {markDonePending ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="size-3" aria-hidden="true" />
            )}
            {markDonePending ? "Publishing…" : "Mark done"}
          </GlassButton>
        )}
      </div>
    </article>
  );
}

/** The leading glyph — reuses the Step 0 indicator for real agent states. */
function CardGlyph({ state }: { state: BoardCardState }) {
  if (isAgentUiState(state)) return <AgentStatusIndicator state={state} />;
  const Icon = state === "blocked" ? Lock : Eye;
  const color =
    state === "blocked" ? "var(--color-text-muted)" : "var(--color-info)";
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <Icon className="size-[14px]" style={{ color }} aria-hidden="true" />
    </span>
  );
}

/**
 * The blocked "waiting for backend" chip. Deliberately MUTED (grey) — meaning
 * rides the neutral-AA primary label; the tone is never coral/danger.
 */
function BlockedChip({ blockedOnRoles }: { blockedOnRoles: string[] }) {
  const waiting = blockedOnRoles.length
    ? `waiting for ${blockedOnRoles.join(", ")}`
    : "waiting upstream";
  return (
    <span
      role="status"
      data-testid="board-blocked-chip"
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium leading-none"
    >
      <Lock
        className="size-[13px] shrink-0 text-(--color-text-muted)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Blocked</span>
      <span className="text-(--color-text-muted)">· {waiting}</span>
    </span>
  );
}

/** The "ready for review" chip — a soft `info` invite for the human's turn. */
function ReviewChip() {
  const chipStyle: CSSProperties = {
    background:
      "color-mix(in oklab, var(--color-info) 14%, var(--color-bg-surface))",
    borderColor: "color-mix(in oklab, var(--color-info) 34%, transparent)",
  };
  return (
    <span
      role="status"
      data-testid="board-review-chip"
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2",
        "text-[12px] font-medium leading-none",
      )}
      style={chipStyle}
    >
      <Eye
        className="size-[13px] shrink-0 text-(--color-info)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Ready for review</span>
    </span>
  );
}
