//! Per-task agent state and its transitions.
//!
//! `TaskSignalState` is plain data; every transition is a method that takes
//! `now` and returns what changed plus the side effects the caller must run
//! (persist a session id, stamp a turn end). No I/O happens here, which is
//! what makes the hook → state mapping unit-testable.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::domain::Agent;

use super::heuristics::Detection;
use super::signal::{AgentSignal, SessionInfo};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStateKind {
    Working,
    Idle,
    NeedsYou,
    Exited,
}

impl From<AgentStateKind> for crate::domain::board::AgentPhase {
    fn from(kind: AgentStateKind) -> Self {
        match kind {
            AgentStateKind::Working => Self::Working,
            AgentStateKind::Idle => Self::Idle,
            AgentStateKind::NeedsYou => Self::NeedsYou,
            AgentStateKind::Exited => Self::Exited,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttentionKind {
    Shell,
    Edit,
    Tool,
    Question,
    Input,
    /// The agent's workspace-trust dialog ("Do you trust this folder?").
    /// Answering it gates the initial prompt (see `AgentSignals::prompt_gate`).
    Trust,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttentionSource {
    Hook,
    Heuristic,
}

/// Answer keys read off the dialog itself, overriding the agent's static
/// table (`Agent::approval_keys`) — Codex labels each option with its
/// hotkey, and the "don't ask again" hotkey differs between its variants.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeyOverrides {
    pub allow_once: Option<String>,
    pub allow_task: Option<String>,
    pub deny: Option<String>,
}

/// What the agent is waiting on. `id` is minted per dialog so a click on a
/// card for an old dialog can't answer a newer one (`claim_attention`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub id: String,
    pub kind: AttentionKind,
    pub title: String,
    pub detail: Option<String>,
    pub since: DateTime<Utc>,
    pub source: AttentionSource,
    /// Whether phasr knows the keystrokes that answer this dialog. False →
    /// the UI offers "Open terminal" instead of Allow/Deny.
    pub can_respond: bool,
    #[serde(skip)]
    pub keys: KeyOverrides,
}

/// The wire shape of `list_agent_states` and `phasr://task-agent-state`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentState {
    pub task_id: String,
    pub repository_id: String,
    pub state: AgentStateKind,
    pub attention: Option<Attention>,
    pub last_activity: Option<String>,
    pub last_turn_ended_at: Option<DateTime<Utc>>,
}

/// In-app answer to an approval dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionResponse {
    AllowOnce,
    AllowTask,
    Deny,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Persist the agent's session id (local-only column) for resume.
    PersistSession(String),
    /// Persist + sync `last_turn_ended_at`.
    TurnEnded(DateTime<Utc>),
    /// Transcripts may have grown; re-read usage (throttled).
    UsageDirty,
}

#[derive(Debug, Clone, PartialEq)]
struct ToolCall {
    name: String,
    input: Value,
}

#[derive(Debug, Clone)]
pub struct TaskSignalState {
    pub task_id: String,
    pub repository_id: String,
    pub agent: Agent,
    /// The task's cwd, for turning absolute tool paths into short ones.
    pub cwd: String,
    pub kind: AgentStateKind,
    pub attention: Option<Attention>,
    /// The tool call the current hook attention is about. A PreToolUse for
    /// the SAME call (hook files can land out of order) must not clear it.
    attention_tool: Option<ToolCall>,
    pub state_since: DateTime<Utc>,
    pub last_activity: Option<String>,
    pub last_turn_ended_at: Option<DateTime<Utc>>,
    pending_tool: Option<ToolCall>,
    /// Hooks have reported for the current agent session. For Claude this
    /// switches heuristics off (hooks win); Codex hooks only report turn
    /// ends, so its approvals always come from heuristics.
    pub hooks_seen: bool,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    /// Last assistant message from a Stop / turn-complete hook.
    pub last_message: Option<(String, DateTime<Utc>)>,
}

/// Why a respond request was refused. Either way, no keys are sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimError {
    Stale,
    NotRespondable,
}

