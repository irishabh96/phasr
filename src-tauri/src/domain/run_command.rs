use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// When a run command starts without the user clicking Run.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RunWhen {
    /// Only when the user runs it.
    #[default]
    Manual,
    /// Headless, in the task's worktree, whenever a task's agent starts
    /// (a dev server, a watcher).
    TaskStart,
    /// As a check, when the task enters review and its worktree changed
    /// since the last run (tests, lint).
    BeforeReview,
}

impl RunWhen {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::TaskStart => "task_start",
            Self::BeforeReview => "before_review",
        }
    }

    /// Lenient: an unknown value (a trigger a newer build added) reads as
    /// `Manual` — never auto-running something this build doesn't
    /// understand is the safe direction.
    pub fn parse_lenient(s: &str) -> Self {
        match s {
            "task_start" => Self::TaskStart,
            "before_review" => Self::BeforeReview,
            _ => Self::Manual,
        }
    }

    /// Starts without a click, so it's subject to the trusted-hash guard.
    pub fn is_automatic(self) -> bool {
        self != Self::Manual
    }
}

/// A named shell command attached to a repository — typical dev/test/build
/// entrypoints like `npm run dev`. Runs in a task's worktree when started
/// for a task, else in the repository's own checkout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunCommand {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub command: String,
    pub shortcut: Option<String>,
    pub pinned: bool,
    pub sort_order: i64,
    #[serde(default)]
    pub run_when: RunWhen,
    /// Scan output for a dev-server port and report it once it accepts
    /// connections.
    #[serde(default)]
    pub detect_port: bool,
    /// Gates "Approve & create PR": needs a passing run on the task's
    /// current state (see `review::gate`).
    #[serde(default)]
    pub required_for_approve: bool,
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
            sort_order: 0,
            run_when: RunWhen::Manual,
            detect_port: false,
            required_for_approve: false,
            created_at: now,
            updated_at: now,
        }
    }

    /// Whether this command is a check: something "Run checks" runs and
    /// the review inspector lists.
    pub fn is_check(&self) -> bool {
        self.required_for_approve || self.run_when == RunWhen::BeforeReview
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_when_round_trips_and_unknown_is_manual() {
        for when in [RunWhen::Manual, RunWhen::TaskStart, RunWhen::BeforeReview] {
            assert_eq!(RunWhen::parse_lenient(when.as_str()), when);
            assert_eq!(
                serde_json::to_value(when).unwrap(),
                serde_json::Value::String(when.as_str().into())
            );
        }
        assert_eq!(RunWhen::parse_lenient("on_merge"), RunWhen::Manual);
    }

    #[test]
    fn a_payload_without_the_m8_fields_deserializes() {
        let json = serde_json::json!({
            "id": "r", "repositoryId": "repo", "name": "dev", "command": "npm run dev",
            "shortcut": null, "pinned": false, "sortOrder": 0,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
        });
        let rc: RunCommand = serde_json::from_value(json).unwrap();
        assert_eq!(rc.run_when, RunWhen::Manual);
        assert!(!rc.detect_port && !rc.required_for_approve && !rc.is_check());
    }
}
