//! Autopilot (Phase 5a) — the self-driving board core.
//!
//! Stage A (this pass) ships the SAFE self-driving substrate: the headless
//! policy engine that classifies each ticket/epic's one next auto-action. The
//! per-parent driver (`driver.rs`) lands in a later slice and consumes this
//! module. The Approve gate is ALWAYS a HUMAN-STOP in Stage A — there is no
//! `Agent` policy class and no QAS auto-approve path (see the spec §0.5).

pub mod policy;

pub use policy::{
    next_auto_action, next_epic_action, AutoAction, EpicAction, EpicGateState, ReviewLadderState,
    ReviewSnapshot, SafeVerb, StopReason, TicketGateState, TicketState, ValidateSnapshot,
};
