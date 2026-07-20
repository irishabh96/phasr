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
      "Ready to integrate from the epic",
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
  return input.kind === "ticket"
    ? deriveTicketGate(input)
    : deriveEpicGate(input);
}
