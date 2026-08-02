//! The headless gate-automation policy (Phase 5a, Stage A — spec §2/§3).
//!
//! A PURE function of inputs that classifies each ticket/epic's ONE next
//! auto-action, mirroring the frontend `deriveNextGate.ts` ladder so a headless
//! driver advances the SAME gates the human buttons offer — with no drift. This
//! is the single source of truth §3 chose (port the ladder to Rust; the FE
//! reconciles via a parity test).
//!
//! ## Structural safety (the point of this module)
//!
//! - **`Auto(ship)` is a COMPILE ERROR.** `SafeVerb` has NO `Ship` variant, so an
//!   `AutoAction`/`EpicAction` can never represent auto-shipping (invariant I1).
//!   Ship is always a HUMAN-STOP (`StopReason::Ship`).
//! - **The Approve gate is a HUMAN-STOP unless the epic opts out.** With the
//!   DEFAULT-ON `require_human_approval` the classes are exactly Stage A's
//!   `Auto(SafeVerb)` | `HumanStop(StopReason)`. Stage B's `Agent(SpawnReviewer)`
//!   appears ONLY behind that per-epic opt-out (§0.5) — and even then the driver
//!   never fires the verdict: a spawned reviewer argues it over the socket, where
//!   it is re-verified (I6) and concurrency-checked against the review it was
//!   spawned for.
//! - **The strict integrate predicate (I7):** `Auto(Integrate)` requires EVERY
//!   ticket `review=approved` AND `ticket_count >= 1` — the empty set is NOT
//!   vacuously integrable (`all()` over zero tickets must be false).
//! - **`merge_in_progress` is a TOP-PRECEDENCE epic HUMAN-STOP (I2):** a
//!   conflicted / mid-merge parent is never re-derived as integrable.
//!
//! ## Liveness-free (spec §I3 note)
//!
//! `next_auto_action` reads ONLY the derived `TicketState` + gate snapshots — it
//! NEVER probes raw PTY liveness (is the producer still alive? is a reviewer
//! running?). That refinement layers into the driver's `apply_I3_liveness` later,
//! so this parity-tested ladder stays a pure function and cannot diverge from the
//! FE on the idle-alive-producer handoff case.
//!
//! ## `state_hash` (loop-safety, spec §3/§4)
//!
//! Each state exposes a `state_hash` over EXACTLY the ladder branch inputs (the
//! derived state, `review.state`+`at_ms`, `validate.passed`+`at_ms`,
//! `checks_configured`; epic: strict-approved + `merge_in_progress` +
//! integration-branch + shipped + ticket count). It deliberately EXCLUDES
//! volatile/cosmetic fields (`blocked_on`, `failing_count`) so the driver's
//! durable last-fired dedup can't be defeated by a fingerprint that changes with
//! no ladder transition — and INCLUDES the `at_ms`es so a fresh review/validate
//! after a bounce is not suppressed by a stale fingerprint.

// Stage A ships the policy ahead of its sole consumer, the per-parent driver
// (S4, next slice). Every item here is exercised by the tests below; the
// non-test build has no caller yet, so silence the transient dead-code lint on
// this not-yet-driven seam rather than scatter per-item allows.
#![allow(dead_code)]

/// A gate autopilot may fire directly because it is SAFE (read-only or reversible)
/// — the ONLY verbs an `Auto` action can carry. `Ship` is deliberately absent, so
/// `Auto(ship)` cannot be constructed (invariant I1, structural).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SafeVerb {
    /// Captured, read-only per-worktree checks. No outward effect.
    Validate,
    /// Flip `review.json` to `requested` (+ publish a producer's contract).
    /// Reversible. Only auto-fired when Validate passed or no checks are configured.
    RequestReview,
    /// A clean, deterministic, reversible-until-merged topological merge of a
    /// fully-approved, non-conflicting epic.
    Integrate,
}

impl SafeVerb {
    /// The `phasr` CLI/gate verb name (1:1 with the FE `GateVerb`). The driver
    /// uses this in the durable last-fired key and the audit thread.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Validate => "validate",
            Self::RequestReview => "request-review",
            Self::Integrate => "integrate",
        }
    }
}

/// Why autopilot parked a ticket/epic at "Needs you" instead of firing. Every
/// stop still offers the action on the FE (invariant I4) — this only names the
/// reason for the audit + the honest-status surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StopReason {
    /// `in-review(requested)` — the Approve gate. STAGE A: ALWAYS a human call
    /// (there is no QAS auto-approve path, spec §0.5).
    NeedsReview,
    /// `review=changes-requested` (bounced) — a human decides the re-work. v1
    /// does not auto-re-spawn the producer.
    ChangesRequested,
    /// `needs-review` with a FAILED `validate.json` — never masks a red build.
    /// (The driver may auto-bounce ONCE first, keyed to `validate.at_ms`, S4 —
    /// that durable one-hop is NOT this pure function's concern.)
    ValidateFailing,
    /// The agent is wedged (liveness stuck) — a human decides.
    Wedged,
    /// The agent exited non-zero — not autopilot's call to re-run in v1.
    Failed,
    /// The epic's integration branch is ahead of base → Ship. Outward /
    /// irreversible → NEVER auto in any mode (invariant I1).
    Ship,
    /// The integration worktree carries an unfinished merge — top precedence, so
    /// no `Auto(integrate)` is ever re-derived onto a human's in-progress
    /// resolution (invariant I2).
    MergeInProgress,
    /// `integrate_parent_inner` returned `IntegrationConflict` — the parent is
    /// left mid-merge for the existing interactive resolver (driver-produced; the
    /// pure ladder surfaces it via `MergeInProgress` on the NEXT pass).
    Conflict,
    /// `integrate_parent_inner` returned any other error — park + no retry
    /// (driver-produced).
    IntegrateFailed,
}

