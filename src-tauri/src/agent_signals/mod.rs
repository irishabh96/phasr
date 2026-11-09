//! Agent signals: what each running agent is doing and whether it needs the
//! user — "working", "idle", "needs you" (with an answerable approval), or
//! "exited" — plus token usage, the last assistant message and the files it
//! edited.
//!
//! Sources, strongest first:
//! 1. **Hooks** (`hook_bridge`): Claude's settings hooks and Codex's
//!    `notify`, delivered as one file per event and parsed into
//!    `signal::AgentSignal`.
//! 2. **Heuristics** (`heuristics`): the agent's own approval dialog
//!    recognised at the end of its PTY output, after a quiet period.
//! 3. **Transcripts** (`transcripts`): usage/summary/edits from the agents'
//!    session files.
//!
//! Like the orchestrator this is Tauri-agnostic: state changes go out on a
//! `tokio::broadcast`, and `commands::events` re-emits them.

pub mod heuristics;
pub mod hook_bridge;
pub mod launch;
pub mod pricing;
pub mod signal;
pub mod state;
pub mod transcripts;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::domain::usage::TaskUsage;
use crate::domain::{Agent, Workspace, WorkspaceKind};
use crate::pty::handle::PtyHandle;
use crate::pty::{PromptGate, PromptGateDecision, PtyEvent};
use crate::store::{TaskUsageRepo, WorkspaceRepo};

use heuristics::{Detection, TailBuffer, QUIET};
use hook_bridge::HookBridge;
pub use hook_bridge::AgentPolicy;
use launch::Resume;
use signal::{AgentSignal, SessionInfo};
use state::{AgentStateKind, AttentionKind, ClaimError, Effect, TaskSignalState};
use transcripts::{TranscriptReader, TranscriptRoots, TranscriptTarget};

pub use state::{AttentionResponse, TaskAgentState};
pub use transcripts::{AgentFileEdit, AgentSummary, SummarySource};

/// Usage is re-read at most this often per task (and so emitted at most
/// this often — the `phasr://task-usage` throttle).
const USAGE_MIN_INTERVAL: Duration = Duration::from_secs(5);
/// How often the usage poller wakes to look for due tasks.
const USAGE_TICK: Duration = Duration::from_secs(1);
/// Hook-dir rescan when the filesystem watcher is quiet or unavailable.
const HOOK_POLL: Duration = Duration::from_secs(1);
const EVENT_CAPACITY: usize = 512;
/// The prompt gate judges the screen only once output has been quiet this
/// long — a dialog is drawn in a burst, and judging mid-burst could miss it.
const GATE_SETTLE: Duration = Duration::from_millis(400);
/// …but an agent that never goes quiet (a spinner) is judged after this.
const GATE_SETTLE_MAX: Duration = Duration::from_secs(3);

#[derive(Debug, Error)]
pub enum AgentSignalError {
    /// The card the user clicked is no longer the agent's current dialog.
    /// The frontend matches this exact string.
    #[error("stale attention")]
    StaleAttention,
    #[error("this prompt can't be answered from Phasr; open the terminal to respond")]
    NotRespondable,
    /// The dialog offers no option scoped to this task/session (Claude's
    /// "always allow … from this project" is a persistent rule).
    #[error("this prompt has no allow-for-this-task option; allow once or answer in the terminal")]
    AllowTaskUnavailable,
}

