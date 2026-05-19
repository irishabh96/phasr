use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One agent run inside a repository. Owns an isolated git worktree on
/// a `phasr/<short-id>` branch and a PTY session. Previously called
/// `Task`; renamed in Phase 7 so the wording matches what users see
/// in similar tools.
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
            (Running, Stopped | Completed | Failed) => true,
            (Stopped, Running | Archived | Failed) => true,
            (Completed, Archived) => true,
            (Failed, Archived | Pending) => true,
            (Archived, Pending) => true,
            (a, b) if a == b => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
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
            name,
            prompt: None,
            agent_id: None,
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
}
