//! The Board's lanes, derived — never stored. A lane is a pure function of
//! the workspace row, what its agent is doing right now, and its diff
//! against its base branch. No new `WorkspaceStatus` values exist for any
//! of this: an older client would fail to parse them.

use serde::Serialize;

use super::workspace::{Workspace, WorkspaceKind, WorkspaceStatus};

/// One task's column on the Board.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Lane {
    /// Saved, not queued, never launched.
    Draft,
    /// Waiting to be started (by its dependency, or "Start now").
    Queued,
    Running,
    /// The agent is blocked on an approval / question.
    NeedsYou,
    /// The agent stopped (or is idle at its prompt) with changes to review.
    NeedsReview,
    Failed,
    /// Merged / closed, or finished with nothing to review.
    Done,
    /// Archived without a recorded outcome.
    Archived,
}

/// What the task's agent is doing, as far as the board cares. Mirrors
/// `agent_signals::AgentStateKind` (kept here so the domain stays free of
/// the runtime modules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPhase {
    Working,
    Idle,
    NeedsYou,
    Exited,
}

/// Lines/files changed on a task's branch versus its base: committed AND
/// uncommitted work, untracked files included.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub adds: u64,
    pub removes: u64,
    pub files: u64,
}

impl DiffStats {
    /// Nothing to review. `files`, not the line counts: a binary or
    /// mode-only change has no lines but is still a change.
    pub fn is_empty(&self) -> bool {
        self.files == 0
    }
}

/// The lane for `ws`. `None` for a `local` workspace — the repository's
/// own checkout is not a task and never appears on the board.
///
/// `agent` is `None` when phasr isn't tracking the task's agent (not
/// launched since startup); `diff` is `None` when it couldn't be computed
/// (no worktree on this machine, git failed) and is only consulted where
/// it decides the lane.
///
/// Precedence, first match wins:
/// 1. an outcome → Done (whatever the status; a merged task is done);
/// 2. archived → Archived;
/// 3. never launched → Queued (if `queued_at`) or Draft;
/// 4. failed → Failed;
/// 5. running: needs-you → NeedsYou; idle/exited at its prompt with a
///    non-empty diff → NeedsReview; otherwise Running;
/// 6. stopped/completed: empty diff → Done; otherwise NeedsReview — an
///    unknown diff counts as "maybe changes", so work is never hidden;
/// 7. a launched row still `pending` (mid-start, or a legacy pre-created
///    workspace never opened) → Draft unless its agent is already live.
pub fn derive_lane(
    ws: &Workspace,
    agent: Option<AgentPhase>,
    diff: Option<&DiffStats>,
) -> Option<Lane> {
    if ws.workspace_kind == WorkspaceKind::Local {
        return None;
    }
    if ws.outcome.is_some() {
        return Some(Lane::Done);
    }
    let has_changes = diff.map(|d| !d.is_empty());
    Some(match ws.status {
        WorkspaceStatus::Archived => Lane::Archived,
        _ if ws.is_queued() => Lane::Queued,
        _ if ws.is_draft() => Lane::Draft,
        WorkspaceStatus::Failed => Lane::Failed,
        WorkspaceStatus::Running => match agent {
            Some(AgentPhase::NeedsYou) => Lane::NeedsYou,
            Some(AgentPhase::Idle | AgentPhase::Exited) if has_changes == Some(true) => {
                Lane::NeedsReview
            }
            _ => Lane::Running,
        },
        WorkspaceStatus::Stopped | WorkspaceStatus::Completed => match has_changes {
            Some(false) => Lane::Done,
            Some(true) | None => Lane::NeedsReview,
        },
        WorkspaceStatus::Pending => match agent {
            Some(AgentPhase::NeedsYou) => Lane::NeedsYou,
            Some(_) => Lane::Running,
            None => Lane::Draft,
        },
    })
}