impl serde::Serialize for AgentSignalError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone)]
pub enum AgentSignalEvent {
    State(TaskAgentState),
    Usage { task_id: String, usage: TaskUsage },
    /// `last_turn_ended_at` was written (a synced column): push it.
    TurnEnded,
    /// A tool call finished (`PostToolUse`): the worktree may have changed,
    /// so the task's cached diff is stale.
    ToolFinished {
        task_id: String,
        repository_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct SignalsConfig {
    pub app_data_dir: PathBuf,
    pub roots: TranscriptRoots,
    /// The user's Codex config, read for their own `notify` to chain.
    pub codex_config: PathBuf,
}

impl SignalsConfig {
    pub fn for_app(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            roots: TranscriptRoots::from_env(),
            codex_config: transcripts::codex_home().join("config.toml"),
        }
    }
}

/// What the orchestrator needs to start or resume an agent's PTY.
#[derive(Debug, Clone)]
pub struct LaunchTask {
    pub task_id: String,
    pub agent: Agent,
    /// The stored command (`workspaces.command`).
    pub command: String,
    pub prompt: Option<String>,
    /// Re-opening a task that ran before (vs. its first start).
    pub resuming: bool,
    pub target: TranscriptTarget,
    /// Repository rules written into the agent's permission settings
    /// (Claude only; ignored for the rest).
    pub policy: AgentPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaunchPlan {
    pub command: String,
    pub env: Vec<(String, String)>,
    pub send_prompt: bool,
}

struct TaskEntry {
    state: TaskSignalState,
    tail: Arc<Mutex<TailBuffer>>,
    /// Bumped per registration so a replaced PTY's detector can't write.
    generation: u64,
    target: Option<TranscriptTarget>,
    /// Shared with the task's detector, which sets it on every output chunk
    /// WITHOUT taking the global `tasks` lock (it used to, per PTY chunk).
    usage_dirty: Arc<AtomicBool>,
    last_usage_refresh: Option<Instant>,
    last_usage: Option<TaskUsage>,
    gate: GateState,
}

/// The initial-prompt gate's memory of the folder-trust dialog.
#[derive(Debug, Default)]
struct GateState {
    /// "No, exit" was chosen: the agent is quitting, the prompt is dropped.
    denied: bool,
    /// The dialog was just answered (in the app or the terminal): judge
    /// the screen again only once output newer than this has arrived, so
    /// the not-yet-repainted dialog isn't mistaken for "gone".
    await_output_after: Option<Instant>,
    /// Start of the current settle wait (bounds it by `GATE_SETTLE_MAX`).
    settling_since: Option<Instant>,
}

/// Identity of a transcript reader: a change (e.g. an in-place row
/// reclaimed by a new run) needs a fresh one; new session ids don't.
#[derive(Debug, Clone, PartialEq)]
struct ReaderKey {
    agent: Agent,
    cwd: PathBuf,
    since: Option<DateTime<Utc>>,
    shared_cwd: bool,
}

impl ReaderKey {
    fn of(t: &TranscriptTarget) -> Self {
        Self {
            agent: t.agent,
            cwd: t.cwd.clone(),
            since: t.since,
            shared_cwd: t.shared_cwd,
        }
    }
}

struct ReaderSlot {
    key: ReaderKey,
    reader: Arc<Mutex<TranscriptReader>>,
}

struct Inner {
    bridge: HookBridge,
    roots: TranscriptRoots,
    codex_config: PathBuf,
    tasks: Mutex<HashMap<String, TaskEntry>>,
    readers: Mutex<HashMap<String, ReaderSlot>>,
    events: broadcast::Sender<AgentSignalEvent>,
    workspaces: WorkspaceRepo,
    usage_repo: TaskUsageRepo,
    next_generation: std::sync::atomic::AtomicU64,
    /// `task_id → repository_id` for tasks whose worktree is being set up
    /// (fetch, copy, after-create hook — up to minutes) before the agent
    /// spawns. Reported as a working state so the board derives Running,
    /// not Draft-with-"Start now", for a task that is already starting.
    starting: Mutex<HashMap<String, String>>,
}

/// The activity line of a task that is still being set up.
pub const STARTING_ACTIVITY: &str = "Setting up the worktree\u{2026}";

#[derive(Clone)]
pub struct AgentSignals {
    inner: Arc<Inner>,
}

impl AgentSignals {
    /// Installs the hook script. Never fails: without it, launches add no
    /// hook extras and heuristics carry the signal alone.
    pub fn new(config: SignalsConfig, workspaces: WorkspaceRepo, usage_repo: TaskUsageRepo) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                bridge: HookBridge::install(&config.app_data_dir),
                roots: config.roots,
                codex_config: config.codex_config,
                tasks: Mutex::new(HashMap::new()),
                readers: Mutex::new(HashMap::new()),
                events,
                workspaces,
                usage_repo,
                next_generation: std::sync::atomic::AtomicU64::new(1),
                starting: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Start the hook watcher and the usage poller. Call once, inside a
    /// Tokio runtime.
    pub fn start(&self) {
        // Hook files left by a previous run belong to PTYs that are gone.
        for task in self.inner.bridge.task_dirs() {
            let _ = hook_bridge::drain_dir(&self.inner.bridge.hook_dir().join(&task));
        }
        tokio::spawn(self.clone().run_hook_watcher());
        tokio::spawn(self.clone().run_usage_poller());
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentSignalEvent> {
        self.inner.events.subscribe()
    }

    fn emit(&self, event: AgentSignalEvent) {
        let _ = self.inner.events.send(event);
    }

    // ── launch ──────────────────────────────────────────────────────────

    /// The command line, env and prompt policy for spawning `task`'s agent.
    pub async fn prepare_launch(&self, task: &LaunchTask) -> LaunchPlan {
        let bridge = &self.inner.bridge;
        let hook_args = match task.agent {
            Agent::Claude => bridge.claude_args(&task.task_id, &task.policy),
            Agent::Codex => {
                let notify = hook_bridge::read_codex_user_notify(&self.inner.codex_config);
                bridge.codex_args(&notify)
            }
            _ => None,
        };
        // A `{{prompt}}` template already hands the prompt to the agent on
        // its command line: typing it as well would deliver it twice.
        let embeds_prompt = launch::command_embeds_prompt(&task.command, task.prompt.as_deref());
        let resume = if task.resuming && !embeds_prompt {
            self.resume_mode(task).await
        } else {
            Resume::Fresh
        };
        match launch::try_compose(task.agent, &task.command, hook_args.as_deref(), &resume) {
            Some(command) => LaunchPlan {
                env: if hook_args.is_some() {
                    bridge.task_env(&task.task_id)
                } else {
                    Vec::new()
                },
                command,
                send_prompt: resume.sends_prompt() && !embeds_prompt,
            },
            // A wrapper we can't see into: run it exactly as before, prompt
            // included — a resume that couldn't be expressed mustn't eat it.
            None => LaunchPlan {
                command: task.command.clone(),
                env: Vec::new(),
                send_prompt: !embeds_prompt,
            },
        }
    }

    async fn resume_mode(&self, task: &LaunchTask) -> Resume {
        match task.agent {
            Agent::Claude => {
                if let Ok(Some(id)) = self.inner.workspaces.get_agent_session_id(&task.task_id).await {
                    if launch::is_valid_session_id(&id) {
                        return Resume::ClaudeSession(id);
                    }
                }
                if self.transcripts_exist(task.target.clone()).await {
                    Resume::ClaudeContinue
                } else {
                    Resume::Fresh
                }
            }
            Agent::Codex => {
                if self.transcripts_exist(task.target.clone()).await {
                    Resume::CodexLast
                } else {
                    Resume::Fresh
                }
            }
            _ => Resume::Fresh,
        }
    }

    async fn transcripts_exist(&self, target: TranscriptTarget) -> bool {
        let roots = self.inner.roots.clone();
        tokio::task::spawn_blocking(move || {
            TranscriptReader::new(target, &roots).is_some_and(|mut r| r.has_sessions())
        })
        .await
        .unwrap_or(false)
    }

    // ── task lifecycle ──────────────────────────────────────────────────

    /// Start tracking a task whose agent is about to spawn. Returns the
    /// generation to pass to `attach_pty`.
    pub fn register_task(
        &self,
        workspace: &Workspace,
        agent: Agent,
        cwd: &Path,
        target: Option<TranscriptTarget>,
    ) -> u64 {
        let generation = self
            .inner
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut state = TaskSignalState::new(
            workspace.id.clone(),
            workspace.repository_id.clone(),
            agent,
            cwd.to_string_lossy().into_owned(),
            Utc::now(),
        );
        state.last_turn_ended_at = workspace.last_turn_ended_at;
        let wire = state.to_wire();
        self.inner.tasks.lock().insert(
            workspace.id.clone(),
            TaskEntry {
                state,
                tail: Arc::new(Mutex::new(TailBuffer::default())),
                generation,
                target,
                usage_dirty: Arc::new(AtomicBool::new(true)),
                last_usage_refresh: None,
                last_usage: None,
                gate: GateState::default(),
            },
        );
        self.emit(AgentSignalEvent::State(wire));
        generation
    }

    /// Watch the agent's PTY output for dialogs (the heuristic fallback).
    pub fn attach_pty(&self, task_id: &str, generation: u64, handle: &Arc<PtyHandle>) {
        let Some((agent, tail, usage_dirty)) = self.inner.tasks.lock().get(task_id).and_then(|e| {
            (e.generation == generation).then(|| {
                // Agents without readable usage never need a re-read.
                let dirty = e.state.agent.usage_supported().then(|| e.usage_dirty.clone());
                (e.state.agent, e.tail.clone(), dirty)
            })
        }) else {
            return;
        };
        let rx = handle.subscribe();
        tokio::spawn(self.clone().run_detector(task_id.to_string(), generation, agent, tail, usage_dirty, rx));
    }

    /// `task_id` is being set up to launch (see `Inner::starting`). Until
    /// its agent registers, `states()` reports it as working.
    pub fn mark_starting(&self, task_id: &str, repository_id: &str) {
        self.inner
            .starting
            .lock()
            .insert(task_id.to_string(), repository_id.to_string());
        if let Some(wire) = self.starting_state(task_id) {
            self.emit(AgentSignalEvent::State(wire));
        }
    }

    /// Setup ended. If no agent registered (the start failed), say it is
    /// not running so no "working" state lingers for the task.
    pub fn clear_starting(&self, task_id: &str) {
        let Some(repository_id) = self.inner.starting.lock().remove(task_id) else {
            return;
        };
        if self.inner.tasks.lock().contains_key(task_id) {
            return;
        }
        self.emit(AgentSignalEvent::State(TaskAgentState {
            task_id: task_id.to_string(),
            repository_id,
            state: AgentStateKind::Exited,
            attention: None,
            last_activity: None,
            last_turn_ended_at: None,
        }));
    }

    /// The synthetic "setting up" state, unless a live agent is registered.
    fn starting_state(&self, task_id: &str) -> Option<TaskAgentState> {
        let repository_id = self.inner.starting.lock().get(task_id).cloned()?;
        let live = self
            .inner
            .tasks
            .lock()
            .get(task_id)
            .is_some_and(|e| e.state.kind != AgentStateKind::Exited);
        (!live).then(|| TaskAgentState {
            task_id: task_id.to_string(),
            repository_id,
            state: AgentStateKind::Working,
            attention: None,
            last_activity: Some(STARTING_ACTIVITY.to_string()),
            last_turn_ended_at: None,
        })
    }

    /// Whether `task_id`'s agent is blocked on a dialog right now. A
    /// message typed then (ending in Enter) would answer it.
    pub fn awaiting_answer(&self, task_id: &str) -> bool {
        self.inner
            .tasks
            .lock()
            .get(task_id)
            .is_some_and(|e| e.state.kind == AgentStateKind::NeedsYou)
    }

    /// What `task_id`'s agent is doing, as the board's domain sees it.
    pub fn phase(&self, task_id: &str) -> Option<crate::domain::board::AgentPhase> {
        self.inner.tasks.lock().get(task_id).map(|e| e.state.kind.into())
    }

    /// The agent's PTY exited (or was killed).
    pub fn mark_exited(&self, task_id: &str) {
        let wire = {
            let mut tasks = self.inner.tasks.lock();
            let Some(entry) = tasks.get_mut(task_id) else {
                return;
            };
            if entry.state.kind == AgentStateKind::Exited {
                return;
            }
            entry.state.on_exit(Utc::now());
            entry.usage_dirty.store(true, Ordering::Relaxed);
            entry.state.to_wire()
        };
        self.emit(AgentSignalEvent::State(wire));
    }

    /// The task is being archived/deleted: drop its state and files.
    pub fn forget_task(&self, task_id: &str) {
        let removed = self.inner.tasks.lock().remove(task_id);
        self.inner.readers.lock().remove(task_id);
        self.inner.bridge.clean_task(task_id);
        if let Some(mut entry) = removed {
            if entry.state.kind != AgentStateKind::Exited {
                entry.state.on_exit(Utc::now());
                self.emit(AgentSignalEvent::State(entry.state.to_wire()));
            }
        }
    }

    /// Keystrokes / a composer message went to the task's PTY.
    pub fn note_user_input(&self, task_id: &str, bytes: &[u8]) {
        if !is_meaningful_input(bytes) {
            return;
        }
        let wire = {
            let mut tasks = self.inner.tasks.lock();
            let Some(entry) = tasks.get_mut(task_id) else {
                return;
            };
            entry.tail.lock().mark_consumed();
            if entry.state.attention.as_ref().is_some_and(|a| a.kind == AttentionKind::Trust) {
                // Answered in the terminal. Esc / Ctrl-C is "No, exit"
                // whatever the selector is on; anything else, wait for the
                // screen to show what it did.
                if bytes == b"\x1b" || bytes == b"\x03" {
                    entry.gate.denied = true;
                } else {
                    entry.gate.await_output_after = Some(Instant::now());
                    entry.gate.settling_since = None;
                }
            }
            if !entry.state.on_user_input(bytes, Utc::now()) {
                return;
            }
            entry.state.to_wire()
        };
        self.emit(AgentSignalEvent::State(wire));
    }

    /// Validate and consume an in-app answer. Returns the keystrokes to
    /// write; on `Err` the caller must write nothing.
    pub fn claim_attention(
        &self,
        task_id: &str,
        attention_id: &str,
        response: AttentionResponse,
    ) -> Result<String, AgentSignalError> {
        let (keys, wire) = {
            let mut tasks = self.inner.tasks.lock();
            let entry = tasks.get_mut(task_id).ok_or(AgentSignalError::StaleAttention)?;
            let keys = entry
                .state
                .agent
                .approval_keys()
                .ok_or(AgentSignalError::NotRespondable)?;
            let attention = entry
                .state
                .claim_attention(attention_id, response, Utc::now())
                .map_err(|e| match e {
                    ClaimError::Stale => AgentSignalError::StaleAttention,
                    ClaimError::NotRespondable => AgentSignalError::NotRespondable,
                    ClaimError::NoTaskScope => AgentSignalError::AllowTaskUnavailable,
                })?;
            // The dialog on screen is being answered: don't re-detect it.
            entry.tail.lock().mark_consumed();
            if attention.kind == AttentionKind::Trust {
                if response == AttentionResponse::Deny {
                    entry.gate.denied = true;
                } else {
                    entry.gate.await_output_after = Some(Instant::now());
                    entry.gate.settling_since = None;
                }
            }
            // Keys printed on the dialog beat the static table.
            let keys = match response {
                AttentionResponse::AllowOnce => attention
                    .keys
                    .allow_once
                    .unwrap_or_else(|| keys.allow_once.to_string()),
                AttentionResponse::AllowTask => attention
                    .keys
                    .allow_task
                    .unwrap_or_else(|| keys.allow_task.to_string()),
                AttentionResponse::Deny => attention
                    .keys
                    .deny
                    .unwrap_or_else(|| keys.deny.to_string()),
            };
            (keys, entry.state.to_wire())
        };
        self.emit(AgentSignalEvent::State(wire));
        Ok(keys)
    }

    // ── initial-prompt gate ─────────────────────────────────────────────

    /// The gate `run_initial_writes` consults before typing `task_id`'s
    /// initial prompt. Only agents that can show a folder-trust dialog get
    /// one; for the rest the prompt goes out as soon as the TUI is up.
    pub fn prompt_gate(&self, task_id: &str, generation: u64) -> Option<Arc<dyn PromptGate>> {
        let agent = self.inner.tasks.lock().get(task_id)?.state.agent;
        heuristics::has_trust_dialog(agent).then(|| {
            Arc::new(TrustGate {
                signals: self.clone(),
                task_id: task_id.to_string(),
                generation,
            }) as Arc<dyn PromptGate>
        })
    }

    /// Whether the initial prompt may be typed into `task_id`'s PTY now.
    ///
    /// Holds it while the agent's folder-trust dialog is up — raising the
    /// "Trust this folder?" card right away rather than after the
    /// detector's quiet period — and until an answer has visibly taken
    /// effect. A declined dialog (or a task that's gone) drops the prompt.
    fn gate_check(&self, task_id: &str, generation: u64) -> PromptGateDecision {
        let now = Instant::now();
        let trust = {
            let mut tasks = self.inner.tasks.lock();
            let Some(entry) = tasks.get_mut(task_id) else {
                return PromptGateDecision::Abandon;
            };
            if entry.generation != generation
                || entry.state.kind == AgentStateKind::Exited
                || entry.gate.denied
            {
                return PromptGateDecision::Abandon;
            }
            let tail = entry.tail.clone();
            let tail = tail.lock();
            let last_output = tail.last_push();
            if let Some(answered) = entry.gate.await_output_after {
                if last_output.is_none_or(|at| at <= answered) {
                    return PromptGateDecision::Wait;
                }
                entry.gate.await_output_after = None;
            }
            let since = *entry.gate.settling_since.get_or_insert(now);
            // No output seen yet is NOT quiet: the writer thread only asks
            // after it saw the TUI start drawing, so the detector (a
            // separate subscriber) just hasn't caught up — judging an
            // empty tail would wave the prompt into the dialog.
            let quiet = last_output.is_some_and(|at| now.duration_since(at) >= GATE_SETTLE);
            if !quiet && now.duration_since(since) < GATE_SETTLE_MAX {
                return PromptGateDecision::Wait;
            }
            match tail.detect(entry.state.agent) {
                Some(found) if found.kind == AttentionKind::Trust => found,
                _ => {
                    let card_up = entry.state.kind == AgentStateKind::NeedsYou
                        && entry
                            .state
                            .attention
                            .as_ref()
                            .is_some_and(|a| a.kind == AttentionKind::Trust);
                    // A card still up for a dialog no longer at the end of
                    // the output clears on the detector's next quiet pass.
                    return if card_up {
                        PromptGateDecision::Wait
                    } else {
                        PromptGateDecision::Proceed
                    };
                }
            }
        };
        // Same path as the detector, so the card is raised once (a repeat
        // of the same dialog keeps its id).
        self.apply_heuristic(task_id, generation, Some(trust));
        PromptGateDecision::Wait
    }

    pub fn states(&self) -> Vec<TaskAgentState> {
        let starting: Vec<String> = self.inner.starting.lock().keys().cloned().collect();
        let mut out: Vec<TaskAgentState> = self
            .inner
            .tasks
            .lock()
            .values()
            .filter(|e| !starting.contains(&e.state.task_id) || e.state.kind != AgentStateKind::Exited)
            .map(|e| e.state.to_wire())
            .collect();
        for task_id in &starting {
            if let Some(wire) = self.starting_state(task_id) {
                out.push(wire);
            }
        }
        out.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        out
    }

    #[cfg(test)]
    pub fn state(&self, task_id: &str) -> Option<TaskAgentState> {
        self.inner.tasks.lock().get(task_id).map(|e| e.state.to_wire())
    }

    // ── hooks ───────────────────────────────────────────────────────────

    async fn run_hook_watcher(self) {
        use notify::Watcher;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        // Kept alive for the loop's lifetime; a failure leaves the poll.
        let _watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        })
        .and_then(|mut w| {
            w.watch(self.inner.bridge.hook_dir(), notify::RecursiveMode::Recursive)?;
            Ok(w)
        })
        .map_err(|err| eprintln!("agent hook watcher unavailable, polling: {err}"))
        .ok();
        loop {
            tokio::select! {
                _ = rx.recv() => {}
                _ = tokio::time::sleep(HOOK_POLL) => {}
            }
            while rx.try_recv().is_ok() {}
            self.drain_hooks().await;
        }
    }

