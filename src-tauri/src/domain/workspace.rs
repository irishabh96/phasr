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
            (Completed, Archived) => true,
            (Failed, Archived | Pending) => true,
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
}

impl WorkspaceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Local => "local",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "agent" => Self::Agent,
            "local" => Self::Local,
            _ => return None,
        })
    }

    pub fn is_local(self) -> bool {
        self == Self::Local
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
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
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
            created_at: now,
            started_at: None,
            finished_at: None,
            archived_at: None,
            updated_at: now,
        }
    }

    /// An agent task that has never been launched anywhere: still `pending`
    /// with no branch. This build never leaves a row in that state
    /// (`start_task` cuts the branch before the row is inserted), but newer
    /// builds create drafts and queued tasks exactly like this, and they
    /// sync. Such a row has no worktree to run in — `cwd_for_task` would fall
    /// back to the repository's own checkout — so nothing may spawn its
    /// agent here. Keyed on `branch` rather than `worktree_path` because the
    /// branch syncs and the path is machine-local. Same definition as the
    /// redesign's `Workspace::is_unlaunched`, so both builds agree on which
    /// rows are drafts.
    pub fn is_unlaunched(&self) -> bool {
        self.workspace_kind == WorkspaceKind::Agent
            && self.status == WorkspaceStatus::Pending
            && self.branch.is_none()
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
        assert!(!WorkspaceStatus::Completed.can_transition_to(WorkspaceStatus::Running));
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
    fn unlaunched_means_a_pending_agent_row_with_no_branch() {
        let draft = Workspace::new("r".into(), "draft".into(), "claude".into());
        assert!(
            draft.is_unlaunched(),
            "a fresh pending row with no branch is a draft"
        );

        let mut launched = draft.clone();
        launched.branch = Some("phasr/abc".into());
        assert!(
            !launched.is_unlaunched(),
            "a branch means it was launched somewhere"
        );

        for status in [
            WorkspaceStatus::Running,
            WorkspaceStatus::Stopped,
            WorkspaceStatus::Completed,
            WorkspaceStatus::Failed,
            WorkspaceStatus::Archived,
        ] {
            let mut row = draft.clone();
            row.status = status;
            assert!(!row.is_unlaunched(), "{status:?} is not a draft");
        }

        // The repo's own checkout row is never a draft, branch or not.
        let mut local = draft.clone();
        local.workspace_kind = WorkspaceKind::Local;
        assert!(!local.is_unlaunched());
    }

    #[test]
    fn workspace_kind_round_trip_str() {
        assert_eq!(WorkspaceKind::from_str("agent"), Some(WorkspaceKind::Agent));
        assert_eq!(WorkspaceKind::from_str("local"), Some(WorkspaceKind::Local));
        assert_eq!(WorkspaceKind::Agent.as_str(), "agent");
        assert_eq!(WorkspaceKind::Local.as_str(), "local");
        assert!(WorkspaceKind::Local.is_local());
    }
}
