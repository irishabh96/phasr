//! Review: check runs, the approve gate, and diff comments sent to the
//! agent. Pure data + rules; the runner lives in `crate::checks`, the git /
//! `gh` side in `crate::review`.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::run_command::RunCommand;

/// Where a check run is in its life. The last five are terminal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Queued,
    Running,
    Passed,
    Failed,
    Cancelled,
    /// Couldn't run at all (no worktree, the shell failed to start, the app
    /// quit mid-run).
    Error,
    Timeout,
}

impl CheckStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
            Self::Timeout => "timeout",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "passed" => Self::Passed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "error" => Self::Error,
            "timeout" => Self::Timeout,
            _ => return None,
        })
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

/// One execution of a run command as a check, in a task's worktree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub id: String,
    pub workspace_id: String,
    /// `None` once the run command was deleted (history keeps name/command).
    pub run_command_id: Option<String>,
    pub name: String,
    pub command: String,
    pub status: CheckStatus,
    pub exit_code: Option<i64>,
    /// Worktree fingerprint when the run was queued (`checks::fingerprint`).
    pub fingerprint: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    /// Last 64 KiB of merged output; `get_check_output` reads the full log.
    pub output_tail: String,
    #[serde(skip)]
    pub log_path: Option<String>,
}

/// `list_check_runs`: the latest run of each check plus the approve gate.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    /// Latest run per run command (checks first, in run-command order).
    pub runs: Vec<CheckRun>,
    /// Run command ids with `required_for_approve`.
    pub required: Vec<String>,
    /// Every required check's latest run passed on the current worktree.
    pub required_satisfied: bool,
    /// Ids (of `runs`) whose fingerprint isn't the worktree's current one:
    /// the code changed since they ran.
    pub stale_ids: Vec<String>,
    /// Run command ids set to auto-run that were synced from another
    /// machine and not yet confirmed here, so they were not auto-run.
    pub needs_confirmation: Vec<String>,
}

/// Latest run per run command id, newest wins. `runs` in any order.
pub fn latest_by_command(runs: &[CheckRun]) -> HashMap<String, &CheckRun> {
    let mut latest: HashMap<String, &CheckRun> = HashMap::new();
    for run in runs {
        let Some(id) = run.run_command_id.as_deref() else {
            continue;
        };
        match latest.get(id) {
            Some(prev) if prev.created_at >= run.created_at => {}
            _ => {
                latest.insert(id.to_string(), run);
            }
        }
    }
    latest
}

/// Whether `run` (of `rc`) describes the code and the check as they are
/// now: same worktree fingerprint AND the same command text. A pass of
/// `true` says nothing about a check since edited to `pnpm test`.
/// `current_fingerprint: None` (couldn't be computed) matches nothing.
pub fn run_is_current(run: &CheckRun, rc: &RunCommand, current_fingerprint: Option<&str>) -> bool {
    current_fingerprint.is_some() && run.fingerprint.as_deref() == current_fingerprint && run.command == rc.command
}

/// The approve gate: names of required checks that do NOT have a passing
/// run on the worktree as it is now, of the command as it is now. A pass
/// on an older state (or an older command) doesn't count — the agent may
/// have broken it since.
pub fn unsatisfied_required(
    commands: &[RunCommand],
    runs: &[CheckRun],
    current_fingerprint: Option<&str>,
) -> Vec<String> {
    let latest = latest_by_command(runs);
    commands
        .iter()
        .filter(|rc| rc.required_for_approve)
        .filter(|rc| {
            let ok = latest.get(&rc.id).is_some_and(|run| {
                run.status == CheckStatus::Passed && run_is_current(run, rc, current_fingerprint)
            });
            !ok
        })
        .map(|rc| rc.name.clone())
        .collect()
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CommentSide {
    /// `line` numbers the new file (an added or context line).
    #[default]
    New,
    /// `line` numbers the old file (a removed line).
    Old,
}

impl CommentSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Old => "old",
        }
    }

    pub fn parse_lenient(s: &str) -> Self {
        if s == "old" {
            Self::Old
        } else {
            Self::New
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CommentStatus {
    /// Written, not yet sent to the agent.
    #[default]
    Pending,
    Sent,
    Resolved,
}

impl CommentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Resolved => "resolved",
        }
    }

    pub fn parse_lenient(s: &str) -> Self {
        match s {
            "sent" => Self::Sent,
            "resolved" => Self::Resolved,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub line: i64,
    pub side: CommentSide,
    pub anchor_text: Option<String>,
    pub body: String,
    pub status: CommentStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub sent_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

impl ReviewComment {
    pub fn new(workspace_id: String, path: String, line: i64, side: CommentSide, body: String) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id,
            path,
            line,
            side,
            anchor_text: None,
            body,
            status: CommentStatus::Pending,
            created_at: now,
            updated_at: now,
            sent_at: None,
            resolved_at: None,
        }
    }
}