    /// Process every pending hook file now.
    pub async fn drain_hooks(&self) {
        let bridge = self.inner.bridge.clone();
        let Ok(batches) = tokio::task::spawn_blocking(move || {
            bridge
                .task_dirs()
                .into_iter()
                .map(|task| {
                    let events = bridge.drain_task_dir(&task);
                    (task, events)
                })
                .filter(|(_, events)| !events.is_empty())
                .collect::<Vec<_>>()
        })
        .await
        else {
            return;
        };
        for (task_id, events) in batches {
            for (signal, session) in events {
                self.dispatch(&task_id, &signal, &session).await;
            }
        }
    }

    async fn dispatch(&self, task_id: &str, signal: &AgentSignal, session: &SessionInfo) {
        let (changed, effects, repository_id) = {
            let mut tasks = self.inner.tasks.lock();
            // Events for a task phasr isn't running (stale files) are dropped.
            let Some(entry) = tasks.get_mut(task_id) else {
                return;
            };
            let before = entry.state.to_wire();
            let effects = entry.state.apply_hook(signal, session, Utc::now());
            if effects.contains(&Effect::UsageDirty) {
                entry.usage_dirty.store(true, Ordering::Relaxed);
            }
            let after = entry.state.to_wire();
            (
                (before != after).then_some(after),
                effects,
                entry.state.repository_id.clone(),
            )
        };
        if let Some(wire) = changed {
            self.emit(AgentSignalEvent::State(wire));
        }
        if matches!(signal, AgentSignal::PostToolUse { tool_name, .. } if tool_may_modify_files(tool_name)) {
            self.emit(AgentSignalEvent::ToolFinished {
                task_id: task_id.to_string(),
                repository_id,
            });
        }
        for effect in effects {
            match effect {
                Effect::PersistSession(id) if launch::is_valid_session_id(&id) => {
                    if let Err(err) = self.inner.workspaces.set_agent_session_id(task_id, &id).await {
                        eprintln!("failed to record agent session for {task_id}: {err}");
                    }
                }
                Effect::TurnEnded(at) => {
                    match self.inner.workspaces.set_last_turn_ended_at(task_id, at).await {
                        Ok(()) => self.emit(AgentSignalEvent::TurnEnded),
                        Err(err) => eprintln!("failed to record turn end for {task_id}: {err}"),
                    }
                }
                _ => {}
            }
        }
    }