impl TaskSignalState {
    pub fn new(
        task_id: String,
        repository_id: String,
        agent: Agent,
        cwd: String,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            task_id,
            repository_id,
            agent,
            cwd,
            // A just-spawned agent is booting / working on its prompt.
            kind: AgentStateKind::Working,
            attention: None,
            attention_tool: None,
            state_since: now,
            last_activity: None,
            last_turn_ended_at: None,
            pending_tool: None,
            hooks_seen: false,
            session_id: None,
            transcript_path: None,
            last_message: None,
        }
    }

    pub fn to_wire(&self) -> TaskAgentState {
        TaskAgentState {
            task_id: self.task_id.clone(),
            repository_id: self.repository_id.clone(),
            state: self.kind,
            attention: self.attention.clone(),
            last_activity: self.last_activity.clone(),
            last_turn_ended_at: self.last_turn_ended_at,
        }
    }

    fn set_kind(&mut self, kind: AgentStateKind, now: DateTime<Utc>) {
        if self.kind != kind {
            self.kind = kind;
            self.state_since = now;
        }
        if kind != AgentStateKind::NeedsYou {
            self.attention = None;
            self.attention_tool = None;
        }
    }

    fn raise(&mut self, attention: Attention, tool: Option<ToolCall>, now: DateTime<Utc>) {
        self.kind = AgentStateKind::NeedsYou;
        self.state_since = now;
        self.attention = Some(attention);
        self.attention_tool = tool;
    }

    fn has_hook_attention(&self) -> bool {
        self.attention
            .as_ref()
            .is_some_and(|a| a.source == AttentionSource::Hook)
    }

    /// Apply one hook event. Returns the effects to run; compare `to_wire()`
    /// before/after to know whether to broadcast.
    pub fn apply_hook(
        &mut self,
        signal: &AgentSignal,
        session: &SessionInfo,
        now: DateTime<Utc>,
    ) -> Vec<Effect> {
        let mut effects = vec![Effect::UsageDirty];
        if !matches!(signal, AgentSignal::CodexTurnComplete { .. }) {
            self.hooks_seen = true;
        }
        if let Some(id) = session.session_id.as_deref() {
            if self.session_id.as_deref() != Some(id) {
                self.session_id = Some(id.to_string());
                effects.push(Effect::PersistSession(id.to_string()));
            }
        }
        if let Some(path) = session.transcript_path.as_deref() {
            self.transcript_path = Some(path.to_string());
        }

        match signal {
            AgentSignal::SessionStart { .. } => {
                // A fresh/resumed/cleared session sits at its prompt until the
                // first UserPromptSubmit (phasr types the initial prompt right
                // after boot, which flips it to Working).
                self.pending_tool = None;
                self.set_kind(AgentStateKind::Idle, now);
            }
            AgentSignal::UserPromptSubmit { .. } => {
                self.pending_tool = None;
                self.set_kind(AgentStateKind::Working, now);
                self.last_activity = Some("Thinking".into());
            }
            AgentSignal::PreToolUse {
                tool_name,
                tool_input,
            } => {
                let call = ToolCall {
                    name: tool_name.clone(),
                    input: tool_input.clone(),
                };
                if tool_name == "AskUserQuestion" {
                    self.raise(question_attention(tool_input, now), Some(call.clone()), now);
                } else if self.has_hook_attention() && self.attention_tool.as_ref() == Some(&call) {
                    // Its own PermissionRequest got here first: keep the card.
                } else {
                    self.set_kind(AgentStateKind::Working, now);
                }
                self.last_activity = Some(activity_line(tool_name, tool_input, &self.cwd));
                self.pending_tool = Some(call);
            }
            AgentSignal::PermissionRequest {
                tool_name,
                tool_input,
            } => {
                let call = ToolCall {
                    name: tool_name.clone(),
                    input: tool_input.clone(),
                };
                if !(self.has_hook_attention() && self.attention_tool.as_ref() == Some(&call)) {
                    let attention = tool_attention(self.agent, tool_name, tool_input, &self.cwd, now);
                    self.raise(attention, Some(call), now);
                }
            }
            AgentSignal::Notification {
                notification_type,
                message,
            } => self.apply_notification(notification_type.as_deref(), message, now),
            AgentSignal::PostToolUse { .. } => {
                self.pending_tool = None;
                if self.kind == AgentStateKind::NeedsYou || self.kind == AgentStateKind::Idle {
                    self.set_kind(AgentStateKind::Working, now);
                }
            }
            AgentSignal::PermissionDenied { .. } => {
                // Denied in the terminal (or by Claude's classifier): Claude
                // either waits for the user or carries on, in which case the
                // next PreToolUse flips it back to Working.
                self.pending_tool = None;
                if self.kind == AgentStateKind::NeedsYou {
                    self.set_kind(AgentStateKind::Idle, now);
                }
            }
            AgentSignal::Stop {
                last_assistant_message,
            }
            | AgentSignal::CodexTurnComplete {
                last_assistant_message,
            } => {
                self.pending_tool = None;
                self.set_kind(AgentStateKind::Idle, now);
                self.last_activity = None;
                self.last_turn_ended_at = Some(now);
                if let Some(text) = last_assistant_message {
                    self.last_message = Some((text.clone(), now));
                }
                effects.push(Effect::TurnEnded(now));
            }
            AgentSignal::SessionEnd { reason } => {
                // `/clear` ends one session and starts another in place.
                if reason.as_deref() != Some("clear") {
                    self.pending_tool = None;
                    self.hooks_seen = false;
                    self.set_kind(AgentStateKind::Exited, now);
                    self.last_activity = None;
                }
            }
        }
        effects
    }

    fn apply_notification(&mut self, kind: Option<&str>, message: &str, now: DateTime<Utc>) {
        // `notification_type` is the reliable discriminator (2.1.x); older
        // builds only had the message text, so fall back to it.
        let lower = message.to_ascii_lowercase();
        let kind = kind.unwrap_or(if lower.contains("permission") {
            "permission_prompt"
        } else if lower.contains("waiting for your input") {
            "idle_prompt"
        } else {
            ""
        });
        match kind {
            "permission_prompt" => {
                if self.has_hook_attention() {
                    // Already raised by PermissionRequest — keep its id.
                    return;
                }
                let attention = match self.pending_tool.clone() {
                    Some(call) => {
                        let a = tool_attention(self.agent, &call.name, &call.input, &self.cwd, now);
                        (a, Some(call))
                    }
                    None => (
                        Attention {
                            id: new_id(),
                            kind: AttentionKind::Tool,
                            title: if message.is_empty() {
                                "Approve a tool call".into()
                            } else {
                                message.to_string()
                            },
                            detail: None,
                            since: now,
                            source: AttentionSource::Hook,
                            can_respond: self.agent.approval_keys().is_some(),
                            keys: KeyOverrides::default(),
                        },
                        None,
                    ),
                };
                self.raise(attention.0, attention.1, now);
            }
            "idle_prompt" => {
                if self.kind == AgentStateKind::Working {
                    self.set_kind(AgentStateKind::Idle, now);
                }
            }
            "elicitation_dialog" => {
                if !self.has_hook_attention() {
                    let attention = Attention {
                        id: new_id(),
                        kind: AttentionKind::Input,
                        title: if message.is_empty() {
                            "Waiting for input".into()
                        } else {
                            message.to_string()
                        },
                        detail: None,
                        since: now,
                        source: AttentionSource::Hook,
                        can_respond: false,
                        keys: KeyOverrides::default(),
                    };
                    self.raise(attention, None, now);
                }
            }
            _ => {}
        }
    }

    /// Heuristic result after an output-quiet period. `None` = no dialog
    /// recognised at the end of the output.
    pub fn apply_heuristic(&mut self, detection: Option<Detection>, now: DateTime<Utc>) {
        // Hooks win: once a Claude session reports through hooks, PTY
        // pattern-matching would only add false positives. The trust
        // dialog is the exception: it is drawn before any hook can fire,
        // and the initial prompt is held until it is answered.
        let is_trust = detection
            .as_ref()
            .is_some_and(|d| d.kind == AttentionKind::Trust);
        if self.agent == Agent::Claude && self.hooks_seen && !is_trust {
            return;
        }
        if matches!(self.kind, AgentStateKind::Exited) {
            return;
        }
        let current_is_heuristic = self
            .attention
            .as_ref()
            .is_some_and(|a| a.source == AttentionSource::Heuristic);
        match detection {
            Some(found) => {
                let same = self.attention.as_ref().is_some_and(|a| {
                    a.source == AttentionSource::Heuristic
                        && a.kind == found.kind
                        && a.title == found.title
                });
                if same || self.has_hook_attention() {
                    return;
                }
                self.raise(
                    Attention {
                        id: new_id(),
                        kind: found.kind,
                        title: found.title,
                        // The trust dialog's subject is the task's own
                        // folder; the cwd is exact where the screen wraps.
                        detail: found.detail.or_else(|| {
                            (found.kind == AttentionKind::Trust).then(|| self.cwd.clone())
                        }),
                        since: now,
                        source: AttentionSource::Heuristic,
                        can_respond: found.can_respond && self.agent.approval_keys().is_some(),
                        keys: found.keys,
                    },
                    None,
                    now,
                );
            }
            None if current_is_heuristic => {
                // The dialog is no longer what the output ends with.
                self.set_kind(AgentStateKind::Working, now);
            }
            None => {}
        }
    }

    /// The user typed into the terminal / sent a composer message.
    ///
    /// A heuristic card can't know whether that answered the dialog, so it's
    /// cleared; if the dialog is still up, the next quiet period re-raises it
    /// (with a new id). Hook attention is left for the hooks to resolve —
    /// except a lone Esc / Ctrl-C: denying in the terminal fires NO hook
    /// (verified on Claude 2.1.319: no PermissionDenied, no Stop), so without
    /// this the card would stay up until the next prompt.
    /// Returns whether anything changed.
    pub fn on_user_input(&mut self, bytes: &[u8], now: DateTime<Utc>) -> bool {
        match self.attention.as_ref().map(|a| a.source) {
            Some(AttentionSource::Heuristic) => {
                self.set_kind(AgentStateKind::Working, now);
                true
            }
            Some(AttentionSource::Hook) if bytes == b"\x1b" || bytes == b"\x03" => {
                self.pending_tool = None;
                self.set_kind(AgentStateKind::Idle, now);
                true
            }
            _ => false,
        }
    }

    pub fn on_exit(&mut self, now: DateTime<Utc>) {
        self.pending_tool = None;
        self.hooks_seen = false;
        self.last_activity = None;
        self.set_kind(AgentStateKind::Exited, now);
    }

    /// Validate an in-app answer and consume the attention, atomically, so a
    /// double click sends keys at most once. On `Err` nothing changes and the
    /// caller must not write anything to the PTY.
    pub fn claim_attention(
        &mut self,
        attention_id: &str,
        response: AttentionResponse,
        now: DateTime<Utc>,
    ) -> Result<Attention, ClaimError> {
        let current = match self.attention.as_ref() {
            Some(a) if a.id == attention_id && self.kind == AgentStateKind::NeedsYou => a.clone(),
            _ => return Err(ClaimError::Stale),
        };
        if !current.can_respond {
            return Err(ClaimError::NotRespondable);
        }
        // Allowed → the tool runs; denied → the agent stops and waits.
        let next = match response {
            AttentionResponse::AllowOnce | AttentionResponse::AllowTask => AgentStateKind::Working,
            AttentionResponse::Deny => AgentStateKind::Idle,
        };
        self.pending_tool = None;
        self.set_kind(next, now);
        Ok(current)
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn str_input<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `/work/tree/src/x.ts` → `src/x.ts` when inside `cwd`.
pub fn short_path(path: &str, cwd: &str) -> String {
    if !cwd.is_empty() {
        if let Ok(rel) = Path::new(path).strip_prefix(cwd) {
            let rel = rel.to_string_lossy();
            if !rel.is_empty() {
                return rel.into_owned();
            }
        }
    }
    path.to_string()
}

/// First line, at most `max` chars, with an ellipsis when cut.
fn clip(text: &str, max: usize) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    let multi = text.trim().lines().count() > 1;
    if first.chars().count() > max {
        let cut: String = first.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    } else if multi {
        format!("{first} …")
    } else {
        first.to_string()
    }
}

