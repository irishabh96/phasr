import type { BoardCardState } from "@/lib/deriveBoardState";
import type { ReviewRecord, ValidateResult } from "@/lib/types";

/**
 * The gate ladder (Phase 3 §A1/§B) — the SINGLE source of truth for "what is the
 * one next thing to do to this ticket/epic". A pure function over the honest
 * board state + the two derived gate files (`review.json`, `validate.json`), it
 * returns the SAME `NextGate` shape the `NextGateButton` renders, the ⌘K palette
 * reads, and the ⋯ menu reads — no surface re-derives the ladder.
 *
 *   Start → Validate → Request-review → (Approve) → Integrate → Ship
 *
 * At any moment an entity has EXACTLY ONE next gate. It is never hidden: an
 * unmet gate renders calm/disabled carrying its `reason` (generalizing the
 * existing `board-integrate-pending` disabled-with-reason span).
 */

/** The CLI/UI verb the gate maps to (mirrors the `phasr` CLI verb names 1:1). */
export type GateVerb =
  | "start"
  | "validate"
  | "request-review"
  | "approve"
  | "bounce"
  | "integrate"
  | "ship";

/**
 * How the gate is drawn:
 * - `primary` — the one coral action for this entity (coral stays scarce, §D1).
 * - `neutral` — a calm, muted disabled-with-reason gate (never coral).
 * - `success` — a calm terminal pill (Approved / Shipped); soft success, non-coral.
 */
export type GateIntent = "primary" | "neutral" | "success";

export interface NextGate {
  verb: GateVerb;
  label: string;
  enabled: boolean;
  /** Disabled-with-reason copy (button `title` + `aria-describedby`). `null` when enabled. */
  reason: string | null;
  intent: GateIntent;
  /** Outward/irreversible → confirm via `ConfirmDialog` before firing (§D2). */
  confirm: boolean;
}

/** Derivation inputs for a ticket (subtask). */
export interface TicketGateInput {
  kind: "ticket";
  /** The DERIVED board-card state (already layered with review, §B). */
  state: BoardCardState;
  /** Last `validate.json` (null = never validated). */
  validate: ValidateResult | null;
  /** `review.json` (null = never reviewed). */
  review: ReviewRecord | null;
  /** ≥1 `RunCommand` with `runInValidate` — Validate can actually run. */
  checksConfigured: boolean;
  /** Producer roles a blocked ticket is waiting on (for the disabled reason). */
  blockedOn?: readonly string[];
  /**
   * The owning epic has autopilot ON (Phase 5a, Stage A). When true and the
   * derived gate is an AUTO step autopilot will fire itself (Validate /
   * Request-review), its `intent` is downgraded from `primary` (coral) to
   * `neutral` — autopilot owns the move, so it is NOT the founder's coral to
   * spend. The gate stays ENABLED (I4 — the founder can still click it). Omitted
   * / `false` reproduces the exact pre-autopilot ladder (parity preserved). The
   * HUMAN-STOP Approve gate is NEVER downgraded — in Stage A the human makes the
   * quality call.
   */
  autopilotEnabled?: boolean;
}

/** Derivation inputs for an epic (parent). */
export interface EpicGateInput {
  kind: "epic";
  ticketCount: number;
  /** Every ticket is integrate-eligible (and there is ≥1 ticket). */
  integrable: boolean;
  /** The parent carries an integration branch (post-`integrate_parent`). */
  integrated: boolean;
  /** The integration branch is merged into base (§R6 — no new column). */
  shipped: boolean;
  /** The repo's default branch, for the Ship label ("Ship to main"). */
  baseBranch?: string;
  /**
   * Autopilot ON for this epic (Phase 5a, Stage A). Downgrades the AUTO Integrate
   * gate's `intent` to `neutral` (autopilot auto-integrates a clean, fully-approved
   * epic). Ship is NEVER downgraded — it is always a HUMAN-STOP (I1). Omitted /
   * `false` reproduces the pre-autopilot epic ladder.
   */
  autopilotEnabled?: boolean;
}

export type NextGateInput = TicketGateInput | EpicGateInput;

function gate(
  verb: GateVerb,
  label: string,
  enabled: boolean,
  reason: string | null,
  intent: GateIntent,
  confirm: boolean,
): NextGate {
  return { verb, label, enabled, reason, intent, confirm };
}

/** How many checks failed in a Validate result (for "Fix N failing checks"). */
export function failingCheckCount(validate: ValidateResult | null): number {
  if (!validate) return 0;
  return validate.checks.filter((c) => !c.passed).length;
}

/**
 * Integrate-eligibility of a ticket (§B `integrate-eligible`). Backward-compatible
 * per §J7: a ticket that reached `needs-review`/`done` without a review request
 * stays eligible; a review that was *requested* must be *approved* first. Because
 * the review decision is already folded into the DERIVED state
 * (`approved → needs-review`, `requested → in-review`,
 * `changes-requested → qas-changes-requested`), eligibility reads purely off the
 * state — no second source, honoring invariant #10.
 */
export function isIntegrateEligible(state: BoardCardState): boolean {
  return state === "needs-review" || state === "done";
}