/// The message the agent receives for "Send all comments" / "Request
/// changes": an optional lead-in, then a numbered markdown list —
/// `path:line` (with "(removed line)" for old-side comments), the commented
/// line quoted (line numbers drift as the agent edits; the text anchors
/// it), then the body, indented under its number.
pub fn format_review_comments(intro: Option<&str>, comments: &[ReviewComment]) -> String {
    let mut out = String::new();
    if let Some(intro) = intro.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(intro);
    }
    if comments.is_empty() {
        return out;
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    for (i, c) in comments.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let side = match c.side {
            CommentSide::New => "",
            CommentSide::Old => " (removed line)",
        };
        out.push_str(&format!("{}. `{}:{}`{}\n", i + 1, c.path, c.line, side));
        if let Some(anchor) = c.anchor_text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            out.push_str(&format!("   > {anchor}\n"));
        }
        for line in c.body.trim().lines() {
            out.push_str("   ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::run_command::RunWhen;
    use chrono::TimeZone;

    fn rc(id: &str, name: &str, required: bool) -> RunCommand {
        let mut rc = RunCommand::new("repo".into(), name.into(), format!("run-{id}"));
        rc.id = id.into();
        rc.required_for_approve = required;
        rc
    }

    fn run(cmd: &str, status: CheckStatus, fp: &str, minute: u32) -> CheckRun {
        CheckRun {
            id: format!("{cmd}-{minute}"),
            workspace_id: "ws".into(),
            run_command_id: Some(cmd.into()),
            name: cmd.into(),
            command: format!("run-{cmd}"),
            status,
            exit_code: None,
            fingerprint: Some(fp.into()),
            created_at: Utc.with_ymd_and_hms(2026, 11, 9, 10, minute, 0).unwrap(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            output_tail: String::new(),
            log_path: None,
        }
    }

    #[test]
    fn gate_needs_the_latest_run_passed_on_the_current_fingerprint() {
        let commands = vec![rc("t", "test", true), rc("l", "lint", true), rc("d", "dev", false)];
        // test: failed then passed on "fp1" → ok while fp1 is current.
        // lint: passed on fp0 (stale) → not ok.
        let runs = vec![
            run("t", CheckStatus::Failed, "fp1", 1),
            run("t", CheckStatus::Passed, "fp1", 2),
            run("l", CheckStatus::Passed, "fp0", 3),
        ];
        assert_eq!(unsatisfied_required(&commands, &runs, Some("fp1")), vec!["lint"]);
        // An edit (new fingerprint) un-satisfies test too.
        assert_eq!(
            unsatisfied_required(&commands, &runs, Some("fp2")),
            vec!["test", "lint"]
        );
        // Never ran.
        assert_eq!(unsatisfied_required(&commands, &[], Some("fp1")), vec!["test", "lint"]);
        // Unknown current state satisfies nothing.
        assert_eq!(unsatisfied_required(&commands, &runs, None), vec!["test", "lint"]);
        // A later failure on the same state wins over an earlier pass.
        let runs = vec![run("t", CheckStatus::Passed, "fp1", 1), run("t", CheckStatus::Failed, "fp1", 2)];
        assert_eq!(unsatisfied_required(&commands[..1], &runs, Some("fp1")), vec!["test"]);
        // No required checks → nothing to satisfy.
        assert!(unsatisfied_required(&commands[2..], &[], None).is_empty());
    }

    /// A pass of the OLD command doesn't satisfy an edited check: `true`
    /// passing says nothing about `pnpm test`.
    #[test]
    fn gate_ignores_a_pass_of_a_since_edited_command() {
        let mut commands = vec![rc("t", "test", true)];
        let runs = vec![run("t", CheckStatus::Passed, "fp1", 1)];
        assert!(unsatisfied_required(&commands, &runs, Some("fp1")).is_empty());
        commands[0].command = "pnpm test".into();
        assert_eq!(unsatisfied_required(&commands, &runs, Some("fp1")), vec!["test"]);
        assert!(!run_is_current(&runs[0], &commands[0], Some("fp1")));
    }

    #[test]
    fn checks_are_required_or_before_review() {
        let mut c = rc("x", "x", false);
        assert!(!c.is_check());
        c.run_when = RunWhen::BeforeReview;
        assert!(c.is_check());
    }

    /// Snapshot of exactly what the agent receives.
    #[test]
    fn comment_message_format_snapshot() {
        let mut a = ReviewComment::new("ws".into(), "src/app.ts".into(), 12, CommentSide::New, "Rename this to `count`.".into());
        a.anchor_text = Some("  const n = items.length;".into());
        let mut b = ReviewComment::new(
            "ws".into(),
            "src/old.rs".into(),
            40,
            CommentSide::Old,
            "Why was this removed?\nIt handled the empty case.".into(),
        );
        b.anchor_text = Some("if xs.is_empty() { return None; }".into());
        let c = ReviewComment::new("ws".into(), "README.md".into(), 1, CommentSide::New, "  Typo in title ".into());

        let msg = format_review_comments(Some("Please address these review comments:"), &[a, b, c]);
        assert_eq!(
            msg,
            "Please address these review comments:\n\
             \n\
             1. `src/app.ts:12`\n   > const n = items.length;\n   Rename this to `count`.\n\
             \n\
             2. `src/old.rs:40` (removed line)\n   > if xs.is_empty() { return None; }\n   Why was this removed?\n   It handled the empty case.\n\
             \n\
             3. `README.md:1`\n   Typo in title"
        );
        // Message only (request changes with no comments).
        assert_eq!(format_review_comments(Some("  Use the new API. "), &[]), "Use the new API.");
    }
}
