use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::Agent;

/// One agent run inside a repository. Owns an isolated git worktree on
/// a `phasr/*` branch and a PTY session. Previously called `Task`;
/// renamed in Phase 7 so the wording matches what users see in similar tools.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Pending,
    Running,
    Stopped,
    Completed,
    Failed,
    Archived,
}

impl WorkspaceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Archived => "archived",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "stopped" => Self::Stopped,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "archived" => Self::Archived,
            _ => return None,
        })
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        use WorkspaceStatus::*;
        match (self, next) {
            (Pending, Running | Failed | Archived) => true,
            // Archive while running is valid — the command kills the
            // PTY first, so a running row going straight to archived
            // is the intended path.
            (Running, Stopped | Completed | Failed | Archived) => true,
            (Stopped, Running | Archived | Failed) => true,
            // Completed/Failed → Running is the HUMAN-initiated rework respawn
            // (a bounce on an exited producer re-spawns it in its own worktree,
            // `respawn_for_rework`). Safe: that path only fires when the PTY is
            // provably dead, so no live process gets its row yanked.
            (Completed, Running | Archived) => true,
            (Failed, Running | Archived | Pending) => true,
            (Archived, Pending) => true,
            (a, b) if a == b => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Agent,
    Local,
    /// A decomposition's integration container. Has no PTY of its own; until
    /// integration it carries no branch/worktree (at integration it REUSES its
    /// existing `branch`/`worktree_path`, spec B1). Board state, never synced.
    Parent,
    /// One agent run inside a decomposition. A real PTY agent exactly like
    /// `Agent`, but tied to a `parent_id` + `role`. Board state, never synced.
    Subtask,
}

