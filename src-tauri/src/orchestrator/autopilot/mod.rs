//! Autopilot (Phase 5a) — the self-driving board core.
//!
//! Stage A (this pass) ships the SAFE self-driving substrate:
//!   - `policy` — the headless, PURE gate-classification engine (`next_auto_action`
//!     / `next_epic_action`) that maps each ticket/epic's derived state to its ONE
//!     next auto-action. Liveness-free by design (spec §I3 note).
//!   - `driver` — the per-parent driver (S4) that consumes the policy: it layers
//!     the I3 liveness read on top, fires the SAME `_inner` mutations the buttons /
//!     CLI call, dedups durably (fire-once-per-(entity, state)), and audits every
//!     fire AND every park (S6).
//!
//! The Approve gate is ALWAYS a HUMAN-STOP in Stage A — there is no `Agent` policy
//! class and no QAS auto-approve path (see the spec §0.5).

pub mod driver;
pub mod policy;

pub use driver::AutopilotDriver;
pub use policy::{
    next_auto_action, next_epic_action, AutoAction, EpicAction, EpicGateState, ReviewLadderState,
    ReviewSnapshot, SafeVerb, StopReason, TicketGateState, TicketState, ValidateSnapshot,
};