/// Whether a queued task waiting on `dependency` may start: the dependency
/// reached review or finished. A failed or still-running dependency keeps
/// it waiting (the user can always "Start now").
pub fn dependency_satisfied(dependency: &Workspace, lane: Option<Lane>) -> bool {
    dependency.outcome.is_some()
        || dependency.status == WorkspaceStatus::Completed
        || matches!(lane, Some(Lane::NeedsReview | Lane::Done | Lane::Archived))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workspace::TaskOutcome;
    use chrono::Utc;

    const CHANGES: DiffStats = DiffStats {
        adds: 3,
        removes: 1,
        files: 2,
    };
    const CLEAN: DiffStats = DiffStats {
        adds: 0,
        removes: 0,
        files: 0,
    };

    fn ws(status: WorkspaceStatus) -> Workspace {
        let mut w = Workspace::new("r".into(), "t".into(), "claude".into());
        w.status = status;
        // Launched: a worktree branch exists.
        w.branch = Some("phasr/t".into());
        w
    }

    fn draft() -> Workspace {
        Workspace::new("r".into(), "t".into(), "claude".into())
    }

    fn queued() -> Workspace {
        let mut w = draft();
        w.queued_at = Some(Utc::now());
        w
    }

    fn with_outcome(mut w: Workspace) -> Workspace {
        w.outcome = Some(TaskOutcome::Merged);
        w
    }

    /// Every row the board can see, against every agent phase and diff
    /// state that matters for it.
    #[test]
    fn lane_table() {
        use AgentPhase::*;
        use Lane as L;
        use WorkspaceStatus as S;
        let none: Option<AgentPhase> = None;
        #[rustfmt::skip]
        let table: Vec<(&str, Workspace, Option<AgentPhase>, Option<&DiffStats>, Lane)> = vec![
            ("draft",                       draft(),                 none,           None,           L::Draft),
            ("draft ignores diff",          draft(),                 none,           Some(&CHANGES), L::Draft),
            ("queued",                      queued(),                none,           None,           L::Queued),
            ("queued with outcome",         with_outcome(queued()),  none,           None,           L::Done),
            ("running, working",            ws(S::Running),          Some(Working),  Some(&CHANGES), L::Running),
            ("running, untracked agent",    ws(S::Running),          none,           Some(&CHANGES), L::Running),
            ("running, needs you",          ws(S::Running),          Some(NeedsYou), Some(&CHANGES), L::NeedsYou),
            ("running, needs you, clean",   ws(S::Running),          Some(NeedsYou), Some(&CLEAN),   L::NeedsYou),
            ("running, idle, changes",      ws(S::Running),          Some(Idle),     Some(&CHANGES), L::NeedsReview),
            ("running, idle, clean",        ws(S::Running),          Some(Idle),     Some(&CLEAN),   L::Running),
            ("running, idle, diff unknown", ws(S::Running),          Some(Idle),     None,           L::Running),
            ("running, exited, changes",    ws(S::Running),          Some(Exited),   Some(&CHANGES), L::NeedsReview),
            ("running, idle, merged",       with_outcome(ws(S::Running)), Some(Idle), Some(&CHANGES), L::Done),
            ("stopped, changes",            ws(S::Stopped),          none,           Some(&CHANGES), L::NeedsReview),
            ("stopped, clean",              ws(S::Stopped),          none,           Some(&CLEAN),   L::Done),
            ("stopped, diff unknown",       ws(S::Stopped),          none,           None,           L::NeedsReview),
            ("stopped, merged",             with_outcome(ws(S::Stopped)), none,      Some(&CHANGES), L::Done),
            ("completed, changes",          ws(S::Completed),        none,           Some(&CHANGES), L::NeedsReview),
            ("completed, clean",            ws(S::Completed),        none,           Some(&CLEAN),   L::Done),
            ("failed",                      ws(S::Failed),           none,           Some(&CHANGES), L::Failed),
            ("failed, closed",              with_outcome(ws(S::Failed)), none,       None,           L::Done),
            ("archived",                    ws(S::Archived),         none,           Some(&CHANGES), L::Archived),
            ("archived, merged",            with_outcome(ws(S::Archived)), none,     None,           L::Done),
            ("pending, launching",          ws(S::Pending),          none,           None,           L::Draft),
            ("pending, agent live",         ws(S::Pending),          Some(Working),  None,           L::Running),
        ];
        for (name, w, agent, diff, want) in table {
            assert_eq!(derive_lane(&w, agent, diff), Some(want), "{name}");
        }
    }

    #[test]
    fn local_workspaces_have_no_lane() {
        let mut local = ws(WorkspaceStatus::Running);
        local.workspace_kind = WorkspaceKind::Local;
        assert_eq!(derive_lane(&local, Some(AgentPhase::Idle), Some(&CHANGES)), None);
    }

    #[test]
    fn dependency_is_satisfied_at_review_or_later() {
        let running = ws(WorkspaceStatus::Running);
        assert!(!dependency_satisfied(&running, Some(Lane::Running)));
        assert!(!dependency_satisfied(&running, Some(Lane::NeedsYou)));
        assert!(dependency_satisfied(&running, Some(Lane::NeedsReview)));
        assert!(!dependency_satisfied(&ws(WorkspaceStatus::Failed), Some(Lane::Failed)));
        assert!(dependency_satisfied(&ws(WorkspaceStatus::Completed), Some(Lane::Running)));
        assert!(dependency_satisfied(&with_outcome(ws(WorkspaceStatus::Stopped)), None));
        assert!(dependency_satisfied(&ws(WorkspaceStatus::Archived), Some(Lane::Archived)));
        assert!(!dependency_satisfied(&queued(), Some(Lane::Queued)));
    }

    #[test]
    fn wire_shapes() {
        assert_eq!(serde_json::to_value(Lane::NeedsReview).unwrap(), "needs-review");
        assert_eq!(serde_json::to_value(Lane::NeedsYou).unwrap(), "needs-you");
        assert_eq!(
            serde_json::to_value(CHANGES).unwrap(),
            serde_json::json!({"adds": 3, "removes": 1, "files": 2})
        );
    }
}