impl StopReason {
    /// A short, honest park message for the audit thread / honest-status card.
    /// The driver enriches outward-facing copy (e.g. conflict file names, the
    /// base branch for Ship) — this is the stable classification label.
    pub fn message(self) -> &'static str {
        match self {
            Self::NeedsReview => "Needs you: review",
            Self::ChangesRequested => "Changes requested — needs you",
            Self::ValidateFailing => "Validate failing — needs you",
            Self::Wedged => "Agent wedged — needs you",
            Self::Failed => "Agent failed — needs you",
            Self::Ship => "Ship — needs you",
            Self::MergeInProgress => "Integration in progress — resolve",
            Self::Conflict => "Integration conflict — needs you",
            Self::IntegrateFailed => "Integration failed — needs you",
        }
    }
}

/// A gate delegated to a spawned AGENT (Stage B, §0.5) — distinct from `Auto`
/// (the driver fires those itself) and from `HumanStop` (parked for the
/// human). The only member is the QAS reviewer spawn: the review VERDICT is
/// never auto-fired by the driver — an agent argues for it over the socket,
/// where the verdict is re-verified (I6) and concurrency-checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentGate {
    SpawnReviewer,
}

/// One ticket's next auto-action. `Nothing` is represented by `Option::None` at
/// the call site (`next_auto_action -> Option<AutoAction>`). The `Agent` class
/// exists ONLY behind the per-epic `require_human_approval == false` opt-out
/// (Stage B); with the default-ON human gate the ladder is byte-identical to
/// Stage A.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoAction {
    /// Fire this SAFE verb directly (validate | request-review).
    Auto(SafeVerb),
    /// Spawn a delegated agent for this gate (Stage B — QAS review).
    Agent(AgentGate),
    /// Park at "Needs you" and always offer the action (I4).
    HumanStop(StopReason),
}

/// One epic's next auto-action. Structurally identical to `AutoAction` but a
/// distinct type so the ticket vs epic ladders never mix at a call site. The only
/// `Auto` it ever carries is `Integrate`; Ship is `HumanStop(Ship)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpicAction {
    Auto(SafeVerb),
    HumanStop(StopReason),
}

/// The DERIVED board-card state of a ticket, mirroring the FE `BoardCardState`
/// (`deriveBoardState.ts`). Assembled by the driver from the honest
/// `WorkspaceStatus` + contract-presence + incoming-edge satisfaction, layered
/// with `review.json`. This is a derived INPUT, never a stored `WorkspaceStatus`
/// (honest-status doctrine, spec claim #11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TicketState {
    /// Pending consumer with an unsatisfied incoming edge — the scheduler will
    /// unblock it.
    Blocked,
    /// Producer live and still producing (no published contract yet).
    Working,
    /// Producer quiet but not yet handed off.
    Idle,
    /// Producer stuck (liveness) — a human decides.
    Wedged,
    /// Producer exited non-zero.
    Failed,
    /// Contract published / clean `done` / `review=approved` — awaiting the gates.
    NeedsReview,
    /// `review=requested` — in the Review lane awaiting Approve/Bounce.
    InReview,
    /// `review=changes-requested` — re-opened, carrying the bounce reason.
    QasChangesRequested,
    /// `review=approved` — the ticket-level TERMINAL state (the FE Done lane),
    /// OR a cleanly-exited subtask before the derivation folds it to
    /// `needs-review`. Either way the ladder treats it like `NeedsReview` for
    /// the forward gates; the approved case short-circuits to Nothing at the
    /// review check before this state is ever consulted.
    Done,
}

impl TicketState {
    /// Kebab-case, matching the FE `BoardCardState` union verbatim — used in the
    /// `state_hash` fingerprint so it stays human-legible.
    fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Working => "working",
            Self::Idle => "idle",
            Self::Wedged => "wedged",
            Self::Failed => "failed",
            Self::NeedsReview => "needs-review",
            Self::InReview => "in-review",
            Self::QasChangesRequested => "qas-changes-requested",
            Self::Done => "done",
        }
    }
}

/// The three review states a ticket's `review.json` can hold, mirroring the FE
/// `ReviewState` + the backend `ReviewState` (kebab-case on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReviewLadderState {
    Requested,
    Approved,
    ChangesRequested,
}

impl ReviewLadderState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes-requested",
        }
    }
}

/// The `review.json` slice the ladder branches on: the decision + its `at_ms`.
/// `at_ms` is part of `state_hash` so a fresh review after a bounce is not
/// suppressed by a stale last-fired fingerprint (spec §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReviewSnapshot {
    pub state: ReviewLadderState,
    pub at_ms: i64,
}

/// The `validate.json` slice the ladder branches on. `passed` + `at_ms` are the
/// hash inputs; `failing_count` is COSMETIC (the "Fix N failing checks" reason
/// text, `deriveNextGate.ts::failingCheckCount`) and is deliberately EXCLUDED
/// from `state_hash` so a re-run with the same pass/fail + `at_ms` can't defeat
/// dedup, and a changed failing count with the same result never re-fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidateSnapshot {
    pub passed: bool,
    pub at_ms: i64,
    pub failing_count: usize,
}

/// Everything `next_auto_action` reads for ONE ticket — the `deriveNextGate`
/// `TicketGateInput`, assembled backend-side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketGateState {
    pub state: TicketState,
    /// `review.json` (`None` = never reviewed).
    pub review: Option<ReviewSnapshot>,
    /// Last `validate.json` (`None` = never validated).
    pub validate: Option<ValidateSnapshot>,
    /// ≥1 `RunCommand` with `run_in_validate` — Validate can actually run.
    pub checks_configured: bool,
    /// Stage B (§0.5): the owning epic's human gate. TRUE (the default) keeps
    /// the Approve gate a HUMAN-STOP — Stage A exactly. FALSE delegates the
    /// review to a spawned QAS agent (`Agent(SpawnReviewer)`). Part of
    /// `state_hash`: flipping the toggle IS a ladder transition.
    pub require_human_approval: bool,
    /// COSMETIC: the producer roles a blocked ticket waits on (the disabled
    /// reason text). NOT a ladder branch input and NOT part of `state_hash` —
    /// mirrors `deriveNextGate` using `blockedOn` for the reason string only.
    pub blocked_on: Vec<String>,
}