fn file_path_of(input: &Value) -> Option<&str> {
    str_input(input, "file_path")
        .or_else(|| str_input(input, "notebook_path"))
        .or_else(|| str_input(input, "path"))
}

/// The running-card activity line for a tool call.
pub fn activity_line(tool: &str, input: &Value, cwd: &str) -> String {
    let path = || file_path_of(input).map(|p| short_path(p, cwd));
    match tool {
        "Bash" => match str_input(input, "command") {
            Some(cmd) => format!("Running {}", clip(cmd, 80)),
            None => "Running a command".into(),
        },
        "Edit" | "MultiEdit" | "NotebookEdit" => match path() {
            Some(p) => format!("Editing {p}"),
            None => "Editing a file".into(),
        },
        "Write" => match path() {
            Some(p) => format!("Writing {p}"),
            None => "Writing a file".into(),
        },
        "Read" => match path() {
            Some(p) => format!("Reading {p}"),
            None => "Reading a file".into(),
        },
        "Glob" | "Grep" => match str_input(input, "pattern") {
            Some(p) => format!("Searching {}", clip(p, 60)),
            None => "Searching".into(),
        },
        "WebFetch" => match str_input(input, "url") {
            Some(u) => format!("Fetching {}", clip(u, 80)),
            None => "Fetching a page".into(),
        },
        "WebSearch" => "Searching the web".into(),
        "Task" | "Agent" => "Running a subagent".into(),
        "TodoWrite" => "Updating the plan".into(),
        other => match other.strip_prefix("mcp__") {
            Some(rest) => format!("Using {}", rest.replace("__", " ")),
            None => format!("Using {other}"),
        },
    }
}

