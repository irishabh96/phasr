use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A published handoff contract — the file→DB bridge that unblocks dependents.
/// A subtask writes a freeform Markdown contract to a file OUTSIDE every
/// worktree; the scheduler (or the manual "mark done" override) mirrors it as
/// one of these rows with `published_at` stamped.
///
/// A dependent's incoming edge counts as satisfied once its producer has a row
/// here with `published_at` set — this is the ONLY completion signal, because
/// an interactive agent almost never exits on its own (process exit != task
/// done, spec §0.1). `published_at` is `None` while a row exists but the
/// contract has not yet been published. Machine-local (never synced): no
/// `user_id`, auto-excluded from the `workspace_kind='agent'` sync push filter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContract {
    pub id: String,
    pub parent_id: String,
    pub subtask_id: String,
    pub role: String,
    pub contract_path: String,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl WorkspaceContract {
    pub fn new(
        parent_id: String,
        subtask_id: String,
        role: String,
        contract_path: String,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id,
            subtask_id,
            role,
            contract_path,
            published_at: None,
            created_at: Utc::now(),
        }
    }
}