/// Everything `next_epic_action` reads for ONE epic — the `deriveNextGate`
/// `EpicGateInput` PLUS the strict autopilot inputs (§2/§3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EpicGateState {
    /// Non-deleted ticket count. Zero → never integrable (the empty-set guard).
    pub ticket_count: usize,
    /// STRICT predicate (I7): EVERY ticket is `review=approved`. NOT the lenient
    /// `isIntegrateEligible` (which also passes an unreviewed clean-`done`
    /// ticket) — that lenient predicate stays only for the human Integrate button.
    pub all_approved: bool,
    /// The integration worktree has an unfinished merge (`git::merge_in_progress`).
    /// TOP PRECEDENCE → suppresses any `Auto(integrate)` (invariant I2).
    pub merge_in_progress: bool,
    /// The parent carries an integration branch (post-`integrate_parent`).
    pub integrated: bool,
    /// The integration branch has merged into base (§R6 — no new column).
    pub shipped: bool,
}

/// Compute the next SAFE auto-action for a ticket, or `None` (Nothing). PURE and
/// liveness-free (spec §I3 note): it reads only the derived `TicketState` + gate
/// snapshots. Mirrors `deriveNextGate.ts::deriveTicketGate` precedence, mapping
/// each human gate to its AUTO / HUMAN-STOP class per §2.
pub fn next_auto_action(state: &TicketGateState) -> Option<AutoAction> {
    use TicketState::*;

    // 0. Blocked upstream → the scheduler unblocks it; nothing for autopilot (§2).
    if matches!(state.state, Blocked) {
        return None;
    }

    // 1. In review (requested) → the Approve gate. With the DEFAULT-ON human
    //    gate this is a HUMAN-STOP — Stage A exactly. Only the per-epic
    //    `require_human_approval == false` opt-out (Stage B, §0.5) delegates
    //    it to a spawned QAS reviewer — and even then the driver never fires
    //    the verdict itself: the reviewer argues it over the socket, where I6
    //    re-verifies validate and the at_ms concurrency check protects a
    //    human who acted first. We also honor a raw `review=requested` even
    //    if the derived state hasn't folded to `in-review` yet (mirrors
    //    deriveNextGate's dual check).
    if matches!(state.state, InReview)
        || matches!(state.review, Some(r) if r.state == ReviewLadderState::Requested)
    {
        return Some(if state.require_human_approval {
            AutoAction::HumanStop(StopReason::NeedsReview)
        } else {
            AutoAction::Agent(AgentGate::SpawnReviewer)
        });
    }

    // 2. Changes requested (bounced) → a human decides the re-work (§2). v1 does
    //    NOT auto-re-spawn the producer.
    if matches!(state.state, QasChangesRequested)
        || matches!(state.review, Some(r) if r.state == ReviewLadderState::ChangesRequested)
    {
        return Some(AutoAction::HumanStop(StopReason::ChangesRequested));
    }

    // 3. Approved → ticket-terminal; it now contributes to the epic Integrate
    //    gate, so there is nothing more to fire at the ticket level (§2).
    if matches!(state.review, Some(r) if r.state == ReviewLadderState::Approved) {
        return None;
    }

    // 4. Producer still in flight / unhealthy. Working/Idle with no handoff →
    //    don't interrupt (§2 / I3). Wedged/Failed → a human decides (§2). These
    //    are derived-state reads, not raw-liveness probes; the driver's
    //    `apply_I3_liveness` re-checks the raw status as a redundant safety layer.
    match state.state {
        Working | Idle => return None,
        Wedged => return Some(AutoAction::HumanStop(StopReason::Wedged)),
        Failed => return Some(AutoAction::HumanStop(StopReason::Failed)),
        _ => {}
    }

    // 5. NeedsReview / Done (contract published or clean exit, not yet reviewed)
    //    → the forward Validate → Request-review ladder, gated on Validate (§2).
    let validate_passed = state.validate.map(|v| v.passed).unwrap_or(false);
    if state.checks_configured && state.validate.is_none() {
        // Checks exist but never ran → run Validate first (safe, read-only).
        return Some(AutoAction::Auto(SafeVerb::Validate));
    }
    if state.checks_configured && state.validate.is_some() && !validate_passed {
        // Validation ran and FAILED → park (never mask a red build). The driver
        // may append ONE durable auto-bounce comment first (S4) before honoring
        // this stop — that one-hop is not this pure function's concern.
        return Some(AutoAction::HumanStop(StopReason::ValidateFailing));
    }
    // Validate passed, OR no checks are configured (a legible no-op — you can't
    // require a check that can't run) → Request-review is the safe AUTO gate (§2).
    Some(AutoAction::Auto(SafeVerb::RequestReview))
}

/// Compute the next auto-action for an epic, or `None` (Nothing). Mirrors
/// `deriveNextGate.ts::deriveEpicGate` with the strict autopilot predicate (I7)
/// and `merge_in_progress` as a top-precedence HUMAN-STOP (I2). The ONLY `Auto`
/// it can return is `Integrate`; Ship is `HumanStop(Ship)` (I1, structural).
pub fn next_epic_action(state: &EpicGateState) -> Option<EpicAction> {
    // TOP PRECEDENCE (I2): a conflicted / mid-merge integration worktree is NEVER
    // re-derived as integrable — this suppresses any `Auto(integrate)` while a
    // human resolves, and survives the 3s backstop.
    if state.merge_in_progress {
        return Some(EpicAction::HumanStop(StopReason::MergeInProgress));
    }

    // Terminal: the integration branch has landed on base.
    if state.shipped {
        return None;
    }

    // Integrated + ahead of base → Ship. Outward / irreversible → NEVER auto
    // (invariant I1; `SafeVerb` has no `Ship`, so this cannot be an `Auto`).
    if state.integrated {
        return Some(EpicAction::HumanStop(StopReason::Ship));
    }

    // STRICT integrate predicate (I7): every ticket `review=approved` AND ≥1
    // ticket. The empty set is NOT vacuously integrable — `ticket_count >= 1`
    // guards the zero-ticket case that a bare `all()` would wrongly pass.
    if state.ticket_count >= 1 && state.all_approved {
        return Some(EpicAction::Auto(SafeVerb::Integrate));
    }

    // Not yet — nothing to auto-fire (the human Integrate button renders its own
    // calm disabled-with-reason gate).
    None
}

