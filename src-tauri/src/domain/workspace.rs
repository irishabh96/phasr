use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::{Agent, PermissionMode};

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

/// How a task ended. `None` on the row = still open.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskOutcome {
    /// Its branch was merged (`merged_into` says where).
    Merged,
    /// Closed without merging (discarded; notes kept).
    Closed,
}

impl TaskOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Closed => "closed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "merged" => Self::Merged,
            "closed" => Self::Closed,
            _ => return None,
        })
    }
}

/// How a task's agent is shown and run on this machine: Phasr's own
/// transcript over Claude's headless stream mode, or the agent's TUI in a
/// PTY. Local-only (`workspaces.agent_view`, never synced); `None` on the
/// row means terminal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentView {
    Transcript,
    Terminal,
}

impl AgentView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::Terminal => "terminal",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "transcript" => Self::Transcript,
            "terminal" => Self::Terminal,
            _ => return None,
        })
    }

    /// The view a new task with `agent` starts in. Phase 1: only Claude has
    /// a headless stream mode.
    pub fn default_for(agent: Agent) -> Option<Self> {
        (agent == Agent::Claude).then_some(Self::Transcript)
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
    /// The mode the agent was (or will next be) launched in. `None` on rows
    /// that predate permission modes: those launched with skip-all flags,
    /// which are baked into `command`, so they keep behaving that way on
    /// resume.
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// Whether this task should raise a notification when it needs the
    /// user (M6 consumes it).
    #[serde(default = "default_true")]
    pub notify_on_attention: bool,
    /// When the agent last finished a turn (its `Stop` hook / Codex
    /// turn-complete notify). Synced, so "finished 18m ago" shows on every
    /// device. `None` = never, or a row from before M6.
    #[serde(default)]
    pub last_turn_ended_at: Option<DateTime<Utc>>,
    /// The branch the worktree was cut from — the diff base. `None` on rows
    /// from before M7 (the repository's default branch is assumed) and on
    /// in-place tasks.
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Set while a not-yet-launched task waits in the queue.
    #[serde(default)]
    pub queued_at: Option<DateTime<Utc>>,
    /// The queued task starts once this one reaches review / is done.
    #[serde(default)]
    pub depends_on_workspace_id: Option<String>,
    #[serde(default)]
    pub outcome: Option<TaskOutcome>,
    #[serde(default)]
    pub outcome_at: Option<DateTime<Utc>>,
    /// Where a `Merged` task's branch went.
    #[serde(default)]
    pub merged_into: Option<String>,
    #[serde(default)]
    pub pr_number: Option<i64>,
    #[serde(default)]
    pub pr_url: Option<String>,
    /// `open` | `draft` | `merged` | `closed`, as last seen. Open set.
    #[serde(default)]
    pub pr_state: Option<String>,
    /// Transcript or terminal, on THIS machine. `None` = terminal (rows from
    /// before the transcript view, synced rows, non-Claude agents).
    #[serde(default)]
    pub agent_view: Option<AgentView>,
}

impl Workspace {
    /// Whether this task's agent runs headless with Phasr's transcript
    /// (Claude only, and only when its view says so).
    pub fn in_transcript_view(&self) -> bool {
        self.agent == Some(Agent::Claude) && self.agent_view == Some(AgentView::Transcript)
    }
}

fn default_true() -> bool {
    true
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
            permission_mode: None,
            notify_on_attention: true,
            last_turn_ended_at: None,
            base_branch: None,
            queued_at: None,
            depends_on_workspace_id: None,
            outcome: None,
            outcome_at: None,
            merged_into: None,
            pr_number: None,
            pr_url: None,
            pr_state: None,
            agent_view: None,
        }
    }

    /// An agent task that was created but never launched: `pending`, and
    /// no worktree branch yet. Covers drafts AND queued tasks. (A launch
    /// cuts the branch before the row leaves `pending`, so a mid-launch
    /// row is never mistaken for one.) Uses `branch`, not `worktree_path`,
    /// because the branch syncs and the path is machine-local.
    pub fn is_unlaunched(&self) -> bool {
        self.workspace_kind == WorkspaceKind::Agent
            && self.status == WorkspaceStatus::Pending
            && self.branch.is_none()
    }

    /// Waiting in the queue to be started (by the scheduler or "Start now").
    pub fn is_queued(&self) -> bool {
        self.is_unlaunched() && self.queued_at.is_some()
    }

    /// Saved for later; starts only when the user starts or queues it.
    pub fn is_draft(&self) -> bool {
        self.is_unlaunched() && self.queued_at.is_none()
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
    fn drafts_and_queued_tasks_are_unlaunched_pending_rows() {
        let mut ws = Workspace::new("r".into(), "n".into(), "claude".into());
        assert!(ws.is_draft() && !ws.is_queued());
        ws.queued_at = Some(Utc::now());
        assert!(ws.is_queued() && !ws.is_draft());
        // Launched (branch cut) → neither, even while still pending.
        ws.branch = Some("phasr/n".into());
        assert!(!ws.is_unlaunched());
        ws.branch = None;
        ws.status = WorkspaceStatus::Running;
        assert!(!ws.is_unlaunched());
        let mut local = Workspace::new("r".into(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        assert!(!local.is_draft());
        assert_eq!(TaskOutcome::from_str("merged"), Some(TaskOutcome::Merged));
        assert_eq!(TaskOutcome::Closed.as_str(), "closed");
        assert_eq!(TaskOutcome::from_str("nope"), None);
    }

    #[test]
    fn agent_view_round_trips_and_only_claude_defaults_to_transcript() {
        for view in [AgentView::Transcript, AgentView::Terminal] {
            assert_eq!(AgentView::from_str(view.as_str()), Some(view));
            assert_eq!(serde_json::to_value(view).unwrap(), view.as_str());
        }
        assert_eq!(AgentView::from_str("tui"), None);
        assert_eq!(AgentView::default_for(Agent::Claude), Some(AgentView::Transcript));
        assert_eq!(AgentView::default_for(Agent::Codex), None);

        let mut ws = Workspace::new("r".into(), "n".into(), "claude".into());
        assert!(serde_json::to_value(&ws).unwrap()["agentView"].is_null());
        ws.agent = Some(Agent::Claude);
        assert!(!ws.in_transcript_view(), "null means terminal");
        ws.agent_view = Some(AgentView::Transcript);
        assert!(ws.in_transcript_view());
        assert_eq!(serde_json::to_value(&ws).unwrap()["agentView"], "transcript");
        ws.agent = Some(Agent::Codex);
        assert!(!ws.in_transcript_view(), "Claude only");
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