    // ── heuristics ──────────────────────────────────────────────────────

    async fn run_detector(
        self,
        task_id: String,
        generation: u64,
        agent: Agent,
        tail: Arc<Mutex<TailBuffer>>,
        usage_dirty: Option<Arc<AtomicBool>>,
        mut rx: broadcast::Receiver<PtyEvent>,
    ) {
        let mut deadline: Option<tokio::time::Instant> = None;
        loop {
            let quiet = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                event = rx.recv() => match event {
                    Ok(PtyEvent::Output { chunk, .. }) => {
                        tail.lock().push(&chunk);
                        deadline = Some(tokio::time::Instant::now() + QUIET);
                        // A replaced PTY's detector holds the OLD entry's
                        // flag, so it can't dirty the new generation.
                        if let Some(dirty) = &usage_dirty {
                            dirty.store(true, Ordering::Relaxed);
                        }
                    }
                    Ok(PtyEvent::Exit { .. }) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = quiet => {
                    deadline = None;
                    let found = tail.lock().detect(agent);
                    self.apply_heuristic(&task_id, generation, found);
                }
            }
        }
    }

    #[cfg(test)]
    fn mark_output(&self, task_id: &str, generation: u64) {
        if let Some(entry) = self.inner.tasks.lock().get_mut(task_id) {
            if entry.generation == generation && entry.state.agent.usage_supported() {
                entry.usage_dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    fn apply_heuristic(&self, task_id: &str, generation: u64, found: Option<Detection>) {
        let wire = {
            let mut tasks = self.inner.tasks.lock();
            let Some(entry) = tasks.get_mut(task_id) else {
                return;
            };
            if entry.generation != generation {
                return;
            }
            let before = entry.state.to_wire();
            entry.state.apply_heuristic(found, Utc::now());
            let after = entry.state.to_wire();
            if before == after {
                return;
            }
            after
        };
        self.emit(AgentSignalEvent::State(wire));
    }

    // ── transcripts ─────────────────────────────────────────────────────

    /// Where `workspace`'s transcripts are. `None` for agents without a
    /// readable transcript, or a row with no cwd.
    pub fn target_for(&self, workspace: &Workspace) -> Option<TranscriptTarget> {
        let agent = workspace.agent.filter(|a| a.usage_supported())?;
        let cwd = PathBuf::from(workspace.worktree_path.as_deref()?);
        let shared = workspace.workspace_kind == WorkspaceKind::Local;
        let known = self
            .inner
            .tasks
            .lock()
            .get(&workspace.id)
            .and_then(|e| e.state.session_id.clone());
        Some(TranscriptTarget {
            agent,
            cwd,
            since: if shared {
                workspace.started_at
            } else {
                Some(workspace.created_at)
            },
            session_ids: known.into_iter().collect(),
            shared_cwd: shared,
        })
    }

    fn reader_for(&self, task_id: &str, target: &TranscriptTarget) -> Option<Arc<Mutex<TranscriptReader>>> {
        let key = ReaderKey::of(target);
        let mut readers = self.inner.readers.lock();
        if let Some(slot) = readers.get(task_id) {
            if slot.key == key {
                return Some(slot.reader.clone());
            }
        }
        let reader = Arc::new(Mutex::new(TranscriptReader::new(target.clone(), &self.inner.roots)?));
        readers.insert(
            task_id.to_string(),
            ReaderSlot {
                key,
                reader: reader.clone(),
            },
        );
        Some(reader)
    }

    /// Refresh `task_id`'s transcripts off the async runtime and read them.
    /// The reader's own lock is only ever taken on the blocking pool.
    async fn with_reader<T: Send + 'static>(
        &self,
        task_id: &str,
        target: TranscriptTarget,
        read: impl FnOnce(&TranscriptReader) -> T + Send + 'static,
    ) -> Option<T> {
        let reader = self.reader_for(task_id, &target)?;
        tokio::task::spawn_blocking(move || {
            let mut reader = reader.lock();
            reader.add_session_ids(&target.session_ids);
            reader.refresh();
            read(&reader)
        })
        .await
        .ok()
    }

    async fn known_session_ids(&self, workspace: &Workspace, target: &mut TranscriptTarget) {
        if let Ok(Some(id)) = self.inner.workspaces.get_agent_session_id(&workspace.id).await {
            if !target.session_ids.contains(&id) {
                target.session_ids.push(id);
            }
        }
    }

    /// Current usage for a task, persisting a changed snapshot. Falls back
    /// to the stored snapshot when the transcript isn't readable here.
    pub async fn usage_for(&self, workspace: &Workspace) -> Option<TaskUsage> {
        let stored = self.inner.usage_repo.get(&workspace.id).await.ok().flatten();
        let Some(mut target) = self.target_for(workspace) else {
            return stored;
        };
        self.known_session_ids(workspace, &mut target).await;
        let fresh = self
            .with_reader(&workspace.id, target, |r| r.usage(Utc::now()))
            .await
            .flatten();
        match fresh {
            Some(usage) => {
                if !stored.as_ref().is_some_and(|s| s.same_totals(&usage)) {
                    if let Err(err) = self.inner.usage_repo.upsert(&workspace.id, &usage).await {
                        eprintln!("failed to store usage for {}: {err}", workspace.id);
                    }
                }
                Some(usage)
            }
            None => stored,
        }
    }

    /// The agent's last assistant message: from the transcript when
    /// readable, else from the last Stop/turn-complete hook.
    pub async fn summary_for(&self, workspace: &Workspace) -> Option<AgentSummary> {
        let from_transcript = match self.target_for(workspace) {
            Some(mut target) => {
                self.known_session_ids(workspace, &mut target).await;
                self.with_reader(&workspace.id, target, |r| r.summary())
                    .await
                    .flatten()
            }
            None => None,
        };
        let from_hook = self
            .inner
            .tasks
            .lock()
            .get(&workspace.id)
            .and_then(|e| e.state.last_message.clone())
            .map(|(text, at)| AgentSummary {
                text,
                at,
                source: SummarySource::Hook,
            });
        match (from_transcript, from_hook) {
            (Some(t), Some(h)) if h.at > t.at + chrono::Duration::seconds(2) => Some(h),
            (Some(t), _) => Some(t),
            (None, h) => h,
        }
    }

    pub async fn file_edits_for(&self, workspace: &Workspace) -> Vec<AgentFileEdit> {
        let Some(mut target) = self.target_for(workspace) else {
            return Vec::new();
        };
        self.known_session_ids(workspace, &mut target).await;
        self.with_reader(&workspace.id, target, |r| r.file_edits())
            .await
            .unwrap_or_default()
    }

    async fn run_usage_poller(self) {
        let mut tick = tokio::time::interval(USAGE_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            self.poll_usage_once().await;
        }
    }

    /// Re-read usage for every dirty task whose throttle window has passed;
    /// persist and emit the ones that changed.
    pub async fn poll_usage_once(&self) {
        let now = Instant::now();
        let due: Vec<(String, TranscriptTarget)> = {
            let mut tasks = self.inner.tasks.lock();
            tasks
                .iter_mut()
                .filter(|(_, e)| {
                    e.usage_dirty.load(Ordering::Relaxed)
                        && e.last_usage_refresh
                            .is_none_or(|at| now.duration_since(at) >= USAGE_MIN_INTERVAL)
                })
                .filter_map(|(id, e)| {
                    let mut target = e.target.clone()?;
                    if let Some(session) = &e.state.session_id {
                        if !target.session_ids.contains(session) {
                            target.session_ids.push(session.clone());
                        }
                    }
                    e.usage_dirty.store(false, Ordering::Relaxed);
                    e.last_usage_refresh = Some(now);
                    Some((id.clone(), target))
                })
                .collect()
        };
        for (task_id, target) in due {
            let Some(Some(usage)) = self
                .with_reader(&task_id, target, |r| r.usage(Utc::now()))
                .await
            else {
                continue;
            };
            let changed = {
                let mut tasks = self.inner.tasks.lock();
                let Some(entry) = tasks.get_mut(&task_id) else {
                    continue;
                };
                let changed = !entry
                    .last_usage
                    .as_ref()
                    .is_some_and(|prev| prev.same_totals(&usage));
                entry.last_usage = Some(usage.clone());
                changed
            };
            if changed {
                if let Err(err) = self.inner.usage_repo.upsert(&task_id, &usage).await {
                    eprintln!("failed to store usage for {task_id}: {err}");
                }
                self.emit(AgentSignalEvent::Usage { task_id, usage });
            }
        }
    }
}

/// `PromptGate` for one task launch, backed by `AgentSignals::gate_check`.
struct TrustGate {
    signals: AgentSignals,
    task_id: String,
    generation: u64,
}

impl std::fmt::Debug for TrustGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustGate")
            .field("task_id", &self.task_id)
            .field("generation", &self.generation)
            .finish()
    }
}

impl PromptGate for TrustGate {
    fn check(&self) -> PromptGateDecision {
        self.signals.gate_check(&self.task_id, self.generation)
    }
}

/// Split an answer into the keystrokes it's made of: one escape sequence
/// (`ESC [ … final`, `ESC O x`) or one character each. Written one at a
/// time with a gap, a multi-key answer (Down, then Enter) can't be read
/// by the TUI as one chunk — Ink would see the Enter before re-rendering
/// the moved selection, or not recognise the combined sequence at all.
pub fn split_keystrokes(keys: &str) -> Vec<&str> {
    let bytes = keys.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if bytes[i] == 0x1b && i + 1 < bytes.len() && (bytes[i + 1] == b'[' || bytes[i + 1] == b'O') {
            let csi = bytes[i + 1] == b'[';
            i += 2;
            if csi {
                // Parameters/intermediates, then one final byte.
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
            }
            i = (i + 1).min(bytes.len());
        } else {
            i += keys[i..].chars().next().map_or(1, char::len_utf8);
        }
        out.push(&keys[start..i]);
    }
    out
}