impl WorkspaceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Local => "local",
            Self::Parent => "parent",
            Self::Subtask => "subtask",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "agent" => Self::Agent,
            "local" => Self::Local,
            "parent" => Self::Parent,
            "subtask" => Self::Subtask,
            _ => return None,
        })
    }

    pub fn is_local(self) -> bool {
        self == Self::Local
    }

    /// True for kinds that own a live PTY agent and therefore need honest
    /// Working/Idle/Wedged liveness. A `Subtask` is a real agent just like a
    /// standalone `Agent`, so it MUST be classified by the liveness poller —
    /// this is spec claim #3 / LANDMINE #1: the poller's original `!= Agent`
    /// filter silently skipped subtasks, so a wedged subtask card never showed
    /// honest status. `Parent` (no PTY) and `Local` (no liveness model) are
    /// excluded.
    pub fn runs_agent(self) -> bool {
        matches!(self, Self::Agent | Self::Subtask)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repository_id: String,
    pub workspace_kind: WorkspaceKind,
    pub name: String,
    pub prompt: Option<String>,
    pub agent: Option<Agent>,
    pub command: String,
    pub status: WorkspaceStatus,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
    /// Set only on a `subtask`: the `parent` workspace it decomposes from.
    /// NULL for every standalone `agent`/`local` and for a `parent` row itself.
    pub parent_id: Option<String>,
    /// Set only on a `subtask`: its slot in the decomposition (e.g. `backend`,
    /// `frontend`). The subtask dedup key is `(parent_id, role)`, never `name`.
    pub role: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    /// Set only on a `parent`: when `ship_epic` landed the integration branch
    /// on the default branch (migration 0016). A FACT, not a derivation — it
    /// survives base moving ahead, unlike the old `aheadOfTarget === 0` read.
    pub shipped_at: Option<DateTime<Utc>>,
    /// Set only when this `running` row was orphaned by an app relaunch
    /// (recovery sweep in `lib.rs::recover_startup_state`). Distinguishes a
    /// relaunch-orphan from a calm user `stop_task` — both otherwise land
    /// `stopped` + `finished_at` with `exit_code = None`. Machine-local:
    /// never synced (see migration 0012). The frontend derives the honest
    /// "was interrupted" (Wedged) state from `status = stopped && this`.
    pub interrupted_at: Option<DateTime<Utc>>,
    /// Autopilot (Phase 5a). Meaningful ONLY on a `parent` (epic) row: when
    /// `true` the driver auto-advances that epic's gate ladder. LOCAL-ONLY —
    /// backed by the additive `autopilot_enabled` column (migration 0015); board
    /// rows are never synced (the `workspace_kind='agent'` PUSH filter), so this
    /// needs no sync change. Defaults `false` (opt-in per epic).
    pub autopilot_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

impl Workspace {
    pub fn new(repository_id: String, name: String, command: String) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id,
            workspace_kind: WorkspaceKind::Agent,
            name,
            prompt: None,
            agent: None,
            command,
            status: WorkspaceStatus::Pending,
            branch: None,
            worktree_path: None,
            exit_code: None,
            parent_id: None,
            role: None,
            created_at: now,
            started_at: None,
            finished_at: None,
            archived_at: None,
            shipped_at: None,
            interrupted_at: None,
            autopilot_enabled: false,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_pending_running_completed() {
        assert!(WorkspaceStatus::Pending.can_transition_to(WorkspaceStatus::Running));
        assert!(WorkspaceStatus::Running.can_transition_to(WorkspaceStatus::Completed));
    }

    #[test]
    fn rejects_illegal_transition() {
        assert!(!WorkspaceStatus::Pending.can_transition_to(WorkspaceStatus::Completed));
        // Archived is the retirement state — only the explicit un-archive
        // (→ Pending) leaves it, never a direct revival.
        assert!(!WorkspaceStatus::Archived.can_transition_to(WorkspaceStatus::Running));
    }

    // Completed/Failed → Running is LEGAL since Phase 5: the human-bounce
    // respawn (`respawn_for_rework`) revives an exited producer, and the path
    // only fires when the PTY is provably dead.
    #[test]
    fn rework_respawn_transitions_are_legal() {
        assert!(WorkspaceStatus::Completed.can_transition_to(WorkspaceStatus::Running));
        assert!(WorkspaceStatus::Failed.can_transition_to(WorkspaceStatus::Running));
    }

    #[test]
    fn round_trip_str() {
        for status in [
            WorkspaceStatus::Pending,
            WorkspaceStatus::Running,
            WorkspaceStatus::Stopped,
            WorkspaceStatus::Completed,
            WorkspaceStatus::Failed,
            WorkspaceStatus::Archived,
        ] {
            assert_eq!(WorkspaceStatus::from_str(status.as_str()), Some(status));
        }
    }

    #[test]
    fn unknown_status_string_returns_none() {
        assert_eq!(WorkspaceStatus::from_str("nonsense"), None);
    }

    #[test]
    fn workspace_kind_round_trip_str() {
        for kind in [
            WorkspaceKind::Agent,
            WorkspaceKind::Local,
            WorkspaceKind::Parent,
            WorkspaceKind::Subtask,
        ] {
            assert_eq!(WorkspaceKind::from_str(kind.as_str()), Some(kind));
        }
        assert_eq!(WorkspaceKind::from_str("agent"), Some(WorkspaceKind::Agent));
        assert_eq!(WorkspaceKind::from_str("local"), Some(WorkspaceKind::Local));
        assert_eq!(WorkspaceKind::from_str("parent"), Some(WorkspaceKind::Parent));
        assert_eq!(
            WorkspaceKind::from_str("subtask"),
            Some(WorkspaceKind::Subtask)
        );
        assert_eq!(WorkspaceKind::Parent.as_str(), "parent");
        assert_eq!(WorkspaceKind::Subtask.as_str(), "subtask");
        assert_eq!(WorkspaceKind::from_str("nonsense"), None);
        assert!(WorkspaceKind::Local.is_local());
        assert!(!WorkspaceKind::Subtask.is_local());
    }

    // LANDMINE #1 (spec claim #3): only kinds that own a live PTY agent get
    // classified by the liveness poller. A `Subtask` is a real agent, so it
    // MUST count; `Parent` (no PTY) and `Local` (no liveness model) must not.
    #[test]
    fn runs_agent_truth_table() {
        assert!(WorkspaceKind::Agent.runs_agent());
        assert!(WorkspaceKind::Subtask.runs_agent());
        assert!(!WorkspaceKind::Local.runs_agent());
        assert!(!WorkspaceKind::Parent.runs_agent());
    }
}
