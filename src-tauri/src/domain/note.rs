use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Where a note was born. Recorded once at creation and never updated —
/// provenance describes the note's origin, not its last editor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoteOriginKind {
    Workspace,
    Terminal,
    RunCommand,
    Repository,
}

impl NoteOriginKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NoteOriginKind::Workspace => "workspace",
            NoteOriginKind::Terminal => "terminal",
            NoteOriginKind::RunCommand => "runCommand",
            NoteOriginKind::Repository => "repository",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "workspace" => Some(NoteOriginKind::Workspace),
            "terminal" => Some(NoteOriginKind::Terminal),
            "runCommand" => Some(NoteOriginKind::RunCommand),
            "repository" => Some(NoteOriginKind::Repository),
            _ => None,
        }
    }
}

/// A repository-scoped note. Notes outlive every workspace and terminal
/// of their repository; the `origin_*` fields are a snapshot taken at
/// creation (see migration 0012 for why they are not foreign keys).
/// `deleted_at`/`synced_at`/`dirty` stay in the store layer, like
/// `Repository`/`Workspace`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub repository_id: String,
    pub body: String,
    pub origin_kind: NoteOriginKind,
    pub origin_workspace_id: Option<String>,
    pub origin_workspace_name: Option<String>,
    pub origin_terminal_id: Option<String>,
    /// Human-readable origin ("Terminal 2", "Agent", "Repository home"),
    /// composed server-side at creation.
    pub origin_label: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set when the note is checked off; the sort key for the done list.
    /// `Some` IS "done" — there is no separate boolean to disagree with it.
    pub done_at: Option<DateTime<Utc>>,
}

impl Note {
    pub fn new(repository_id: String, body: String, origin_kind: NoteOriginKind) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id,
            body,
            origin_kind,
            origin_workspace_id: None,
            origin_workspace_name: None,
            origin_terminal_id: None,
            origin_label: String::new(),
            created_at: now,
            updated_at: now,
            done_at: None,
        }
    }
}