/// Tools whose completion can change the worktree (so the task's cached
/// diff is stale). Reads and searches can't — firing `ToolFinished` for
/// every Read/Grep/Glob made the board recompute diffs constantly.
fn tool_may_modify_files(tool: &str) -> bool {
    matches!(
        tool,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Bash" | "apply_patch"
    )
}

/// Whether PTY input reflects the user acting on the screen, rather than
/// the terminal answering on its own. The emulator writes its replies to
/// the agent's queries through the same input path as keystrokes —
/// Claude's trust dialog ends with DA1 / kitty-keyboard / XTVERSION
/// queries, and the answers arrive within milliseconds. Treating those as
/// "the user answered" consumed the dialog before the gate ever saw it.
///
/// Non-input, possibly several concatenated in one write:
/// focus (`CSI I|O`), mouse (SGR `CSI < … M|m`, X10 `CSI M b x y`),
/// CPR (`CSI [?] r ; c R`), DA1 (`CSI ? … c`), DA2 (`CSI > … c`), kitty
/// keyboard flags (`CSI ? … u`), DECRPM (`CSI [?] … $ y`), DSR / window
/// reports (`CSI … n`, `CSI … t`), and DCS / OSC / APC / PM strings
/// terminated by ST or BEL. Anything else — including a lone ESC or an
/// UNTERMINATED string (Alt+P is `ESC P`) — is the user.
///
/// #PLAN_UNCERTAINTY: `CSI 1 ; <mod> R` is also xterm's modified F3; a
/// user pressing Shift/Ctrl+F3 in an agent dialog is accepted as a miss.
pub fn is_meaningful_input(bytes: &[u8]) -> bool {
    // Empty input is nothing; a write made only of reports is the terminal.
    let mut i = 0;
    while i < bytes.len() {
        match terminal_report_len(&bytes[i..]) {
            Some(len) => i += len,
            None => return true,
        }
    }
    false
}

