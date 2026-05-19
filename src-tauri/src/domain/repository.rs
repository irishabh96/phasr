use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A connection to a local git repository. Each repository can host
/// many `Workspace`s (isolated per-agent worktrees). Previously called
/// `Workspace` in earlier phases — renamed for clarity in Phase 7.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Repository {
    pub fn new(name: String, local_path: Option<String>, remote_url: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            remote_url,
            local_path,
            default_branch: "main".into(),
            created_at: now,
            updated_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}
