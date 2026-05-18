use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Stopped,
    Completed,
    Failed,
    Archived,
}

impl TaskStatus {
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

    /// Returns true if `next` is a legal successor state from `self`.
    /// Used to keep transitions sane regardless of which layer is calling.
    pub fn can_transition_to(self, next: Self) -> bool {
        use TaskStatus::*;
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
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prompt: Option<String>,
    pub preset_id: Option<String>,
    pub command: String,
    pub status: TaskStatus,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub exit_code: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

impl Task {
    pub fn new(workspace_id: String, name: String, command: String) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id,
            name,
            prompt: None,
            preset_id: None,
            command,
            status: TaskStatus::Pending,
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
        assert!(TaskStatus::Pending.can_transition_to(TaskStatus::Running));
        assert!(TaskStatus::Running.can_transition_to(TaskStatus::Completed));
    }

    #[test]
    fn rejects_illegal_transition() {
        assert!(!TaskStatus::Pending.can_transition_to(TaskStatus::Completed));
        assert!(!TaskStatus::Completed.can_transition_to(TaskStatus::Running));
    }

    #[test]
    fn round_trip_str() {
        for status in [
            TaskStatus::Pending,
            TaskStatus::Running,
            TaskStatus::Stopped,
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Archived,
        ] {
            assert_eq!(TaskStatus::from_str(status.as_str()), Some(status));
        }
    }

    #[test]
    fn unknown_status_string_returns_none() {
        assert_eq!(TaskStatus::from_str("nonsense"), None);
    }
}