impl TicketGateState {
    /// A stable fingerprint over EXACTLY the `deriveNextGate` branch inputs —
    /// deliberately EXCLUDING volatile/cosmetic fields (`blocked_on`,
    /// `validate.failing_count`) and INCLUDING both `at_ms`es, so the driver's
    /// durable last-fired dedup is sound (spec §3/§4). Uses a fixed-seed FNV-1a
    /// over a canonical string so it is deterministic across process restarts and
    /// Rust versions (a `DefaultHasher` guarantees neither for a persisted marker).
    pub fn state_hash(&self) -> u64 {
        let review = match self.review {
            Some(r) => format!("{}@{}", r.state.as_str(), r.at_ms),
            None => "none".to_string(),
        };
        let validate = match self.validate {
            // NOTE: `failing_count` is intentionally absent — cosmetic only.
            Some(v) => format!("{}@{}", if v.passed { "passed" } else { "failed" }, v.at_ms),
            None => "none".to_string(),
        };
        let canonical = format!(
            "t|{}|checks={}|review={}|validate={}|human={}",
            self.state.as_str(),
            self.checks_configured,
            review,
            validate,
            // Stage B: flipping the human gate IS a ladder transition — a
            // parked NeedsReview must re-derive (to SpawnReviewer) when the
            // founder opts out, so the durable dedup can't suppress it.
            self.require_human_approval,
        );
        fnv1a(canonical.as_bytes())
    }
}

impl EpicGateState {
    /// A stable fingerprint over the epic ladder inputs (spec §3/§4) — the durable
    /// integrate-STOP marker keys on this. Same FNV-1a-over-canonical-string
    /// scheme as the ticket hash for restart/version stability.
    pub fn state_hash(&self) -> u64 {
        let canonical = format!(
            "e|tickets={}|approved={}|merge={}|integrated={}|shipped={}",
            self.ticket_count, self.all_approved, self.merge_in_progress, self.integrated, self.shipped,
        );
        fnv1a(canonical.as_bytes())
    }
}

