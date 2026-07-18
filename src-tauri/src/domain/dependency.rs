use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One directed edge in a parent workspace's decomposition DAG:
/// `from_subtask_id` (the producer) must publish its contract before
/// `to_subtask_id` (the dependent) is allowed to spawn.
///
/// Whether an edge is *satisfied* is DERIVED at read time by joining against
/// `workspace_contracts` (spec claim #10) — deliberately NOT stored as a flag
/// on the edge, so board state never lives in a persisted column. Machine-local
/// (never synced): these rows carry no `user_id` and are auto-excluded from the
/// `workspace_kind='agent'` sync push filter by construction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDependency {
    pub id: String,
    pub parent_id: String,
    pub from_subtask_id: String,
    pub to_subtask_id: String,
    pub created_at: DateTime<Utc>,
}

impl WorkspaceDependency {
    pub fn new(parent_id: String, from_subtask_id: String, to_subtask_id: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id,
            from_subtask_id,
            to_subtask_id,
            created_at: Utc::now(),
        }
    }
}