/// The approval card for a tool Claude wants permission to run.
pub fn tool_attention(
    agent: Agent,
    tool: &str,
    input: &Value,
    cwd: &str,
    now: DateTime<Utc>,
) -> Attention {
    let has_keys = agent.approval_keys().is_some();
    let (kind, title, detail, can_respond) = match tool {
        "Bash" => (
            AttentionKind::Shell,
            "Run a shell command".to_string(),
            str_input(input, "command").map(str::to_string),
            has_keys,
        ),
        "Edit" | "MultiEdit" | "NotebookEdit" | "Write" => {
            let path = file_path_of(input).map(|p| short_path(p, cwd));
            let verb = if tool == "Write" { "Write" } else { "Edit" };
            (
                AttentionKind::Edit,
                match &path {
                    Some(p) => format!("{verb} {p}"),
                    None => format!("{verb} a file"),
                },
                path,
                has_keys,
            )
        }
        // Plan approval's options are "auto-accept edits / manually approve /
        // keep planning" — "1" would grant more than "allow once", so it
        // isn't answerable from a generic Allow/Deny card.
        "ExitPlanMode" => (
            AttentionKind::Question,
            "Approve the plan".to_string(),
            str_input(input, "plan").map(|p| clip(p, 200)),
            false,
        ),
        "WebFetch" => (
            AttentionKind::Tool,
            "Fetch a web page".to_string(),
            str_input(input, "url").map(str::to_string),
            has_keys,
        ),
        other => (
            AttentionKind::Tool,
            format!("Use {}", other.strip_prefix("mcp__").unwrap_or(other).replace("__", " ")),
            compact_json(input),
            has_keys,
        ),
    };
    Attention {
        id: new_id(),
        kind,
        title,
        detail,
        since: now,
        source: AttentionSource::Hook,
        can_respond,
        keys: KeyOverrides::default(),
    }
}