/**
 * The gate verbs autopilot fires on its own in Stage A — the AUTO steps of the
 * ladder (Validate → Request-review → Integrate). Approve is deliberately absent:
 * in Stage A it is ALWAYS a HUMAN-STOP (the human makes the quality call). Ship is
 * absent by design (never auto, I1).
 */
const AUTOPILOT_AUTO_VERBS: ReadonlySet<GateVerb> = new Set([
  "validate",
  "request-review",
  "integrate",
]);

/**
 * Whether autopilot owns this gate's next move — i.e. under an autopilot-on epic
 * the driver will fire it itself, so it must NOT read as a coral "Needs you"
 * demand. True only for an ENABLED AUTO gate (Validate / Request-review /
 * Integrate). A disabled gate (blocked / validate-failing / not-yet-integrable)
 * is a HUMAN-STOP or a calm wait, never autopilot-owned; the Approve gate (Stage A
 * HUMAN-STOP) and Ship are never owned. Independent of `intent`, so it is
 * idempotent — the same answer before and after the neutral downgrade
 * `deriveNextGate` applies. Pure — reused by the board (intent downgrade + the
 * "driving" chip) so "what autopilot drives" has one definition.
 */
export function isAutopilotOwnedGate(gate: NextGate): boolean {
  return gate.enabled && AUTOPILOT_AUTO_VERBS.has(gate.verb);
}

function deriveTicketGate(i: TicketGateInput): NextGate {
  const { state, validate, review, checksConfigured } = i;

  // 0. Blocked / not started upstream → a calm, disabled forward gate that names
  //    who it is waiting on (never a dead end, never coral).
  if (state === "blocked") {
    const roles =
      i.blockedOn && i.blockedOn.length ? i.blockedOn.join(", ") : "upstream";
    return gate(
      "request-review",
      "Request review",
      false,
      `Waiting for ${roles}`,
      "neutral",
      false,
    );
  }

  // 1. In review (requested) → the reviewer's gate: Approve (primary). The
  //    NextGateButton pairs a secondary Bounce-back (opens the comment dialog).
  if (state === "in-review" || review?.state === "requested") {
    return gate("approve", "Approve", true, null, "primary", false);
  }

  // 2. Approved → terminal at the ticket level; it now contributes to the epic's
  //    Integrate. A calm success pill, disabled (nothing more to do here).
  if (review?.state === "approved") {
    return gate(
      "approve",
      "Approved",
      false,
      "Ready to integrate from the workflow",
      "success",
      false,
    );
  }

  // 3. Otherwise (working/idle/wedged/needs-review, or re-opened after a bounce)
  //    → the forward Validate → Request-review ladder, gated on Validate.
  const validatePassed = validate?.passed === true;

  if (checksConfigured && validate == null) {
    // Checks are configured but never run — the primary invites Validate.
    return gate("validate", "Validate", true, null, "primary", false);
  }

  if (checksConfigured && validate != null && !validatePassed) {
    // Validation ran and failed → Request-review is the PRECONDITION-gated,
    // disabled-with-reason gate (V2). Re-run Validate from the chip / ⌘K.
    const n = failingCheckCount(validate);
    const reason =
      n > 0
        ? `Fix ${n} failing check${n === 1 ? "" : "s"}`
        : "Fix failing checks";
    return gate(
      "request-review",
      "Request review",
      false,
      reason,
      "neutral",
      false,
    );
  }

  // Validate passed, OR no checks are configured (a legible no-op — you can't
  // require a check that can't run) → Request-review is the enabled primary.
  return gate("request-review", "Request review", true, null, "primary", false);
}

function deriveEpicGate(i: EpicGateInput): NextGate {
  const base = i.baseBranch ?? "base";

  // Terminal: the integration branch has landed on base.
  if (i.shipped) {
    return gate(
      "ship",
      "Shipped",
      false,
      `Merged into ${base}`,
      "success",
      false,
    );
  }

  // Integrated + clean, ahead of base → Ship (promoted out of the ⋯ menu, R7).
  if (i.integrated) {
    return gate(
      "ship",
      i.baseBranch ? `Ship to ${base}` : "Ship",
      true,
      null,
      "primary",
      true,
    );
  }

  // Every ticket integrate-eligible → Integrate & review (the existing primary).
  if (i.integrable) {
    return gate("integrate", "Integrate & review", true, null, "primary", true);
  }

  // Not yet — calm/disabled with the (existing) unlock reason.
  const reason =
    i.ticketCount === 0
      ? "No tickets to integrate yet."
      : "Integration unlocks once every ticket is ready for review.";
  return gate(
    "integrate",
    "Integrate when ready",
    false,
    reason,
    "neutral",
    false,
  );
}

/** The one pure ladder entry point — dispatches on entity kind. */
export function deriveNextGate(input: NextGateInput): NextGate {
  const gate =
    input.kind === "ticket" ? deriveTicketGate(input) : deriveEpicGate(input);

  // Autopilot owns the AUTO steps: downgrade a coral primary that the driver will
  // fire itself to a calm neutral (still enabled — I4). Everything else (Approve,
  // Ship, disabled/terminal gates) is untouched, so a non-autopilot epic is
  // byte-for-byte the pre-autopilot ladder.
  if (input.autopilotEnabled && isAutopilotOwnedGate(gate)) {
    return { ...gate, intent: "neutral" };
  }
  return gate;
}