/// Length of the terminal-generated report at the start of `b`, or `None`
/// if `b` doesn't start with one (i.e. it's user input).
fn terminal_report_len(b: &[u8]) -> Option<usize> {
    if b.first() != Some(&0x1b) || b.len() < 2 {
        return None;
    }
    match b[1] {
        b'[' => csi_report_len(b),
        // DCS, OSC, APC, PM: a string up to ST (`ESC \`) or, for OSC, BEL.
        b'P' | b']' | b'_' | b'^' => {
            let mut j = 2;
            while j < b.len() {
                match b[j] {
                    0x07 => return Some(j + 1),
                    0x1b if b.get(j + 1) == Some(&b'\\') => return Some(j + 2),
                    // A new ESC that isn't ST: the string was never closed.
                    0x1b => return None,
                    _ => j += 1,
                }
            }
            None
        }
        _ => None,
    }
}

fn csi_report_len(b: &[u8]) -> Option<usize> {
    // X10 mouse: `ESC [ M` + three raw bytes.
    if b.get(2) == Some(&b'M') && b.len() >= 6 {
        return Some(6);
    }
    let mut j = 2;
    let params_from = j;
    while j < b.len() && (0x30..=0x3f).contains(&b[j]) {
        j += 1;
    }
    let params = &b[params_from..j];
    let inter_from = j;
    while j < b.len() && (0x20..=0x2f).contains(&b[j]) {
        j += 1;
    }
    let intermediates = &b[inter_from..j];
    let final_byte = *b.get(j)?;
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    let len = j + 1;
    let prefix = params.first().copied();
    let digits_only = |p: &[u8]| p.iter().all(|c| c.is_ascii_digit() || *c == b';');
    let report = match (final_byte, intermediates) {
        (b'I' | b'O', []) => params.is_empty(),
        (b'M' | b'm', []) => prefix == Some(b'<'),
        (b'R', []) => {
            let p = params.strip_prefix(b"?").unwrap_or(params);
            !p.is_empty() && digits_only(p) && p.contains(&b';')
        }
        (b'c', []) => matches!(prefix, Some(b'?' | b'>')),
        (b'u', []) => prefix == Some(b'?'),
        (b'y', [b'$']) => true,
        (b'n', []) => !params.is_empty(),
        (b't', []) => !params.is_empty() && digits_only(params),
        _ => false,
    };
    report.then_some(len)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};
    use std::process::{Command, Stdio};

    struct Fixture {
        signals: AgentSignals,
        workspaces: WorkspaceRepo,
        workspace: Workspace,
        dir: tempfile::TempDir,
    }

    async fn fixture(agent: Agent) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("t.sqlite")).await.unwrap();
        let repo = Repository::new("r".into(), None, None);
        RepositoryRepo::new(pool.clone()).insert(&repo).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let mut workspace = Workspace::new(repo.id.clone(), "w".into(), agent.binary().into());
        workspace.agent = Some(agent);
        workspace.worktree_path = Some(dir.path().join("wt").to_string_lossy().into_owned());
        workspaces.insert(&workspace).await.unwrap();
        let signals = AgentSignals::new(
            SignalsConfig {
                app_data_dir: dir.path().join("App Support"),
                roots: TranscriptRoots {
                    claude_projects: dir.path().join("claude").join("projects"),
                    codex_sessions: dir.path().join("codex").join("sessions"),
                },
                codex_config: dir.path().join("codex").join("config.toml"),
            },
            workspaces.clone(),
            TaskUsageRepo::new(pool),
        );
        Fixture {
            signals,
            workspaces,
            workspace,
            dir,
        }
    }

    /// Run the installed hook script exactly as Claude would: the hook
    /// command from the settings file, through a shell, JSON on stdin.
    fn fire_claude_hook(f: &Fixture, json: &str) {
        let script = f.dir.path().join("App Support").join("bin").join("phasr-hook.sh");
        let mut child = Command::new(script)
            .arg("claude")
            .envs(f.signals.inner.bridge.task_env(&f.workspace.id))
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(json.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
    }

    fn drain_states(rx: &mut broadcast::Receiver<AgentSignalEvent>) -> Vec<TaskAgentState> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let AgentSignalEvent::State(s) = event {
                out.push(s);
            }
        }
        out
    }

    #[tokio::test]
    async fn hook_files_drive_the_registry_and_broadcast() {
        let f = fixture(Agent::Claude).await;
        let mut rx = f.signals.subscribe();
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        f.signals.register_task(&f.workspace, Agent::Claude, &cwd, f.signals.target_for(&f.workspace));
        assert_eq!(drain_states(&mut rx).last().unwrap().state, AgentStateKind::Working);

        let sid = "0f0e0d0c-0b0a-4908-8706-050403020100";
        fire_claude_hook(&f, &format!(r#"{{"hook_event_name":"SessionStart","session_id":"{sid}","transcript_path":"/t.jsonl","source":"startup"}}"#));
        fire_claude_hook(&f, &format!(
            r#"{{"hook_event_name":"PreToolUse","session_id":"{sid}","tool_name":"Bash","tool_input":{{"command":"cargo test"}},"tool_use_id":"t"}}"#
        ));
        fire_claude_hook(&f, &format!(
            r#"{{"hook_event_name":"Notification","session_id":"{sid}","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}}"#
        ));
        f.signals.drain_hooks().await;

        let last = drain_states(&mut rx).pop().unwrap();
        assert_eq!(last.state, AgentStateKind::NeedsYou);
        let attention = last.attention.unwrap();
        assert_eq!(attention.detail.as_deref(), Some("cargo test"));
        assert_eq!(
            f.workspaces.get_agent_session_id(&f.workspace.id).await.unwrap().as_deref(),
            Some(sid)
        );

        // Stale id: refused, state untouched.
        assert!(matches!(
            f.signals.claim_attention(&f.workspace.id, "nope", AttentionResponse::AllowOnce),
            Err(AgentSignalError::StaleAttention)
        ));
        assert_eq!(f.signals.state(&f.workspace.id).unwrap().state, AgentStateKind::NeedsYou);
        // No dialog on screen to read options from: Claude's option 2 may
        // be a persistent project rule, so "allow for this task" is refused…
        assert!(!attention.can_allow_for_task);
        assert!(matches!(
            f.signals.claim_attention(&f.workspace.id, &attention.id, AttentionResponse::AllowTask),
            Err(AgentSignalError::AllowTaskUnavailable)
        ));
        // …without consuming the card: allow once still works.
        assert_eq!(
            f.signals
                .claim_attention(&f.workspace.id, &attention.id, AttentionResponse::AllowOnce)
                .unwrap(),
            "1"
        );

        fire_claude_hook(&f, r#"{"hook_event_name":"Stop","last_assistant_message":"Done."}"#);
        f.signals.drain_hooks().await;
        let mut saw_turn_end = false;
        while let Ok(event) = rx.try_recv() {
            saw_turn_end |= matches!(event, AgentSignalEvent::TurnEnded);
        }
        assert!(saw_turn_end);
        let row = f.workspaces.get(&f.workspace.id).await.unwrap();
        assert!(row.last_turn_ended_at.is_some());
        let summary = f.signals.summary_for(&row).await.unwrap();
        assert_eq!((summary.text.as_str(), summary.source), ("Done.", SummarySource::Hook));
    }

    /// A hook card survives the terminal's own replies (focus, DA1, …) and
    /// an unrelated tool finishing, but real input in the terminal moves it
    /// to Working (answered there).
    #[tokio::test]
    async fn hook_card_ignores_auto_replies_and_moves_on_real_input() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        fire_claude_hook(&f, r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf build"}}"#);
        fire_claude_hook(&f, r#"{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/x"}}"#);
        f.signals.drain_hooks().await;
        assert_eq!(f.signals.state(&f.workspace.id).unwrap().state, AgentStateKind::NeedsYou);
        for reply in [&b"\x1b[I"[..], b"\x1b[?1;2c", b"\x1b[12;40R\x1b[O"] {
            f.signals.note_user_input(&f.workspace.id, reply);
        }
        assert_eq!(f.signals.state(&f.workspace.id).unwrap().state, AgentStateKind::NeedsYou);
        f.signals.note_user_input(&f.workspace.id, b"1");
        let state = f.signals.state(&f.workspace.id).unwrap();
        assert_eq!(state.state, AgentStateKind::Working);
        assert!(state.attention.is_none());
    }

    #[tokio::test]
    async fn events_for_unregistered_tasks_are_dropped() {
        let f = fixture(Agent::Claude).await;
        fire_claude_hook(&f, r#"{"hook_event_name":"Stop"}"#);
        f.signals.drain_hooks().await;
        assert!(f.signals.states().is_empty());
        // The file was consumed regardless.
        assert!(f.signals.inner.bridge.drain_task_dir(&f.workspace.id).is_empty());
    }

    #[tokio::test]
    async fn forget_task_cleans_files_and_reports_exit() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let args = f.signals.inner.bridge.claude_args(&f.workspace.id, &AgentPolicy::default()).unwrap();
        assert!(args.contains("claude-settings.json"));
        let mut rx = f.signals.subscribe();
        f.signals.forget_task(&f.workspace.id);
        assert_eq!(drain_states(&mut rx).pop().unwrap().state, AgentStateKind::Exited);
        assert!(f.signals.states().is_empty());
        assert!(!f
            .dir
            .path()
            .join("App Support/agent-config")
            .join(&f.workspace.id)
            .exists());
    }

    #[tokio::test]
    async fn usage_poller_persists_emits_and_throttles() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let project = f
            .dir
            .path()
            .join("claude/projects")
            .join(transcripts::claude::encode_project_dir(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&project).unwrap();
        let line = |id: &str, out: i64| {
            serde_json::json!({"type":"assistant","timestamp":"2026-11-09T10:00:00Z","message":{
                "id": id, "model": "claude-sonnet-5", "content": [],
                "usage": {"input_tokens": 1, "output_tokens": out}}})
            .to_string()
                + "\n"
        };
        let path = project.join("s.jsonl");
        std::fs::write(&path, line("m1", 10)).unwrap();

        f.signals.register_task(&f.workspace, Agent::Claude, &cwd, f.signals.target_for(&f.workspace));
        let mut rx = f.signals.subscribe();
        f.signals.poll_usage_once().await;
        let usage = loop {
            match rx.try_recv().unwrap() {
                AgentSignalEvent::Usage { usage, .. } => break usage,
                _ => continue,
            }
        };
        assert_eq!(usage.output_tokens, 10);
        // Persisted for get_task_usage after a restart.
        let stored = f.signals.inner.usage_repo.get(&f.workspace.id).await.unwrap().unwrap();
        assert_eq!(stored.output_tokens, 10);

        // More usage + dirty, but inside the 5s window: no second event.
        std::fs::write(&path, line("m1", 10) + &line("m2", 5)).unwrap();
        // Bind first: a lock guard in the argument would live across the call.
        let generation = f.signals.inner.tasks.lock()[&f.workspace.id].generation;
        f.signals.mark_output(&f.workspace.id, generation);
        f.signals.poll_usage_once().await;
        assert!(!std::iter::from_fn(|| rx.try_recv().ok())
            .any(|e| matches!(e, AgentSignalEvent::Usage { .. })));

        // The command path reads through immediately.
        let row = f.workspaces.get(&f.workspace.id).await.unwrap();
        assert_eq!(f.signals.usage_for(&row).await.unwrap().output_tokens, 15);
    }

    fn launch_task(f: &Fixture, agent: Agent, command: &str, resuming: bool) -> LaunchTask {
        LaunchTask {
            task_id: f.workspace.id.clone(),
            agent,
            command: command.into(),
            prompt: Some("fix the bug".into()),
            resuming,
            target: TranscriptTarget {
                agent,
                cwd: PathBuf::from(f.workspace.worktree_path.clone().unwrap()),
                since: Some(f.workspace.created_at),
                session_ids: vec![],
                shared_cwd: false,
            },
            policy: AgentPolicy::default(),
        }
    }

    #[tokio::test]
    async fn prepare_launch_adds_hooks_and_resumes_without_the_prompt() {
        let f = fixture(Agent::Claude).await;
        let fresh = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Claude, "claude --permission-mode acceptEdits", false))
            .await;
        assert!(fresh.command.starts_with("claude --settings '"), "{}", fresh.command);
        assert!(fresh.command.ends_with("--permission-mode acceptEdits"));
        assert!(fresh.send_prompt);
        assert!(fresh.env.iter().any(|(k, v)| k == hook_bridge::ENV_TASK_ID && *v == f.workspace.id));

        // Resume with no session and no transcript: a fresh start.
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Claude, "claude", true))
            .await;
        assert!(plan.send_prompt);
        assert!(!plan.command.contains("--resume") && !plan.command.contains("--continue"));

        f.workspaces
            .set_agent_session_id(&f.workspace.id, "8f0c6f3e-1111-4222-8333-944455556666")
            .await
            .unwrap();
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Claude, "claude", true))
            .await;
        assert!(
            plan.command.starts_with("claude --resume 8f0c6f3e-1111-4222-8333-944455556666 --settings "),
            "{}",
            plan.command
        );
        assert!(!plan.send_prompt);

        // A wrapper we can't inject into: unchanged, prompt still sent.
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Claude, "./my-claude-wrapper.sh", true))
            .await;
        assert_eq!(plan.command, "./my-claude-wrapper.sh");
        assert!(plan.send_prompt && plan.env.is_empty());

        // A template that embeds the prompt gets it on the command line
        // only — never typed again (fresh launch or resume).
        let embedded = crate::orchestrator::launch::interpolate_for_task("claude {{prompt}}", Some("fix the bug"));
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Claude, &embedded, false))
            .await;
        assert!(!plan.send_prompt, "{}", plan.command);
        assert!(plan.command.contains("'fix the bug'"));
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Gemini, "gemini {{prompt}}", false))
            .await;
        assert!(plan.send_prompt, "no prompt in this command");

        // Codex gets notify; agents without hooks are untouched.
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Codex, "codex -s read-only", false))
            .await;
        assert!(plan.command.starts_with("codex -c 'notify=["), "{}", plan.command);
        let plan = f
            .signals
            .prepare_launch(&launch_task(&f, Agent::Gemini, "gemini --yolo", true))
            .await;
        assert_eq!(plan.command, "gemini --yolo");
        assert!(plan.env.is_empty() && plan.send_prompt);
    }

    #[test]
    fn keystrokes_split_on_escape_sequences_and_chars() {
        assert_eq!(split_keystrokes("\x1b[B\r"), vec!["\x1b[B", "\r"]);
        assert_eq!(split_keystrokes("\x1b[B\x1b[B\r"), vec!["\x1b[B", "\x1b[B", "\r"]);
        assert_eq!(split_keystrokes("\x1b"), vec!["\x1b"]);
        assert_eq!(split_keystrokes("1"), vec!["1"]);
        assert_eq!(split_keystrokes("\x1bOB\x1b[1;5A"), vec!["\x1bOB", "\x1b[1;5A"]);
        assert_eq!(split_keystrokes("é\r"), vec!["é", "\r"]);
        assert!(split_keystrokes("").is_empty());
    }

    const TRUST_FIXTURE: &[u8] = include_bytes!("fixtures/claude-2.1.319-trust.ansi");

    /// Feed `bytes` to the task's tail as the detector would.
    fn push_output(f: &Fixture, bytes: &[u8]) {
        let tail = f.signals.inner.tasks.lock()[&f.workspace.id].tail.clone();
        tail.lock().push(bytes);
    }

    /// Poll the gate like `run_initial_writes` does until it stops saying
    /// Wait or `max` passes (then: Wait).
    async fn gate_after(gate: &Arc<dyn PromptGate>, max: Duration) -> PromptGateDecision {
        let until = Instant::now() + max;
        loop {
            let decision = gate.check();
            if decision != PromptGateDecision::Wait || Instant::now() >= until {
                return decision;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn prompt_gate_holds_for_trust_raises_a_card_and_opens_after_allow() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let generation = f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let gate = f.signals.prompt_gate(&f.workspace.id, generation).unwrap();

        push_output(&f, TRUST_FIXTURE);
        // Held well past the settle period, with the card up immediately.
        assert_eq!(gate_after(&gate, Duration::from_millis(900)).await, PromptGateDecision::Wait);
        let state = f.signals.state(&f.workspace.id).unwrap();
        assert_eq!(state.state, AgentStateKind::NeedsYou);
        let attention = state.attention.unwrap();
        assert_eq!(attention.kind, AttentionKind::Trust);
        assert_eq!(attention.title, "Trust this folder?");
        assert_eq!(attention.detail.as_deref(), Some(cwd.to_str().unwrap()));
        assert!(attention.can_respond);

        // Allow → Down, Enter (never the generic "1").
        let keys = f
            .signals
            .claim_attention(&f.workspace.id, &attention.id, AttentionResponse::AllowOnce)
            .unwrap();
        assert_eq!(keys, "\x1b[B\r");
        // Nothing has repainted yet: still held.
        assert_eq!(gate_after(&gate, Duration::from_millis(600)).await, PromptGateDecision::Wait);
        // The composer replaces the dialog → open once it settles.
        push_output(&f, b"\x1b[2J\x1b[H> \x1b[?25l");
        assert_eq!(gate_after(&gate, Duration::from_secs(3)).await, PromptGateDecision::Proceed);
    }

    #[tokio::test]
    async fn prompt_gate_drops_the_prompt_when_trust_is_denied() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let generation = f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let gate = f.signals.prompt_gate(&f.workspace.id, generation).unwrap();
        push_output(&f, TRUST_FIXTURE);
        assert_eq!(gate_after(&gate, Duration::from_millis(900)).await, PromptGateDecision::Wait);
        let attention = f.signals.state(&f.workspace.id).unwrap().attention.unwrap();
        let keys = f
            .signals
            .claim_attention(&f.workspace.id, &attention.id, AttentionResponse::Deny)
            .unwrap();
        assert_eq!(keys, "\x1b");
        assert_eq!(gate.check(), PromptGateDecision::Abandon);
    }

    #[tokio::test]
    async fn prompt_gate_answered_in_the_terminal_with_esc_drops_the_prompt() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let generation = f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let gate = f.signals.prompt_gate(&f.workspace.id, generation).unwrap();
        push_output(&f, TRUST_FIXTURE);
        assert_eq!(gate_after(&gate, Duration::from_millis(900)).await, PromptGateDecision::Wait);
        f.signals.note_user_input(&f.workspace.id, b"\x1b");
        assert_eq!(gate.check(), PromptGateDecision::Abandon);
    }

    #[tokio::test]
    async fn prompt_gate_opens_without_a_dialog_and_only_exists_for_trust_agents() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let generation = f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let gate = f.signals.prompt_gate(&f.workspace.id, generation).unwrap();
        // Nothing seen yet: held (bounded), not waved through.
        assert_eq!(gate.check(), PromptGateDecision::Wait);
        push_output(&f, b"\x1b[?25l> Try \"fix lint errors\"\r\n");
        assert_eq!(gate_after(&gate, Duration::from_secs(3)).await, PromptGateDecision::Proceed);
        // A re-registration (new PTY) retires the old gate.
        f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        assert_eq!(gate.check(), PromptGateDecision::Abandon);

        let codex = fixture(Agent::Codex).await;
        let cwd = PathBuf::from(codex.workspace.worktree_path.clone().unwrap());
        let generation = codex.signals.register_task(&codex.workspace, Agent::Codex, &cwd, None);
        assert!(codex.signals.prompt_gate(&codex.workspace.id, generation).is_none());
    }

    #[test]
    fn terminal_reports_are_not_user_input() {
        assert!(!is_meaningful_input(b"\x1b[I"));
        assert!(!is_meaningful_input(b"\x1b[O"));
        assert!(!is_meaningful_input(b"\x1b[<0;12;5M"));
        assert!(!is_meaningful_input(b"\x1b[M !!"));
        assert!(!is_meaningful_input(b""));
        // Auto-replies to the agent's queries.
        assert!(!is_meaningful_input(b"\x1b[12;40R"), "CPR");
        assert!(!is_meaningful_input(b"\x1b[?1;2c"), "DA1");
        assert!(!is_meaningful_input(b"\x1b[>0;276;0c"), "DA2");
        assert!(!is_meaningful_input(b"\x1b[?0u"), "kitty keyboard flags");
        assert!(!is_meaningful_input(b"\x1b[?2026;2$y"), "DECRPM");
        assert!(!is_meaningful_input(b"\x1bP>|xterm.js(5.5.0)\x1b\\"), "XTVERSION (DCS)");
        assert!(!is_meaningful_input(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07"), "OSC (BEL)");
        assert!(!is_meaningful_input(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"), "OSC (ST)");
        // Several in one write.
        assert!(!is_meaningful_input(b"\x1b[?0u\x1bP>|xterm.js(5.5.0)\x1b\\\x1b[?62;22c\x1b[I"));
        // The user.
        assert!(is_meaningful_input(b"1"));
        assert!(is_meaningful_input(b"\x1b"));
        assert!(is_meaningful_input(b"\x1b[A"));
        assert!(is_meaningful_input(b"\x1b[B\r"));
        assert!(is_meaningful_input(b"\r"));
        assert!(is_meaningful_input(b"\x1bP"), "Alt+P is not an unterminated DCS reply");
        assert!(is_meaningful_input(b"\x1b[?1;2cy"), "a reply followed by a key is input");
        assert!(is_meaningful_input(b"\x1b[3~"), "Delete key");
    }

    /// The webview answers the trust dialog's DA1 query through the same
    /// path as keystrokes. That reply must not count as the user reacting:
    /// the trust card is still raised and the prompt is still held.
    #[tokio::test]
    async fn trust_dialog_followed_by_a_da1_reply_still_raises_the_card() {
        let f = fixture(Agent::Claude).await;
        let cwd = PathBuf::from(f.workspace.worktree_path.clone().unwrap());
        let generation = f.signals.register_task(&f.workspace, Agent::Claude, &cwd, None);
        let gate = f.signals.prompt_gate(&f.workspace.id, generation).unwrap();
        push_output(&f, TRUST_FIXTURE);
        // Arrives within ms of the dialog, before GATE_SETTLE.
        f.signals.note_user_input(&f.workspace.id, b"\x1b[?1;2c");
        f.signals.note_user_input(&f.workspace.id, b"\x1b[?0u\x1bP>|xterm.js(5.5.0)\x1b\\");
        assert_eq!(gate_after(&gate, Duration::from_millis(900)).await, PromptGateDecision::Wait);
        let state = f.signals.state(&f.workspace.id).unwrap();
        assert_eq!(state.state, AgentStateKind::NeedsYou);
        assert_eq!(state.attention.unwrap().kind, AttentionKind::Trust);
        // Still held well past the old 30 s blind-type path's trigger point
        // would matter: nothing here lets the prompt through.
        assert_eq!(gate.check(), PromptGateDecision::Wait);
    }
}
