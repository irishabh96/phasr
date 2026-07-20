use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A named shell command attached to a repository. Runs in the
/// repository's main local path (not a worktree) — typical
/// dev/test/build entrypoints like `npm run dev`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunCommand {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub command: String,
    pub shortcut: Option<String>,
    pub pinned: bool,
    /// Opt this command into the captured Validate runner (V1). When true,
    /// `validate_ticket` runs it as a captured per-worktree subprocess and folds
    /// its exit code into the ticket's pass/fail. Default false — the user marks
    /// lint/test/typecheck explicitly (spec J2). Local-only: never synced.
    pub run_in_validate: bool,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl RunCommand {
    pub fn new(repository_id: String, name: String, command: String) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id,
            name,
            command,
            shortcut: None,
            pinned: false,
            run_in_validate: false,
            sort_order: 0,
            created_at: now,
            updated_at: now,
        }
    }
}