/// FNV-1a (64-bit) — a tiny, fixed-constant, order-sensitive hash. Chosen over
/// `std`'s `DefaultHasher` because the fingerprint is persisted (the durable
/// last-fired marker) and MUST be identical across app restarts and Rust
/// toolchain upgrades; `DefaultHasher`'s algorithm/seed is not a stability
/// guarantee. Non-cryptographic — dedup only.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fixture builders ─────────────────────────────────────────────────────

    fn ticket(state: TicketState) -> TicketGateState {
        TicketGateState {
            state,
            review: None,
            validate: None,
            checks_configured: false,
            // Stage A default everywhere: the human gate is ON.
            require_human_approval: true,
            blocked_on: Vec::new(),
        }
    }

    fn review(state: ReviewLadderState) -> ReviewSnapshot {
        ReviewSnapshot { state, at_ms: 1_000 }
    }

    fn validate(passed: bool) -> ValidateSnapshot {
        ValidateSnapshot { passed, at_ms: 2_000, failing_count: if passed { 0 } else { 2 } }
    }

    fn epic() -> EpicGateState {
        EpicGateState {
            ticket_count: 0,
            all_approved: false,
            merge_in_progress: false,
            integrated: false,
            shipped: false,
        }
    }

    // ── §2 ticket table — exhaustive golden fixtures ─────────────────────────

    // Each row of the §2 ticket ladder that `next_auto_action` OWNS, asserted
    // directly so a reviewer sees the spec table verified 1:1. (The wedged/failed
    // and working/idle "still producing" rows are covered below.)
    #[test]
    fn golden_ticket_ladder_matches_spec_section_2() {
        // blocked → Nothing (the scheduler unblocks it).
        assert_eq!(next_auto_action(&ticket(TicketState::Blocked)), None);

        // needs-review, no checks configured → Auto(request-review).
        let mut s = ticket(TicketState::NeedsReview);
        s.checks_configured = false;
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::Auto(SafeVerb::RequestReview)),
            "no checks → request review directly"
        );

        // needs-review, checks configured, never validated → Auto(validate).
        let mut s = ticket(TicketState::NeedsReview);
        s.checks_configured = true;
        assert_eq!(next_auto_action(&s), Some(AutoAction::Auto(SafeVerb::Validate)));

        // needs-review, validate passed → Auto(request-review).
        let mut s = ticket(TicketState::NeedsReview);
        s.checks_configured = true;
        s.validate = Some(validate(true));
        assert_eq!(next_auto_action(&s), Some(AutoAction::Auto(SafeVerb::RequestReview)));

        // needs-review, validate FAILED → HUMAN-STOP (never mask a red build).
        let mut s = ticket(TicketState::NeedsReview);
        s.checks_configured = true;
        s.validate = Some(validate(false));
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::HumanStop(StopReason::ValidateFailing))
        );

        // in-review (requested) → HUMAN-STOP "Needs you: review" (STAGE A: the
        // Approve gate is ALWAYS a human call, spec §0.5).
        let mut s = ticket(TicketState::InReview);
        s.review = Some(review(ReviewLadderState::Requested));
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::HumanStop(StopReason::NeedsReview))
        );
        // …and the raw `review=requested` alone (state not yet folded) also parks.
        let mut s = ticket(TicketState::Idle);
        s.review = Some(review(ReviewLadderState::Requested));
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::HumanStop(StopReason::NeedsReview))
        );

        // qas-changes-requested (bounced) → HUMAN-STOP.
        let mut s = ticket(TicketState::QasChangesRequested);
        s.review = Some(review(ReviewLadderState::ChangesRequested));
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::HumanStop(StopReason::ChangesRequested))
        );

        // approved → Nothing (ticket-terminal; contributes to the epic Integrate).
        let mut s = ticket(TicketState::NeedsReview);
        s.review = Some(review(ReviewLadderState::Approved));
        assert_eq!(next_auto_action(&s), None, "approved is ticket-terminal");
    }

    // §2: a still-producing producer is never interrupted; an unhealthy one parks.
    #[test]
    fn producer_in_flight_states() {
        // working / idle with no handoff → Nothing (don't interrupt, I3).
        assert_eq!(next_auto_action(&ticket(TicketState::Working)), None);
        assert_eq!(next_auto_action(&ticket(TicketState::Idle)), None);
        // wedged / failed → HUMAN-STOP (§2). A derived-state read, not a liveness
        // probe — the parity-tested ladder stays pure.
        assert_eq!(
            next_auto_action(&ticket(TicketState::Wedged)),
            Some(AutoAction::HumanStop(StopReason::Wedged))
        );
        assert_eq!(
            next_auto_action(&ticket(TicketState::Failed)),
            Some(AutoAction::HumanStop(StopReason::Failed))
        );
    }

    // §2: no checks configured (Validate can't run) → skip straight to
    // request-review — you cannot gate on a check that cannot run.
    #[test]
    fn no_checks_configured_skips_validate() {
        let mut s = ticket(TicketState::NeedsReview);
        s.checks_configured = false;
        // Even with a stale validate present, no configured checks → request review.
        s.validate = Some(validate(false));
        assert_eq!(next_auto_action(&s), Some(AutoAction::Auto(SafeVerb::RequestReview)));
    }

    // ── §2 epic table — exhaustive golden fixtures (incl. the two edge rows) ──

    #[test]
    fn golden_epic_ladder_matches_spec_section_2() {
        // merge in progress → HUMAN-STOP, TOP PRECEDENCE (even with everything
        // else "ready") — a mid-merge parent is never re-derived as integrable.
        let e = EpicGateState {
            ticket_count: 4,
            all_approved: true,
            merge_in_progress: true,
            integrated: false,
            shipped: false,
        };
        assert_eq!(
            next_epic_action(&e),
            Some(EpicAction::HumanStop(StopReason::MergeInProgress)),
            "merge_in_progress suppresses Auto(integrate)"
        );

        // ZERO tickets, even if all_approved is (vacuously) true → Nothing. The
        // empty set is NOT integrable (`all()` over zero must be false, I7).
        let e = EpicGateState { ticket_count: 0, all_approved: true, ..epic() };
        assert_eq!(next_epic_action(&e), None, "empty set is never vacuously integrable");

        // ≥1 ticket but NOT all approved → Nothing.
        let e = EpicGateState { ticket_count: 3, all_approved: false, ..epic() };
        assert_eq!(next_epic_action(&e), None);

        // Every ticket approved, ≥1 ticket, no merge, not integrated → Auto(integrate).
        let e = EpicGateState { ticket_count: 3, all_approved: true, ..epic() };
        assert_eq!(next_epic_action(&e), Some(EpicAction::Auto(SafeVerb::Integrate)));

        // Integrated, ahead of base → HUMAN-STOP (Ship) — NEVER auto (I1).
        let e = EpicGateState { ticket_count: 3, all_approved: true, integrated: true, ..epic() };
        assert_eq!(next_epic_action(&e), Some(EpicAction::HumanStop(StopReason::Ship)));

        // Shipped (merged to base) → Nothing (terminal).
        let e = EpicGateState {
            ticket_count: 3,
            all_approved: true,
            integrated: true,
            shipped: true,
            ..epic()
        };
        assert_eq!(next_epic_action(&e), None, "shipped is terminal");
    }

    // I1 (structural): `Auto(ship)` is UNREPRESENTABLE — `SafeVerb` has no `Ship`
    // variant, so no fixture can yield it. We prove the behavioral half: an
    // integrated epic (the one place a human would Ship) parks at HUMAN-STOP(Ship),
    // and no epic fixture ever returns an `Auto` for a ship situation.
    #[test]
    fn ship_is_never_auto_only_a_human_stop() {
        // The only Auto verb any epic fixture can produce is Integrate.
        for integrated in [false, true] {
            for shipped in [false, true] {
                for merge in [false, true] {
                    for approved in [false, true] {
                        for count in [0usize, 1, 5] {
                            let e = EpicGateState {
                                ticket_count: count,
                                all_approved: approved,
                                merge_in_progress: merge,
                                integrated,
                                shipped,
                            };
                            if let Some(EpicAction::Auto(v)) = next_epic_action(&e) {
                                assert_eq!(
                                    v,
                                    SafeVerb::Integrate,
                                    "the ONLY epic Auto verb is Integrate — never ship"
                                );
                            }
                        }
                    }
                }
            }
        }
        // The integrated (Ship-able) epic is a HUMAN-STOP, never an Auto.
        let e = EpicGateState { ticket_count: 2, all_approved: true, integrated: true, ..epic() };
        assert!(matches!(
            next_epic_action(&e),
            Some(EpicAction::HumanStop(StopReason::Ship))
        ));
    }

    // Ticket side: no ticket fixture ever yields an `Auto` outside the two safe
    // ticket verbs (validate | request-review) — integrate/ship are epic-only and
    // ship is type-impossible.
    #[test]
    fn ticket_auto_is_only_validate_or_request_review() {
        for combo in all_ticket_combos() {
            if let Some(AutoAction::Auto(v)) = next_auto_action(&combo) {
                assert!(
                    matches!(v, SafeVerb::Validate | SafeVerb::RequestReview),
                    "a ticket must never auto-fire {:?}",
                    v
                );
            }
        }
    }

    // ── the "classification only ever downgrades vs the human ladder" test ────

    /// The FE gate verbs (`deriveNextGate.ts::GateVerb`), for the ⊑ check.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum GateVerb {
        Validate,
        RequestReview,
        Approve,
        Integrate,
        #[allow(dead_code)]
        Ship,
    }

    /// A faithful Rust port of `deriveNextGate.ts::deriveTicketGate`'s
    /// (`verb`, `enabled`) — the HUMAN ladder autopilot must never fire more
    /// aggressively than. Kept in the test so any drift between autopilot's
    /// classification and the human ladder is caught here.
    fn human_ticket_gate(s: &TicketGateState) -> (GateVerb, bool) {
        if matches!(s.state, TicketState::Blocked) {
            return (GateVerb::RequestReview, false); // disabled "waiting for …"
        }
        if matches!(s.state, TicketState::InReview)
            || matches!(s.review, Some(r) if r.state == ReviewLadderState::Requested)
        {
            return (GateVerb::Approve, true); // the reviewer's coral Approve
        }
        if matches!(s.review, Some(r) if r.state == ReviewLadderState::Approved) {
            return (GateVerb::Approve, false); // "Approved" disabled success pill
        }
        let validate_passed = s.validate.map(|v| v.passed).unwrap_or(false);
        if s.checks_configured && s.validate.is_none() {
            return (GateVerb::Validate, true);
        }
        if s.checks_configured && s.validate.is_some() && !validate_passed {
            return (GateVerb::RequestReview, false); // disabled "Fix N failing checks"
        }
        (GateVerb::RequestReview, true)
    }

    fn safe_verb_to_gate(v: SafeVerb) -> GateVerb {
        match v {
            SafeVerb::Validate => GateVerb::Validate,
            SafeVerb::RequestReview => GateVerb::RequestReview,
            SafeVerb::Integrate => GateVerb::Integrate,
        }
    }

    /// Exhaustively enumerate every (state × review × validate × checks) combo the
    /// ticket ladder branches on.
    fn all_ticket_combos() -> Vec<TicketGateState> {
        let states = [
            TicketState::Blocked,
            TicketState::Working,
            TicketState::Idle,
            TicketState::Wedged,
            TicketState::Failed,
            TicketState::NeedsReview,
            TicketState::InReview,
            TicketState::QasChangesRequested,
            TicketState::Done,
        ];
        let reviews = [
            None,
            Some(review(ReviewLadderState::Requested)),
            Some(review(ReviewLadderState::Approved)),
            Some(review(ReviewLadderState::ChangesRequested)),
        ];
        let validates = [None, Some(validate(true)), Some(validate(false))];
        let mut out = Vec::new();
        for &state in &states {
            for &rv in &reviews {
                for &vl in &validates {
                    for checks in [false, true] {
                        out.push(TicketGateState {
                            state,
                            review: rv,
                            validate: vl,
                            checks_configured: checks,
                            // The safety sweep runs against Stage A's
                            // default-ON gate; Stage B's single delegated row
                            // is covered by its own tests above.
                            require_human_approval: true,
                            blocked_on: Vec::new(),
                        });
                    }
                }
            }
        }
        out
    }

    // Autopilot's classification is strictly ⊑ the human ladder: whenever it fires
    // an `Auto(verb)`, the human ladder offers that SAME verb ENABLED; and it NEVER
    // auto-fires where the human ladder would show Approve (a judgment call) or a
    // disabled gate. Over the WHOLE combinatorial input space.
    #[test]
    fn classification_only_ever_downgrades_vs_the_human_ladder() {
        for s in all_ticket_combos() {
            let auto = next_auto_action(&s);
            let (hverb, henabled) = human_ticket_gate(&s);

            match auto {
                Some(AutoAction::Auto(v)) => {
                    // An auto-fire must match an ENABLED human gate of the same verb.
                    assert_eq!(
                        safe_verb_to_gate(v),
                        hverb,
                        "autopilot fired {:?} but the human ladder offers {:?} for {:?}",
                        v, hverb, s
                    );
                    assert!(
                        henabled,
                        "autopilot auto-fired {:?} where the human gate is DISABLED for {:?}",
                        v, s
                    );
                    // And it is never a judgment/outward gate.
                    assert_ne!(hverb, GateVerb::Approve);
                    assert_ne!(hverb, GateVerb::Ship);
                }
                // A HUMAN-STOP or Nothing is always a safe downgrade of whatever the
                // human ladder offers — never MORE aggressive.
                Some(AutoAction::HumanStop(_)) | None => {}
                // Unreachable in this sweep (every combo is Stage A's
                // human-gate-ON), and a delegated review is by construction
                // never MORE aggressive than the human ladder's Approve.
                Some(AutoAction::Agent(_)) => {}
            }

            // The converse guard: wherever the human ladder offers the coral
            // Approve, autopilot must NOT auto-fire — it parks (Stage A §0.5).
            if hverb == GateVerb::Approve && henabled {
                assert!(
                    !matches!(auto, Some(AutoAction::Auto(_))),
                    "autopilot must never auto-resolve an Approve gate for {:?}",
                    s
                );
            }
        }
    }

    // Epic side of the ⊑ guard: `Auto(integrate)` fires ONLY under the strict,
    // clean predicate — never through a conflict/merge, never on an empty set,
    // never once integrated/shipped.
    #[test]
    fn epic_auto_integrate_only_when_strictly_safe() {
        for count in [0usize, 1, 3] {
            for approved in [false, true] {
                for merge in [false, true] {
                    for integrated in [false, true] {
                        for shipped in [false, true] {
                            let e = EpicGateState {
                                ticket_count: count,
                                all_approved: approved,
                                merge_in_progress: merge,
                                integrated,
                                shipped,
                            };
                            if let Some(EpicAction::Auto(SafeVerb::Integrate)) = next_epic_action(&e)
                            {
                                assert!(count >= 1, "never integrate an empty set");
                                assert!(approved, "never integrate unreviewed work");
                                assert!(!merge, "never integrate through a mid-merge");
                                assert!(!integrated, "never re-integrate an integrated epic");
                                assert!(!shipped, "never integrate a shipped epic");
                            }
                        }
                    }
                }
            }
        }
    }

    // ── state_hash: covers exactly the ladder inputs, no volatile fields ─────

    // The drift guard (spec §3): the fingerprint changes with a ladder input
    // (review/validate `at_ms`, pass/fail, state, checks) and does NOT change with
    // a cosmetic field (`blocked_on`, `validate.failing_count`). This is what keeps
    // the durable last-fired dedup sound.
    #[test]
    fn state_hash_covers_ladder_inputs_and_excludes_volatile_fields() {
        let base = TicketGateState {
            state: TicketState::NeedsReview,
            review: Some(review(ReviewLadderState::Requested)),
            validate: Some(validate(false)),
            checks_configured: true,
            require_human_approval: true,
            blocked_on: Vec::new(),
        };
        let h = base.state_hash();

        // Cosmetic `blocked_on` must NOT move the hash.
        let mut cosmetic = base.clone();
        cosmetic.blocked_on = vec!["backend".into(), "frontend".into()];
        assert_eq!(cosmetic.state_hash(), h, "blocked_on is cosmetic — not in the hash");

        // Cosmetic `validate.failing_count` must NOT move the hash.
        let mut fewer = base.clone();
        fewer.validate = Some(ValidateSnapshot { passed: false, at_ms: 2_000, failing_count: 99 });
        assert_eq!(fewer.state_hash(), h, "failing_count is cosmetic — not in the hash");

        // A NEW validate.at_ms (a fresh failure) MUST move the hash — else a fresh
        // validate after a bounce would be suppressed by a stale fingerprint.
        let mut newer = base.clone();
        newer.validate = Some(ValidateSnapshot { passed: false, at_ms: 9_999, failing_count: 2 });
        assert_ne!(newer.state_hash(), h, "a newer validate.at_ms is a fresh state");

        // A NEW review.at_ms MUST move the hash (a re-review after a bounce).
        let mut re_reviewed = base.clone();
        re_reviewed.review = Some(ReviewSnapshot { state: ReviewLadderState::Requested, at_ms: 8_888 });
        assert_ne!(re_reviewed.state_hash(), h);

        // pass/fail flip, state change, and checks flip each move the hash.
        let mut passed = base.clone();
        passed.validate = Some(validate(true));
        assert_ne!(passed.state_hash(), h);

        let mut other_state = base.clone();
        other_state.state = TicketState::Idle;
        assert_ne!(other_state.state_hash(), h);

        let mut no_checks = base.clone();
        no_checks.checks_configured = false;
        assert_ne!(no_checks.state_hash(), h);
    }

    // The epic fingerprint moves with each of its ladder inputs (so the durable
    // integrate-STOP marker tracks real transitions) and is deterministic.
    #[test]
    fn epic_state_hash_tracks_its_inputs() {
        let base = EpicGateState {
            ticket_count: 3,
            all_approved: true,
            merge_in_progress: false,
            integrated: false,
            shipped: false,
        };
        let h = base.state_hash();
        assert_eq!(base.state_hash(), h, "deterministic");
        assert_ne!(EpicGateState { ticket_count: 4, ..base }.state_hash(), h);
        assert_ne!(EpicGateState { all_approved: false, ..base }.state_hash(), h);
        assert_ne!(EpicGateState { merge_in_progress: true, ..base }.state_hash(), h);
        assert_ne!(EpicGateState { integrated: true, ..base }.state_hash(), h);
        assert_ne!(EpicGateState { shipped: true, ..base }.state_hash(), h);
    }

    // FNV-1a is deterministic and order-sensitive (the property the durable marker
    // relies on across restarts).
    #[test]
    fn fnv1a_is_deterministic_and_order_sensitive() {
        assert_eq!(fnv1a(b"abc"), fnv1a(b"abc"));
        assert_ne!(fnv1a(b"abc"), fnv1a(b"acb"));
        assert_ne!(fnv1a(b""), fnv1a(b"a"));
    }

    // ── Stage B (§0.5): the Agent class behind the per-epic opt-out ─────────

    // The DEFAULT-ON human gate keeps in-review a HUMAN-STOP (Stage A exactly);
    // only `require_human_approval: false` delegates it to a spawned reviewer.
    #[test]
    fn in_review_delegates_to_a_reviewer_only_when_the_human_gate_is_off() {
        let mut s = ticket(TicketState::InReview);
        s.review = Some(review(ReviewLadderState::Requested));
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::HumanStop(StopReason::NeedsReview)),
            "default: the founder approves"
        );

        s.require_human_approval = false;
        assert_eq!(
            next_auto_action(&s),
            Some(AutoAction::Agent(AgentGate::SpawnReviewer)),
            "opted out: a QAS reviewer is spawned to argue the verdict"
        );
    }

    // Stage B changes ONLY the review gate. Every other row — including the
    // bounce park and the forward AUTO ladder — is byte-identical with the
    // gate off, so opting out can never widen what autopilot fires itself.
    #[test]
    fn the_opt_out_touches_no_other_ladder_row() {
        for state in [
            TicketState::Blocked,
            TicketState::Working,
            TicketState::Idle,
            TicketState::Wedged,
            TicketState::Failed,
            TicketState::NeedsReview,
            TicketState::QasChangesRequested,
            TicketState::Done,
        ] {
            let mut human = ticket(state);
            let mut delegated = ticket(state);
            delegated.require_human_approval = false;
            assert_eq!(
                next_auto_action(&human),
                next_auto_action(&delegated),
                "state {state:?} must not change with the review gate"
            );
            // …and the same holds with a bounced review layered on.
            human.review = Some(review(ReviewLadderState::ChangesRequested));
            delegated.review = Some(review(ReviewLadderState::ChangesRequested));
            assert_eq!(next_auto_action(&human), next_auto_action(&delegated));
        }
    }

    // Ship is structurally human in BOTH stages — `SafeVerb` has no Ship
    // variant, and the epic ladder never grows an Agent class.
    #[test]
    fn ship_is_never_delegated_in_stage_b() {
        let e = EpicGateState {
            ticket_count: 3,
            all_approved: true,
            merge_in_progress: false,
            integrated: true,
            shipped: false,
        };
        assert_eq!(
            next_epic_action(&e),
            Some(EpicAction::HumanStop(StopReason::Ship))
        );
    }

    // Flipping the gate IS a ladder transition: the fingerprint must move, or
    // the durable dedup would suppress the re-derive to SpawnReviewer.
    #[test]
    fn the_review_gate_is_part_of_the_state_hash() {
        let mut s = ticket(TicketState::InReview);
        s.review = Some(review(ReviewLadderState::Requested));
        let with_human = s.state_hash();
        s.require_human_approval = false;
        assert_ne!(s.state_hash(), with_human);
    }

    // SafeVerb → CLI verb names (the driver's dedup key + audit thread).
    #[test]
    fn safe_verb_cli_names() {
        assert_eq!(SafeVerb::Validate.as_str(), "validate");
        assert_eq!(SafeVerb::RequestReview.as_str(), "request-review");
        assert_eq!(SafeVerb::Integrate.as_str(), "integrate");
    }

    // ── Shared gate-ladder parity fixture (spec §3 — "mandatory, HARDENED") ──
    //
    // e2e/fixtures/gate-ladder.json is the ONE table both ladders answer to:
    // this test asserts the `autopilot` half of every row, and the FE suite
    // (src/lib/deriveNextGate.test.ts) asserts the `fe` half of the SAME rows.
    // Mutating a row must fail BOTH suites — the anti-drift guarantee. FE-only
    // fields (`fe`, `integrable`, `baseBranch`, `autopilotEnabled`) are ignored
    // here; `mergeInProgress`/`allApproved` are Rust-only and ignored there.

    const GATE_LADDER_FIXTURE: &str =
        include_str!("../../../../e2e/fixtures/gate-ladder.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureReview {
        state: String,
        at_ms: i64,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureValidate {
        passed: bool,
        at_ms: i64,
        failing_count: usize,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureTicketInput {
        state: String,
        #[serde(default)]
        require_human_approval: Option<bool>,
        review: Option<FixtureReview>,
        validate: Option<FixtureValidate>,
        checks_configured: bool,
        blocked_on: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureEpicInput {
        ticket_count: usize,
        integrated: bool,
        shipped: bool,
        all_approved: bool,
        merge_in_progress: bool,
    }

    #[derive(serde::Deserialize)]
    struct FixtureTicketRow {
        name: String,
        input: FixtureTicketInput,
        autopilot: String,
    }

    #[derive(serde::Deserialize)]
    struct FixtureEpicRow {
        name: String,
        input: FixtureEpicInput,
        autopilot: String,
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        tickets: Vec<FixtureTicketRow>,
        epics: Vec<FixtureEpicRow>,
    }

    fn fixture_ticket_state(s: &str) -> TicketState {
        match s {
            "blocked" => TicketState::Blocked,
            "working" => TicketState::Working,
            "idle" => TicketState::Idle,
            "wedged" => TicketState::Wedged,
            "failed" => TicketState::Failed,
            "needs-review" => TicketState::NeedsReview,
            "in-review" => TicketState::InReview,
            "qas-changes-requested" => TicketState::QasChangesRequested,
            "done" => TicketState::Done,
            other => panic!("fixture: unknown ticket state `{other}`"),
        }
    }

    fn fixture_review_state(s: &str) -> ReviewLadderState {
        match s {
            "requested" => ReviewLadderState::Requested,
            "approved" => ReviewLadderState::Approved,
            "changes-requested" => ReviewLadderState::ChangesRequested,
            other => panic!("fixture: unknown review state `{other}`"),
        }
    }

    fn fixture_stop_reason(s: &str) -> StopReason {
        match s {
            "needs-review" => StopReason::NeedsReview,
            "changes-requested" => StopReason::ChangesRequested,
            "validate-failing" => StopReason::ValidateFailing,
            "wedged" => StopReason::Wedged,
            "failed" => StopReason::Failed,
            "ship" => StopReason::Ship,
            "merge-in-progress" => StopReason::MergeInProgress,
            other => panic!("fixture: unknown stop reason `{other}`"),
        }
    }

    fn fixture_safe_verb(s: &str) -> SafeVerb {
        match s {
            "validate" => SafeVerb::Validate,
            "request-review" => SafeVerb::RequestReview,
            "integrate" => SafeVerb::Integrate,
            other => panic!("fixture: unknown safe verb `{other}`"),
        }
    }

    #[test]
    fn gate_ladder_fixture_ticket_rows_match_policy() {
        let fixture: Fixture =
            serde_json::from_str(GATE_LADDER_FIXTURE).expect("fixture parses");
        assert!(!fixture.tickets.is_empty(), "fixture has ticket rows");
        for row in &fixture.tickets {
            let state = TicketGateState {
                state: fixture_ticket_state(&row.input.state),
                review: row.input.review.as_ref().map(|r| ReviewSnapshot {
                    state: fixture_review_state(&r.state),
                    at_ms: r.at_ms,
                }),
                validate: row.input.validate.as_ref().map(|v| ValidateSnapshot {
                    passed: v.passed,
                    at_ms: v.at_ms,
                    failing_count: v.failing_count,
                }),
                checks_configured: row.input.checks_configured,
                // The shared fixture's rows are Stage A (human gate ON);
                // Stage B rows carry `requireHumanApproval: false`.
                require_human_approval: row.input.require_human_approval.unwrap_or(true),
                blocked_on: row.input.blocked_on.clone(),
            };
            let expected = match row.autopilot.as_str() {
                "none" => None,
                s if s.starts_with("auto:") => {
                    Some(AutoAction::Auto(fixture_safe_verb(&s["auto:".len()..])))
                }
                s if s.starts_with("human-stop:") => Some(AutoAction::HumanStop(
                    fixture_stop_reason(&s["human-stop:".len()..]),
                )),
                "agent:spawn-reviewer" => Some(AutoAction::Agent(AgentGate::SpawnReviewer)),
                other => panic!("fixture: unknown expected action `{other}`"),
            };
            assert_eq!(
                next_auto_action(&state),
                expected,
                "ticket fixture row `{}` diverged from the policy ladder",
                row.name
            );
        }
    }

    #[test]
    fn gate_ladder_fixture_epic_rows_match_policy() {
        let fixture: Fixture =
            serde_json::from_str(GATE_LADDER_FIXTURE).expect("fixture parses");
        assert!(!fixture.epics.is_empty(), "fixture has epic rows");
        for row in &fixture.epics {
            let state = EpicGateState {
                ticket_count: row.input.ticket_count,
                all_approved: row.input.all_approved,
                merge_in_progress: row.input.merge_in_progress,
                integrated: row.input.integrated,
                shipped: row.input.shipped,
            };
            let expected = match row.autopilot.as_str() {
                "none" => None,
                s if s.starts_with("auto:") => {
                    Some(EpicAction::Auto(fixture_safe_verb(&s["auto:".len()..])))
                }
                s if s.starts_with("human-stop:") => Some(EpicAction::HumanStop(
                    fixture_stop_reason(&s["human-stop:".len()..]),
                )),
                other => panic!("fixture: unknown expected action `{other}`"),
            };
            assert_eq!(
                next_epic_action(&state),
                expected,
                "epic fixture row `{}` diverged from the policy ladder",
                row.name
            );
        }
    }
}
