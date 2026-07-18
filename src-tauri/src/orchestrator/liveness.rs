//! Liveness classification for running agents (Step 0 — honest status).
//!
//! The PTY output pump stamps an in-memory `last_activity` timestamp on
//! every non-empty chunk (see `pty::handle`, T1). A single orchestrator
//! poller (T3) reads that stamp for each running agent, runs it through
//! `classify`, and broadcasts only the *transitions* over the existing
//! status channel — the bus carries a handful of transitions per task, not
//! one event per byte or per tick.
//!
//! Derived state deliberately lives OUTSIDE `WorkspaceStatus` (the stored
//! enum, spec validation #1): "wedged" is a runtime derivation of an
//! otherwise-`running` row, never a persisted status. The only persisted
//! honest-status bit is `Workspace::interrupted_at`, set at relaunch
//! recovery.
//!
//! Product decision — **honest-neutral** (overrides the plan's §F-1
//! default): a quiet agent is a neutral `Idle` that escalates to `Wedged`
//! on long silence. There is intentionally **no coral "NeedsAttention"**
//! state at P0 — that prompt/CPU-heuristic work is deferred to P1.

use std::time::Duration;

use serde::Serialize;

/// Silence past which a running agent is reported as `Idle` (honest
/// "last activity Ns ago") instead of `Working`.
pub const IDLE_THRESHOLD: Duration = Duration::from_secs(60);

/// Silence past which an `Idle` agent escalates to `Wedged` ("time
/// passing, no output"). ≫ idle, per spec §C.
pub const WEDGED_THRESHOLD: Duration = Duration::from_secs(180);

/// How often the liveness poller samples every running agent. A transition
/// becomes visible within one interval of crossing a threshold, so at a
/// 60/180 s scale a 5 s cadence is well inside the noise floor.
pub const LIVENESS_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The honest, *derived* runtime state of an agent. Not persisted, not a
/// `WorkspaceStatus` variant.
///
/// - `Working` / `Idle` / `Wedged` are produced by the liveness poller (T3)
///   from output recency.
/// - `Done` / `Failed` are produced by the PTY exit-watcher from the exit
///   code (`for_exit`).
///
/// Relaunch-"Interrupted" is **not** a variant here: the backend has no
/// runtime emit site for it (recovery runs at boot, before any event
/// listener exists), so it is carried by the persisted
/// `Workspace::interrupted_at` column and derived on the frontend from
/// `status == stopped && interruptedAt != null`. Adding an unconstructed
/// Rust variant would only be dead code and a redundant second signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DerivedState {
    Working,
    Idle,
    Wedged,
    Done,
    Failed,
}

impl DerivedState {
    /// Stable wire string. Kept in lockstep with the `rename_all` above so
    /// the direct-serialize path (`TaskStatusEvent`) and the command-layer
    /// string payload (`TaskStatusPayload`) always agree. Mirrored by
    /// `DerivedAgentState` in `src/lib/types.ts`. All values are single
    /// words, so kebab-case renders them lowercase.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Idle => "idle",
            Self::Wedged => "wedged",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    /// Terminal derivation from a PTY exit code — the exit-watcher path.
    /// `Some(0)` is a clean finish; anything else (including an unknown
    /// code) is a failure.
    pub fn for_exit(exit_code: Option<i64>) -> Self {
        if exit_code == Some(0) {
            Self::Done
        } else {
            Self::Failed
        }
    }
}

/// Injectable thresholds so tests can use 1 s / 2 s instead of 60 s / 180 s
/// — the timer transition must be verifiable without sleeping 3 minutes.
#[derive(Debug, Clone, Copy)]
pub struct LivenessThresholds {
    pub idle: Duration,
    pub wedged: Duration,
}

impl Default for LivenessThresholds {
    fn default() -> Self {
        Self {
            idle: IDLE_THRESHOLD,
            wedged: WEDGED_THRESHOLD,
        }
    }
}