fn question_attention(input: &Value, now: DateTime<Utc>) -> Attention {
    let first = input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|qs| qs.first());
    let title = first
        .and_then(|q| str_input(q, "question"))
        .map(|q| clip(q, 160))
        .unwrap_or_else(|| "The agent has a question".into());
    let detail = first
        .and_then(|q| q.get("options"))
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| str_input(o, "label"))
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .filter(|s| !s.is_empty());
    Attention {
        id: new_id(),
        kind: AttentionKind::Question,
        title,
        detail,
        since: now,
        source: AttentionSource::Hook,
        // Answering means picking options in the agent's own UI.
        can_respond: false,
        keys: KeyOverrides::default(),
    }
}

fn compact_json(input: &Value) -> Option<String> {
    if input.is_null() || input.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    let s = input.to_string();
    Some(if s.chars().count() > 200 {
        format!("{}…", s.chars().take(199).collect::<String>())
    } else {
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(agent: Agent) -> TaskSignalState {
        TaskSignalState::new("t".into(), "r".into(), agent, "/work".into(), Utc::now())
    }

    fn no_session() -> SessionInfo {
        SessionInfo::default()
    }

    fn pre(tool: &str, input: Value) -> AgentSignal {
        AgentSignal::PreToolUse {
            tool_name: tool.into(),
            tool_input: input,
        }
    }

    fn permission_notification() -> AgentSignal {
        AgentSignal::Notification {
            notification_type: Some("permission_prompt".into()),
            message: "Claude needs your permission to use Bash".into(),
        }
    }

    #[test]
    fn pre_tool_use_then_permission_notification_needs_you_with_command() {
        let mut s = state(Agent::Claude);
        let now = Utc::now();
        s.apply_hook(&pre("Bash", json!({"command": "pnpm test"})), &no_session(), now);
        assert_eq!(s.kind, AgentStateKind::Working);
        assert_eq!(s.last_activity.as_deref(), Some("Running pnpm test"));

        s.apply_hook(&permission_notification(), &no_session(), now);
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
        let a = s.attention.clone().unwrap();
        assert_eq!(a.kind, AttentionKind::Shell);
        assert_eq!(a.detail.as_deref(), Some("pnpm test"));
        assert_eq!(a.source, AttentionSource::Hook);
        assert!(a.can_respond);

        // PostToolUse = the dialog was answered and the tool ran.
        s.apply_hook(
            &AgentSignal::PostToolUse {
                tool_name: "Bash".into(),
            },
            &no_session(),
            now,
        );
        assert_eq!(s.kind, AgentStateKind::Working);
        assert!(s.attention.is_none());
    }

    #[test]
    fn edit_permission_names_the_file_relative_to_the_worktree() {
        let mut s = state(Agent::Claude);
        let now = Utc::now();
        s.apply_hook(
            &AgentSignal::PermissionRequest {
                tool_name: "Edit".into(),
                tool_input: json!({"file_path": "/work/src/x.ts", "old_string": "a"}),
            },
            &no_session(),
            now,
        );
        let a = s.attention.clone().unwrap();
        assert_eq!(a.kind, AttentionKind::Edit);
        assert_eq!(a.title, "Edit src/x.ts");
        assert_eq!(a.detail.as_deref(), Some("src/x.ts"));
    }

    #[test]
    fn permission_request_keeps_its_id_through_late_pre_tool_use_and_notification() {
        let mut s = state(Agent::Claude);
        let now = Utc::now();
        let input = json!({"command": "rm -rf build"});
        s.apply_hook(
            &AgentSignal::PermissionRequest {
                tool_name: "Bash".into(),
                tool_input: input.clone(),
            },
            &no_session(),
            now,
        );
        let id = s.attention.as_ref().unwrap().id.clone();
        // Same call's PreToolUse file sorted after it: card survives.
        s.apply_hook(&pre("Bash", input), &no_session(), now);
        assert_eq!(s.attention.as_ref().unwrap().id, id);
        // The delayed (6s) permission_prompt notification doesn't re-mint.
        s.apply_hook(&permission_notification(), &no_session(), now);
        assert_eq!(s.attention.as_ref().unwrap().id, id);
        // A different tool starting means the dialog was answered.
        s.apply_hook(&pre("Read", json!({"file_path": "/work/a"})), &no_session(), now);
        assert_eq!(s.kind, AgentStateKind::Working);
    }

    #[test]
    fn ask_user_question_needs_you_as_a_question() {
        let mut s = state(Agent::Claude);
        s.apply_hook(
            &pre(
                "AskUserQuestion",
                json!({"questions": [{"question": "Which DB?", "header": "DB",
                    "options": [{"label": "Postgres"}, {"label": "SQLite"}], "multiSelect": false}]}),
            ),
            &no_session(),
            Utc::now(),
        );
        let a = s.attention.clone().unwrap();
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
        assert_eq!(a.kind, AttentionKind::Question);
        assert_eq!(a.title, "Which DB?");
        assert_eq!(a.detail.as_deref(), Some("Postgres · SQLite"));
        assert!(!a.can_respond);
    }

    #[test]
    fn stop_goes_idle_and_stamps_turn_end() {
        let mut s = state(Agent::Claude);
        let now = Utc::now();
        let effects = s.apply_hook(
            &AgentSignal::Stop {
                last_assistant_message: Some("Done.".into()),
            },
            &no_session(),
            now,
        );
        assert_eq!(s.kind, AgentStateKind::Idle);
        assert_eq!(s.last_turn_ended_at, Some(now));
        assert!(effects.contains(&Effect::TurnEnded(now)));
        assert_eq!(s.last_message.as_ref().unwrap().0, "Done.");
    }

    #[test]
    fn session_start_records_session_once() {
        let mut s = state(Agent::Claude);
        let session = SessionInfo {
            session_id: Some("sess-1".into()),
            transcript_path: Some("/t.jsonl".into()),
        };
        let signal = AgentSignal::SessionStart {
            session_id: Some("sess-1".into()),
            transcript_path: Some("/t.jsonl".into()),
            source: Some("startup".into()),
        };
        let effects = s.apply_hook(&signal, &session, Utc::now());
        assert!(effects.contains(&Effect::PersistSession("sess-1".into())));
        assert_eq!(s.kind, AgentStateKind::Idle);
        assert_eq!(s.transcript_path.as_deref(), Some("/t.jsonl"));
        // Same id on later events → no re-persist.
        let effects = s.apply_hook(
            &AgentSignal::UserPromptSubmit {
                session_id: Some("sess-1".into()),
            },
            &session,
            Utc::now(),
        );
        assert!(!effects.iter().any(|e| matches!(e, Effect::PersistSession(_))));
        assert_eq!(s.kind, AgentStateKind::Working);
    }

    #[test]
    fn session_end_exits_except_on_clear() {
        let mut s = state(Agent::Claude);
        s.apply_hook(
            &AgentSignal::SessionEnd {
                reason: Some("clear".into()),
            },
            &no_session(),
            Utc::now(),
        );
        assert_ne!(s.kind, AgentStateKind::Exited);
        s.apply_hook(
            &AgentSignal::SessionEnd {
                reason: Some("prompt_input_exit".into()),
            },
            &no_session(),
            Utc::now(),
        );
        assert_eq!(s.kind, AgentStateKind::Exited);
        assert!(!s.hooks_seen);
    }

    fn detection(title: &str) -> Detection {
        Detection {
            kind: AttentionKind::Shell,
            title: title.into(),
            detail: None,
            can_respond: true,
            keys: KeyOverrides::default(),
        }
    }

    #[test]
    fn heuristics_are_ignored_once_claude_hooks_report() {
        let mut s = state(Agent::Claude);
        s.apply_heuristic(Some(detection("Run a shell command")), Utc::now());
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
        assert_eq!(
            s.attention.as_ref().unwrap().source,
            AttentionSource::Heuristic
        );

        let mut s = state(Agent::Claude);
        s.apply_hook(&pre("Read", json!({})), &no_session(), Utc::now());
        s.apply_heuristic(Some(detection("Run a shell command")), Utc::now());
        assert_eq!(s.kind, AgentStateKind::Working);
    }

    #[test]
    fn codex_heuristics_stay_on_after_its_turn_hook() {
        let mut s = state(Agent::Codex);
        s.apply_hook(
            &AgentSignal::CodexTurnComplete {
                last_assistant_message: None,
            },
            &no_session(),
            Utc::now(),
        );
        assert!(!s.hooks_seen);
        s.apply_heuristic(Some(detection("Run a shell command")), Utc::now());
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
    }

    #[test]
    fn heuristic_attention_is_stable_then_cleared_by_input_or_disappearance() {
        let mut s = state(Agent::Codex);
        let now = Utc::now();
        s.apply_heuristic(Some(detection("Run a shell command")), now);
        let id = s.attention.as_ref().unwrap().id.clone();
        // Same dialog still at the end of output: same id.
        s.apply_heuristic(Some(detection("Run a shell command")), now);
        assert_eq!(s.attention.as_ref().unwrap().id, id);
        // User typed → cleared.
        assert!(s.on_user_input(b"y", now));
        assert_eq!(s.kind, AgentStateKind::Working);
        // Re-raised → new id; then gone from the output → cleared.
        s.apply_heuristic(Some(detection("Run a shell command")), now);
        assert_ne!(s.attention.as_ref().unwrap().id, id);
        s.apply_heuristic(None, now);
        assert_eq!(s.kind, AgentStateKind::Working);
        // Typing doesn't clear hook attention (the hooks will)…
        let mut c = state(Agent::Claude);
        c.apply_hook(&permission_notification(), &no_session(), now);
        assert!(!c.on_user_input(b"\x1b[B", now));
        assert!(!c.on_user_input(b"1", now));
        assert_eq!(c.kind, AgentStateKind::NeedsYou);
        // …except Esc, a terminal deny that no hook reports.
        assert!(c.on_user_input(b"\x1b", now));
        assert_eq!(c.kind, AgentStateKind::Idle);
        assert!(c.attention.is_none());
    }

    #[test]
    fn claim_rejects_stale_and_unanswerable_without_changing_state() {
        let mut s = state(Agent::Claude);
        let now = Utc::now();
        s.apply_hook(&pre("Bash", json!({"command": "ls"})), &no_session(), now);
        s.apply_hook(&permission_notification(), &no_session(), now);
        let id = s.attention.as_ref().unwrap().id.clone();

        assert_eq!(
            s.claim_attention("old-id", AttentionResponse::AllowOnce, now),
            Err(ClaimError::Stale)
        );
        assert_eq!(s.kind, AgentStateKind::NeedsYou);

        let claimed = s.claim_attention(&id, AttentionResponse::AllowOnce, now).unwrap();
        assert_eq!(claimed.id, id);
        assert_eq!(s.kind, AgentStateKind::Working);
        // Second click on the same card: already consumed.
        assert_eq!(
            s.claim_attention(&id, AttentionResponse::AllowOnce, now),
            Err(ClaimError::Stale)
        );

        // Deny → idle.
        s.apply_hook(&permission_notification(), &no_session(), now);
        let id = s.attention.as_ref().unwrap().id.clone();
        s.claim_attention(&id, AttentionResponse::Deny, now).unwrap();
        assert_eq!(s.kind, AgentStateKind::Idle);

        // A question can't be answered with approval keys.
        s.apply_hook(
            &pre("AskUserQuestion", json!({"questions": []})),
            &no_session(),
            now,
        );
        let id = s.attention.as_ref().unwrap().id.clone();
        assert_eq!(
            s.claim_attention(&id, AttentionResponse::AllowOnce, now),
            Err(ClaimError::NotRespondable)
        );
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
    }

    #[test]
    fn notification_falls_back_to_message_text_without_a_type() {
        let mut s = state(Agent::Claude);
        s.apply_hook(
            &AgentSignal::Notification {
                notification_type: None,
                message: "Claude needs your permission to use WebFetch".into(),
            },
            &no_session(),
            Utc::now(),
        );
        assert_eq!(s.kind, AgentStateKind::NeedsYou);
        let mut s = state(Agent::Claude);
        s.apply_hook(
            &AgentSignal::Notification {
                notification_type: None,
                message: "Claude is waiting for your input".into(),
            },
            &no_session(),
            Utc::now(),
        );
        assert_eq!(s.kind, AgentStateKind::Idle);
    }

    #[test]
    fn plan_approval_is_not_answerable_with_allow_keys() {
        let a = tool_attention(
            Agent::Claude,
            "ExitPlanMode",
            &json!({"plan": "1. do it"}),
            "/work",
            Utc::now(),
        );
        assert_eq!(a.kind, AttentionKind::Question);
        assert!(!a.can_respond);
    }

    #[test]
    fn activity_lines() {
        assert_eq!(
            activity_line("Edit", &json!({"file_path": "/work/src/x.ts"}), "/work"),
            "Editing src/x.ts"
        );
        assert_eq!(
            activity_line("Bash", &json!({"command": "pnpm test\n--watch"}), "/work"),
            "Running pnpm test …"
        );
        assert_eq!(
            activity_line("mcp__github__create_pr", &json!({}), "/work"),
            "Using github create_pr"
        );
    }

    #[test]
    fn wire_shape_is_camel_case_with_kebab_states() {
        let mut s = state(Agent::Claude);
        s.apply_hook(&permission_notification(), &no_session(), Utc::now());
        let v = serde_json::to_value(s.to_wire()).unwrap();
        assert_eq!(v["taskId"], "t");
        assert_eq!(v["repositoryId"], "r");
        assert_eq!(v["state"], "needs-you");
        assert_eq!(v["attention"]["source"], "hook");
        assert_eq!(v["attention"]["canRespond"], true);
        assert!(v["lastTurnEndedAt"].is_null());
        let r: AttentionResponse = serde_json::from_str(r#""allow-task""#).unwrap();
        assert_eq!(r, AttentionResponse::AllowTask);
    }
}
