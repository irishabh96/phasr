import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Eye, Lock } from "lucide-react";
import { AgentStatusBadgeView } from "@/components/AgentStatusBadge";
import { NextGateButton } from "@/components/board/NextGateButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import {
  ApprovedChip,
  ChangesRequestedChip,
  InReviewChip,
  ValidateChip,
} from "@/components/board/GateChips";
import type { BoardCardState } from "@/lib/deriveBoardState";
import type { AgentUiState } from "@/lib/deriveAgentState";
import type { GateVerb, NextGate } from "@/lib/deriveNextGate";
import type { Agent, ReviewRecord, ValidateResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Short neutral agent-type mark (mockup Page 01: claude→C, codex→O, …). Mirrors
 * the worklist's mark verbatim so the same agent reads identically in both
 * surfaces — never colored (only status carries color).
 */
const AGENT_MARK: Record<Agent, string> = {
  claude: "C",
  codex: "O",
  copilot: "CP",
  gemini: "G",
  opencode: "OC",
};

/** A board-card state that is a plain honest agent state (Step 0). */
function isAgentUiState(state: BoardCardState): state is AgentUiState {
  return (
    state !== "blocked" &&
    state !== "needs-review" &&
    state !== "in-review" &&
    state !== "qas-changes-requested"
  );
}

export interface BoardCardViewProps {
  /** DAG slot label, e.g. "backend" / "frontend". `null` renders the name only. */
  role: string | null;
  name: string;
  /** The ticket's agent type — rendered as the quiet neutral mark (C/O/G…). */
  agent?: Agent | null;
  state: BoardCardState;
  since: number | null;
  exitCode?: number | null;
  /**
   * Producer roles this card is blocked on (for the "waiting for backend"
   * chip). Only meaningful when `state === "blocked"`.
   */
  blockedOnRoles?: string[];
  /**
   * The ticket's `review.json`. Drives the Approved chip (over the plain Ready-
   * for-review chip) and the bounce reason surfaced on a re-opened card.
   */
  review?: ReviewRecord | null;
  /** The ticket's last `validate.json` — drives the Validate chip (V2). */
  validate?: ValidateResult | null;
  /** ≥1 run command is a Validate check (drives the "Add a check" affordance). */
  checksConfigured?: boolean;
  /**
   * The ticket's derived next gate (Phase 3 G1). When supplied, the card renders
   * the shared {@link NextGateButton} (generalizing the old "Mark done"). Omit
   * on a purely presentational card.
   */
  gate?: NextGate;
  /** Runs the gate's mutation (validate / request-review / approve). */
  onRunGate?: (verb: GateVerb) => void | Promise<unknown>;
  /** Bounce-back (changes requested) with a required comment. */
  onBounceGate?: (comment: string) => void | Promise<unknown>;
  /** In-flight guard for the card's gate button. */
  gatePending?: boolean;
  /**
   * Open this subtask's detail view (the drill-in — a subtask id IS a workspace
   * id). When supplied the whole card becomes a keyboard-activatable button;
   * when omitted (e.g. `/design-test`) the card is static/presentational.
   */
  onOpen?: () => void;
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
  agent,
  state,
  since,
  exitCode,
  blockedOnRoles = [],
  review,
  validate,
  checksConfigured = false,
  gate,
  onRunGate,
  onBounceGate,
  gatePending = false,
  onOpen,
}: BoardCardViewProps) {
  const interactive = !!onOpen;
  const activation = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `Open ${role ? `${role} · ` : ""}${name}`,
        onClick: onOpen,
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen?.();
          }
        },
      }
    : {};
  return (
    <article
      data-testid="board-card"
      data-board-state={state}
      data-role={role ?? undefined}
      {...activation}
      className={cn(
        "flex flex-col gap-3 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) p-3.5",
        interactive &&
          "cursor-pointer outline-none transition-colors duration-150 hover:border-(--color-border-strong) hover:bg-(--color-bg-elevated) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
      )}
    >
      {/* Identity — the role reads as a clean title; the agent mark is a quiet
          neutral aside; the ticket name is a muted subline (never the star, so
          it truncates gracefully at its own full width, not mid-word). */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h4
            data-testid="board-card-role"
            className="min-w-0 flex-1 truncate text-[13px] font-semibold capitalize leading-tight text-(--color-text-primary)"
          >
            {role ?? name}
          </h4>
          {agent ? <AgentTypeMark agent={agent} /> : null}
        </div>
        {role ? (
          <p className="truncate text-[11.5px] leading-tight text-(--color-text-muted)">
            {name}
          </p>
        ) : null}
      </div>

      {/* Status — quiet. Only status carries semantic color. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {isAgentUiState(state) ? (
          <AgentStatusBadgeView
            state={state}
            since={since}
            {...(exitCode != null ? { exitCode } : {})}
          />
        ) : state === "blocked" ? (
          <BlockedChip blockedOnRoles={blockedOnRoles} />
        ) : state === "in-review" ? (
          <InReviewChip />
        ) : state === "qas-changes-requested" ? (
          <ChangesRequestedChip comment={review?.comment ?? null} />
        ) : review?.state === "approved" ? (
          <ApprovedChip />
        ) : (
          <ReviewChip />
        )}

        {/* Validate chip (V2) — only once checks exist for the repo or a result
            is present, so a checkless repo's cards stay calm. */}
        {state !== "blocked" && (checksConfigured || validate) ? (
          <ValidateChip
            validate={validate}
            checksConfigured={checksConfigured}
          />
        ) : null}
      </div>

      {/* The one derived next gate for this ticket (generalizes Mark-done) — on
          its own action row so it never fights the status chips, and coral
          (when it's the enabled primary) is the card's single loud element. */}
      {gate ? (
        <div
          className="flex flex-wrap gap-1.5"
          // Nested interactive controls inside a clickable card — never open the
          // drill-in when the gate (or its dialogs) is used.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <NextGateButton
            gate={gate}
            size="sm"
            pending={gatePending}
            onRun={onRunGate ?? (() => {})}
            {...(onBounceGate ? { onBounce: onBounceGate } : {})}
          />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Small neutral agent-type mark (C/O/G/OC…) — mirrors the worklist mark so an
 * agent reads identically across surfaces. The full agent name rides a
 * `GlassTooltip` (the app's tooltip, not a native `title=`).
 */
function AgentTypeMark({ agent }: { agent: Agent }) {
  return (
    <GlassTooltip content={agent} side="top">
      <span
        data-testid="board-agent-mark"
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[5px] border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-[3px] text-[9px] font-bold leading-none tracking-wide text-(--color-text-muted)"
      >
        {AGENT_MARK[agent]}
      </span>
    </GlassTooltip>
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