/// Classify a *running* agent from how long it has been silent. Pure —
/// unit-tested as a table below.
///
/// `has_live_handle` is false when a row is `running` in the DB but the
/// runtime holds no PTY for it (an orphan the exit-watcher/recovery hasn't
/// reconciled yet). The honest read there is `Wedged`, never a confident
/// `Working` — a row that claims to be running with no process behind it is
/// exactly the "card said Working, agent was dead" trust break Step 0 exists
/// to kill.
pub fn classify(
    elapsed: Duration,
    has_live_handle: bool,
    thresholds: &LivenessThresholds,
) -> DerivedState {
    if !has_live_handle {
        return DerivedState::Wedged;
    }
    if elapsed < thresholds.idle {
        DerivedState::Working
    } else if elapsed < thresholds.wedged {
        DerivedState::Idle
    } else {
        DerivedState::Wedged
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thresholds() -> LivenessThresholds {
        // Small, explicit thresholds so the boundaries are obvious.
        LivenessThresholds {
            idle: Duration::from_secs(60),
            wedged: Duration::from_secs(180),
        }
    }

    // E0-T2: the classifier's threshold table. Working below idle, Idle in
    // [idle, wedged), Wedged at/after wedged — with the boundaries pinned
    // exactly (they are `<` comparisons).
    #[test]
    fn classify_thresholds() {
        let t = thresholds();

        // Fresh output → Working.
        assert_eq!(classify(Duration::ZERO, true, &t), DerivedState::Working);
        assert_eq!(
            classify(Duration::from_secs(59), true, &t),
            DerivedState::Working
        );

        // At exactly the idle boundary we are no longer Working (`<` idle).
        assert_eq!(
            classify(Duration::from_secs(60), true, &t),
            DerivedState::Idle
        );
        assert_eq!(
            classify(Duration::from_secs(179), true, &t),
            DerivedState::Idle
        );

        // At exactly the wedged boundary we escalate (`<` wedged is false).
        assert_eq!(
            classify(Duration::from_secs(180), true, &t),
            DerivedState::Wedged
        );
        assert_eq!(
            classify(Duration::from_secs(10_000), true, &t),
            DerivedState::Wedged
        );
    }

    // A `running` row with no live PTY handle is Wedged regardless of the
    // (meaningless) elapsed time — never a confident Working.
    #[test]
    fn no_live_handle_is_always_wedged() {
        let t = thresholds();
        assert_eq!(classify(Duration::ZERO, false, &t), DerivedState::Wedged);
        assert_eq!(
            classify(Duration::from_secs(1_000_000), false, &t),
            DerivedState::Wedged
        );
    }

    // The exit-watcher's terminal derivation: clean 0 → Done, everything
    // else (including an unknown/None code) → Failed.
    #[test]
    fn for_exit_maps_code_to_terminal_state() {
        assert_eq!(DerivedState::for_exit(Some(0)), DerivedState::Done);
        assert_eq!(DerivedState::for_exit(Some(1)), DerivedState::Failed);
        assert_eq!(DerivedState::for_exit(Some(137)), DerivedState::Failed);
        assert_eq!(DerivedState::for_exit(None), DerivedState::Failed);
    }

    // The wire strings are frozen — the frontend `DerivedAgentState` union
    // mirrors these exact values, so a rename here is a contract break.
    #[test]
    fn wire_strings_are_stable() {
        assert_eq!(DerivedState::Working.as_str(), "working");
        assert_eq!(DerivedState::Idle.as_str(), "idle");
        assert_eq!(DerivedState::Wedged.as_str(), "wedged");
        assert_eq!(DerivedState::Done.as_str(), "done");
        assert_eq!(DerivedState::Failed.as_str(), "failed");

        // serde and as_str must agree (both feed the same IPC contract).
        let json = serde_json::to_string(&DerivedState::Wedged).unwrap();
        assert_eq!(json, "\"wedged\"");
    }
}
