//! Claude in headless stream mode: the process behind a task's transcript
//! view (spec `agent-transcript-view-spec.md`).
//!
//!   AgentStreams ┐  per app: task id → live StreamHandle, the transcript
//!                │  store, and one `tokio::broadcast` of TranscriptEvents
//!   StreamHandle ┐  one `claude -p --input-format stream-json …` process
//!                │  ├── pipes, not a PTY; its own process group
//!                │  ├── stdout → NDJSON lines → Normalizer → items/effects
//!                │  ├── stdin  ← user messages, control responses, interrupt
//!                │  └── stderr → the task log (and the exit message)
//!
//! Like the orchestrator this is Tauri-agnostic: `commands::events` bridges
//! the broadcast onto `phasr://transcript`, and agent state goes through
//! `AgentSignals`, so the board, sidebar, notifications and approvals work
//! exactly as for a terminal task. The orchestrator decides WHEN a stream
//! runs (launch, resume, stop, view switch); this module only runs it.

pub mod normalize;
pub mod protocol;
pub mod transcript;

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use chrono::Utc;
use parking_lot::Mutex;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;

use crate::agent_signals::{AgentSignalError, AgentSignals, AttentionResponse};
use crate::domain::usage::{TaskUsage, UsageSource};

use normalize::{Normalizer, Output, PermissionRequest, TurnEnd};
pub use transcript::{SystemLevel, TranscriptEvent, TranscriptItem, TranscriptOp, TranscriptStore};

const EVENT_CAPACITY: usize = 1024;
/// Streaming text reaches listeners at most this often per task (≤ 30 Hz).
/// The final update of a block is never held back.
const DELTA_INTERVAL: Duration = Duration::from_millis(33);
/// After the process exits, how long its stdout may still drain.
const DRAIN_GRACE: Duration = Duration::from_millis(500);
/// One stdout line is cut at this size (it then fails to parse and is
/// skipped): a runaway line must not grow memory without bound.
const MAX_LINE: usize = 32 * 1024 * 1024;
/// stderr lines kept for the "Claude exited" message.
const STDERR_TAIL: usize = 12;
/// Lines in flight from the stdout reader to the session loop.
const LINE_QUEUE: usize = 256;

#[derive(Debug, Error)]
pub enum StreamError {
    #[error("couldn't start Claude: {0}")]
    Spawn(String),
    #[error("Claude is already running for this task")]
    AlreadyRunning,
    #[error("Claude isn't running for this task")]
    NotRunning,
    #[error("couldn't reach Claude: {0}")]
    Write(String),
    #[error(transparent)]
    Signals(#[from] AgentSignalError),
}

impl serde::Serialize for StreamError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Everything needed to start one stream process.
pub struct StreamSpec {
    pub task_id: String,
    pub cwd: PathBuf,
    /// The full shell line (`protocol::stream_command`), run as
    /// `/bin/sh -c 'exec <command>'`.
    pub command: String,
    /// Added on top of the terminal environment and the login PATH (the
    /// agent's API key).
    pub env: Vec<(String, String)>,
    /// Sent as the first user message once the process is up.
    pub first_message: Option<String>,
    /// The `AgentSignals` registration this process reports to.
    pub signals: Option<(AgentSignals, u64)>,
}

struct Shared {
    events: broadcast::Sender<TranscriptEvent>,
    store: TranscriptStore,
    log_dir: PathBuf,
}

/// The app's stream processes, keyed by task id.
#[derive(Clone)]
pub struct AgentStreams {
    shared: Arc<Shared>,
    running: Arc<Mutex<HashMap<String, Arc<StreamHandle>>>>,
    /// Taken out of `running` while still shutting down; app quit must
    /// still reach them.
    retiring: Arc<Mutex<Vec<Weak<StreamHandle>>>>,
}

impl AgentStreams {
    /// `log_dir`: where transcripts (`<task>.transcript.jsonl`) and task
    /// logs (`<task>.log`, which gets the CLI's stderr) live.
    pub fn new(log_dir: PathBuf) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            shared: Arc::new(Shared {
                events,
                store: TranscriptStore::new(log_dir.clone()),
                log_dir,
            }),
            running: Arc::new(Mutex::new(HashMap::new())),
            retiring: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TranscriptEvent> {
        self.shared.events.subscribe()
    }

    pub fn get(&self, task_id: &str) -> Option<Arc<StreamHandle>> {
        self.running.lock().get(task_id).cloned()
    }

    /// Whether `handle` is still the process registered for its task.
    pub fn is_current(&self, handle: &Arc<StreamHandle>) -> bool {
        self.get(&handle.task_id)
            .is_some_and(|current| Arc::ptr_eq(&current, handle))
    }

    /// Forget a task's process (after it exited, or once it's retired).
    pub fn drop_task(&self, task_id: &str) {
        self.running.lock().remove(task_id);
    }

    /// Take the task's process out of the map while it shuts down, so a
    /// resume during that window starts fresh instead of reusing it.
    pub fn retire(&self, task_id: &str) -> Option<Arc<StreamHandle>> {
        let handle = self.running.lock().remove(task_id)?;
        let mut retiring = self.retiring.lock();
        retiring.retain(|w| w.strong_count() > 0);
        retiring.push(Arc::downgrade(&handle));
        Some(handle)
    }

    /// `(task id, last stdout line, epoch ms)` per live process.
    pub fn activity(&self) -> Vec<(String, i64)> {
        self.running
            .lock()
            .iter()
            .map(|(id, h)| (id.clone(), h.last_event_ms.load(Ordering::Relaxed)))
            .collect()
    }

    /// The task's transcript: the persisted file with every update folded
    /// in, plus what a live process has open right now (streaming text,
    /// running tools). Without a live process, nothing is open any more.
    pub fn transcript(&self, task_id: &str) -> Vec<TranscriptItem> {
        let mut items = self.shared.store.load(task_id);
        match self.get(task_id) {
            Some(handle) => {
                let open = handle.session.lock().normalizer.open_items();
                for item in open {
                    match items.iter_mut().find(|i| i.id() == item.id()) {
                        Some(slot) => *slot = item,
                        None => items.push(item),
                    }
                }
                items
            }
            None => items.into_iter().map(TranscriptItem::settled).collect(),
        }
    }

    /// Add a line of Phasr's own to a task's transcript (persisted, emitted).
    pub fn note(&self, task_id: &str, level: SystemLevel, text: &str) {
        publish(
            &self.shared,
            task_id,
            TranscriptOp::Append,
            TranscriptItem::system(level, text, transcript::now_ts()),
            true,
        );
    }

    /// Start `spec`'s process. Fails if one already runs for the task.
    pub async fn spawn(&self, spec: StreamSpec) -> Result<Arc<StreamHandle>, StreamError> {
        if self.running.lock().contains_key(&spec.task_id) {
            return Err(StreamError::AlreadyRunning);
        }
        let shell = crate::pty::resolve_shell();
        let path = crate::pty::login_path().await;
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!("exec {}", spec.command))
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        // The terminal's environment (minus phasr's own runtime keys) and
        // the login shell's PATH: what the agent sees when typed in a
        // terminal, without an interactive shell's rc noise on stdout.
        for (key, value) in crate::pty::terminal_env(&shell) {
            cmd.env(key, value);
        }
        cmd.env("PATH", path);
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        // Its own group: stop and app quit signal the CLI and everything it
        // started (its Bash tools) together, and a Ctrl-C in phasr's own
        // terminal never reaches it.
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| StreamError::Spawn(e.to_string()))?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.start_kill();
            return Err(StreamError::Spawn("the process has no pipes".into()));
        };
        let (exit_tx, _) = watch::channel(None);
        let handle = Arc::new(StreamHandle {
            task_id: spec.task_id.clone(),
            pgid: child.id(),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            session: Mutex::new(Session {
                normalizer: Normalizer::new(spec.cwd.to_string_lossy()),
                permissions: VecDeque::new(),
                pending_turns: 0,
                in_turn: false,
            }),
            exit: exit_tx,
            last_event_ms: AtomicI64::new(Utc::now().timestamp_millis()),
            stopping: AtomicBool::new(false),
            shared: self.shared.clone(),
            signals: spec.signals,
        });
        {
            let mut running = self.running.lock();
            if running.contains_key(&spec.task_id) {
                drop(running);
                handle.terminate(Duration::from_secs(1));
                return Err(StreamError::AlreadyRunning);
            }
            running.insert(spec.task_id.clone(), handle.clone());
        }
        let lines = spawn_line_reader(stdout);
        let stderr_tail = spawn_stderr_reader(stderr, self.shared.log_dir.join(format!("{}.log", spec.task_id)));
        tokio::spawn(handle.clone().run(child, lines, stderr_tail));
        if let Some(text) = spec.first_message {
            handle.send(&text).await?;
        }
        Ok(handle)
    }

    /// App quit: SIGTERM every stream's process group, wait (≤ `grace`) for
    /// them to go, SIGKILL the rest. Blocking.
    pub fn terminate_all_blocking(&self, grace: Duration) {
        let handles: Vec<Arc<StreamHandle>> = {
            let running = self.running.lock();
            running
                .values()
                .cloned()
                .chain(self.retiring.lock().iter().filter_map(Weak::upgrade))
                .collect()
        };
        let groups: Vec<u32> = handles
            .iter()
            .filter(|h| !h.has_exited())
            .filter_map(|h| {
                h.stopping.store(true, Ordering::Relaxed);
                h.pgid
            })
            .collect();
        terminate_groups_blocking(&groups, grace);
    }
}

/// One stream process. Cheap to share; every method is safe to call after
/// the process died (writes then fail with `NotRunning`).
pub struct StreamHandle {
    pub task_id: String,
    pgid: Option<u32>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    session: Mutex<Session>,
    /// `Some(exit code)` once the process is gone and its output settled.
    exit: watch::Sender<Option<Option<i64>>>,
    last_event_ms: AtomicI64,
    /// Stop / quit / view switch: the exit is expected, not news.
    stopping: AtomicBool,
    shared: Arc<Shared>,
    signals: Option<(AgentSignals, u64)>,
}

struct Session {
    normalizer: Normalizer,
    /// Permission requests in arrival order; the front one is the card.
    permissions: VecDeque<Pending>,
    /// Messages sent whose turn hasn't ended (the CLI queues them).
    pending_turns: usize,
    in_turn: bool,
}

struct Pending {
    request: PermissionRequest,
    /// The card's id once raised (only the front request is).
    attention_id: Option<String>,
}

fn publish(shared: &Shared, task_id: &str, op: TranscriptOp, item: TranscriptItem, persist: bool) {
    if persist {
        shared.store.append(task_id, op, &item);
    }
    let _ = shared.events.send(TranscriptEvent {
        task_id: task_id.to_string(),
        op,
        item,
    });
}

impl StreamHandle {
    pub fn has_exited(&self) -> bool {
        self.exit.borrow().is_some()
    }

    /// Whether a turn is running (or queued): a view switch now would cut
    /// it off.
    pub fn turn_running(&self) -> bool {
        let session = self.session.lock();
        session.in_turn || session.pending_turns > 0
    }

    /// Wait until the process is gone; its exit code (`None` = killed).
    pub async fn wait_exit(&self) -> Option<i64> {
        let mut rx = self.exit.subscribe();
        loop {
            if let Some(code) = *rx.borrow_and_update() {
                return code;
            }
            if rx.changed().await.is_err() {
                return None;
            }
        }
    }

    fn signals(&self) -> Option<(&AgentSignals, u64)> {
        self.signals.as_ref().map(|(s, g)| (s, *g))
    }

    fn publish(&self, op: TranscriptOp, item: TranscriptItem, persist: bool) {
        publish(&self.shared, &self.task_id, op, item, persist);
    }

    async fn write_line(&self, line: &str) -> Result<(), StreamError> {
        let mut stdin = self.stdin.lock().await;
        let pipe = stdin.as_mut().ok_or(StreamError::NotRunning)?;
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        let written = async {
            pipe.write_all(&bytes).await?;
            pipe.flush().await
        }
        .await;
        written.map_err(|err| match err.kind() {
            std::io::ErrorKind::BrokenPipe => StreamError::NotRunning,
            _ => StreamError::Write(err.to_string()),
        })
    }

    /// Send one user message. It shows in the transcript at once; Claude
    /// queues it behind a running turn.
    pub async fn send(&self, text: &str) -> Result<(), StreamError> {
        if self.has_exited() {
            return Err(StreamError::NotRunning);
        }
        let item = {
            let mut session = self.session.lock();
            session.pending_turns += 1;
            session.in_turn = true;
            session.normalizer.user_sent(text, Utc::now())
        };
        if let Output::Item { op, item, .. } = item {
            self.publish(op, item, true);
        }
        if let Some((signals, generation)) = self.signals() {
            signals.stream_working(&self.task_id, generation, None);
        }
        if let Err(err) = self.write_line(&protocol::user_message(text)).await {
            {
                let mut session = self.session.lock();
                session.pending_turns = session.pending_turns.saturating_sub(1);
                session.in_turn = session.pending_turns > 0;
            }
            self.publish(
                TranscriptOp::Append,
                TranscriptItem::system(
                    SystemLevel::Error,
                    format!("This message didn't reach Claude: {err}"),
                    transcript::now_ts(),
                ),
                true,
            );
            return Err(err);
        }
        Ok(())
    }

    /// Interrupt the running turn (the CLI's own interrupt; the session
    /// lives on). Nothing to do between turns.
    pub async fn interrupt(&self) -> Result<(), StreamError> {
        if self.has_exited() {
            return Err(StreamError::NotRunning);
        }
        if !self.turn_running() {
            return Ok(());
        }
        let request_id = format!("phasr-interrupt-{}", transcript::new_id());
        self.write_line(&protocol::interrupt_request(&request_id)).await
    }

    /// Answer the permission card `attention_id`: the control response the
    /// CLI is waiting for. A card that isn't the current one (answered,
    /// withdrawn, superseded) is `stale attention` and sends nothing.
    pub async fn respond(
        &self,
        attention_id: &str,
        response: AttentionResponse,
    ) -> Result<(), StreamError> {
        let line = {
            let mut session = self.session.lock();
            let Some(head) = session
                .permissions
                .front()
                .filter(|p| p.attention_id.as_deref() == Some(attention_id))
            else {
                return Err(AgentSignalError::StaleAttention.into());
            };
            let rules = protocol::session_rules(&head.request.suggestions);
            if response == AttentionResponse::AllowTask && rules.is_empty() {
                return Err(AgentSignalError::AllowTaskUnavailable.into());
            }
            // The registry's claim is the atomic one (a double click, the
            // notification's button racing the card).
            if let Some((signals, _)) = self.signals() {
                signals.claim_stream_attention(&self.task_id, attention_id, response)?;
            }
            let Some(Pending { request, .. }) = session.permissions.pop_front() else {
                return Err(AgentSignalError::StaleAttention.into());
            };
            let line = match response {
                AttentionResponse::AllowOnce => {
                    protocol::allow_response(&request.request_id, &request.input, &[])
                }
                AttentionResponse::AllowTask => {
                    protocol::allow_response(&request.request_id, &request.input, &rules)
                }
                AttentionResponse::Deny => {
                    if let Some(tool_use_id) = &request.tool_use_id {
                        session.normalizer.note_denied(tool_use_id);
                    }
                    protocol::deny_response(&request.request_id)
                }
            };
            self.raise_next(&mut session);
            line
        };
        self.write_line(&line).await
    }

    /// Raise the front permission request as the task's card, if it isn't.
    fn raise_next(&self, session: &mut Session) {
        let Some(front) = session.permissions.front_mut() else {
            return;
        };
        if front.attention_id.is_some() {
            return;
        }
        let can_allow_for_task = !protocol::session_rules(&front.request.suggestions).is_empty();
        front.attention_id = match self.signals() {
            Some((signals, generation)) => signals.stream_permission(
                &self.task_id,
                generation,
                &front.request.tool_name,
                &front.request.input,
                can_allow_for_task,
            ),
            // Without a registry (tests), the request is still answerable.
            None => Some(transcript::new_id()),
        };
    }

    /// Stop the process: SIGTERM its group now, SIGKILL after `grace` if
    /// it's still there. Returns at once.
    pub fn terminate(&self, grace: Duration) {
        self.stopping.store(true, Ordering::Relaxed);
        let Some(pgid) = self.pgid else {
            return;
        };
        if self.has_exited() {
            return;
        }
        #[cfg(unix)]
        crate::util::proc::signal_process_group(pgid, libc::SIGTERM);
        let exit = self.exit.subscribe();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + grace;
            while std::time::Instant::now() < deadline {
                if exit.borrow().is_some() || !group_alive(pgid) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            #[cfg(unix)]
            crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
        });
    }

    /// The session loop: stdout lines through the normalizer, effects out,
    /// deltas coalesced; then, once the process is gone, settle.
    async fn run(
        self: Arc<Self>,
        mut child: tokio::process::Child,
        mut lines: mpsc::Receiver<Vec<u8>>,
        stderr_tail: tokio::task::JoinHandle<VecDeque<String>>,
    ) {
        let mut deltas = Coalescer::default();
        let mut exited: Option<Option<i64>> = None;
        let mut drain_until: Option<Instant> = None;
        loop {
            let flush_at = deltas.deadline();
            tokio::select! {
                line = lines.recv() => match line {
                    Some(line) => {
                        self.last_event_ms.store(Utc::now().timestamp_millis(), Ordering::Relaxed);
                        let Some(event) = normalize::parse_line(&line) else { continue };
                        let outputs = self.session.lock().normalizer.feed(&event, Utc::now());
                        self.apply(outputs, &mut deltas).await;
                    }
                    None => break,
                },
                status = child.wait(), if exited.is_none() => {
                    exited = Some(status.ok().and_then(|s| s.code()).map(i64::from));
                    drain_until = Some(Instant::now() + DRAIN_GRACE);
                }
                _ = tokio::time::sleep_until(flush_at.unwrap_or_else(Instant::now)), if flush_at.is_some() => {
                    self.flush(&mut deltas);
                }
                _ = tokio::time::sleep_until(drain_until.unwrap_or_else(Instant::now)), if drain_until.is_some() => break,
            }
        }
        // No more writes can land: a late send fails fast instead of
        // blocking on a pipe nobody reads.
        self.stdin.lock().await.take();
        let code = match exited {
            Some(code) => code,
            None => child.wait().await.ok().and_then(|s| s.code()).map(i64::from),
        };
        self.flush(&mut deltas);
        let settled = {
            let mut session = self.session.lock();
            session.permissions.clear();
            session.pending_turns = 0;
            session.in_turn = false;
            session.normalizer.settle(Utc::now())
        };
        for out in settled {
            if let Output::Item { op, item, .. } = out {
                self.publish(op, item, true);
            }
        }
        let tail = tokio::time::timeout(Duration::from_secs(1), stderr_tail)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if !self.stopping.load(Ordering::Relaxed) {
            let (level, mut text) = match code {
                Some(0) => (SystemLevel::Info, "Claude's session ended.".to_string()),
                Some(code) => (SystemLevel::Error, format!("Claude exited with code {code}.")),
                None => (SystemLevel::Error, "Claude was killed.".to_string()),
            };
            if level == SystemLevel::Error && !tail.is_empty() {
                text.push('\n');
                text.push_str(&tail.into_iter().collect::<Vec<_>>().join("\n"));
            }
            self.publish(
                TranscriptOp::Append,
                TranscriptItem::system(level, text, transcript::now_ts()),
                true,
            );
        }
        let _ = self.exit.send(Some(code));
    }

    fn flush(&self, deltas: &mut Coalescer) {
        for item in deltas.take() {
            self.publish(TranscriptOp::Update, item, false);
        }
    }

    async fn apply(&self, outputs: Vec<Output>, deltas: &mut Coalescer) {
        for out in outputs {
            match out {
                Output::Item {
                    item, delta: true, ..
                } => {
                    if deltas.push(item) {
                        self.flush(deltas);
                    }
                }
                Output::Item { op, item, .. } => {
                    // A final update supersedes its pending delta; others
                    // go out first, so the order on the wire is kept.
                    deltas.forget(item.id());
                    self.flush(deltas);
                    self.publish(op, item, true);
                }
                Output::Session(id) => {
                    if let Some((signals, generation)) = self.signals() {
                        signals.stream_session(&self.task_id, generation, &id).await;
                    }
                }
                Output::TurnStarted => {
                    self.session.lock().in_turn = true;
                    if let Some((signals, generation)) = self.signals() {
                        signals.stream_working(&self.task_id, generation, None);
                    }
                }
                Output::ToolStarted { tool, input } => {
                    if let Some((signals, generation)) = self.signals() {
                        signals.stream_working(&self.task_id, generation, Some((&tool, &input)));
                    }
                }
                Output::ToolFinished { tool } => {
                    if let Some((signals, generation)) = self.signals() {
                        signals.stream_tool_finished(&self.task_id, generation, &tool);
                    }
                }
                Output::Permission(request) => {
                    let mut session = self.session.lock();
                    session.permissions.push_back(Pending {
                        request,
                        attention_id: None,
                    });
                    self.raise_next(&mut session);
                }
                Output::PermissionCancelled { request_id } => {
                    let mut session = self.session.lock();
                    let Some(at) = session
                        .permissions
                        .iter()
                        .position(|p| p.request.request_id == request_id)
                    else {
                        continue;
                    };
                    let cancelled = session.permissions.remove(at);
                    if let (Some(id), Some((signals, generation))) =
                        (cancelled.and_then(|p| p.attention_id), self.signals())
                    {
                        signals.stream_attention_cleared(&self.task_id, generation, &id);
                    }
                    self.raise_next(&mut session);
                }
                Output::UnsupportedControl { request_id } => {
                    let line = protocol::error_response(&request_id, "not supported by Phasr");
                    if let Err(err) = self.write_line(&line).await {
                        eprintln!("[stream] {}: can't answer a control request: {err}", self.task_id);
                    }
                }
                Output::TurnEnded(end) => self.turn_ended(end).await,
            }
        }
    }

    async fn turn_ended(&self, end: TurnEnd) {
        let idle = {
            let mut session = self.session.lock();
            session.pending_turns = session.pending_turns.saturating_sub(1);
            session.in_turn = session.pending_turns > 0;
            // Requests can't outlive their turn.
            session.permissions.clear();
            !session.in_turn
        };
        let Some((signals, generation)) = self.signals() else {
            return;
        };
        signals
            .stream_turn_ended(&self.task_id, generation, idle, end.last_text)
            .await;
        let usage = end.usage;
        let turn = TaskUsage {
            source: UsageSource::Claude,
            model: usage.model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            cost_usd_micros: usage.cost_usd.map(|usd| (usd * 1_000_000.0).round() as i64),
            cost_partial: usage.cost_usd.is_none(),
            updated_at: Utc::now(),
            transcript_path: None,
        };
        signals.stream_usage(&self.task_id, generation, &turn).await;
    }
}

/// Streaming updates waiting for their ≤ 30 Hz slot, one per item.
#[derive(Default)]
struct Coalescer {
    pending: Vec<TranscriptItem>,
    last_flush: Option<Instant>,
}

impl Coalescer {
    /// Queue `item`'s latest state; `true` = its slot is now: flush.
    fn push(&mut self, item: TranscriptItem) -> bool {
        match self.pending.iter_mut().find(|p| p.id() == item.id()) {
            Some(slot) => *slot = item,
            None => self.pending.push(item),
        }
        self.last_flush
            .is_none_or(|at| at.elapsed() >= DELTA_INTERVAL)
    }

    fn deadline(&self) -> Option<Instant> {
        if self.pending.is_empty() {
            return None;
        }
        Some(self.last_flush.map_or_else(Instant::now, |at| at + DELTA_INTERVAL))
    }

    fn forget(&mut self, id: &str) {
        self.pending.retain(|p| p.id() != id);
    }

    fn take(&mut self) -> Vec<TranscriptItem> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        self.last_flush = Some(Instant::now());
        std::mem::take(&mut self.pending)
    }
}

/// stdout as lines, on their own task, so the session loop's `select!`
/// never cancels a half-read line. A partial last line (no newline before
/// EOF) is still delivered; an oversized one is cut (and then unparseable).
fn spawn_line_reader(stdout: tokio::process::ChildStdout) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel(LINE_QUEUE);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        while let Ok(chunk) = reader.fill_buf().await {
            if chunk.is_empty() {
                if !line.is_empty() {
                    let _ = tx.send(std::mem::take(&mut line)).await;
                }
                break;
            }
            let (part, used, done) = match chunk.iter().position(|b| *b == b'\n') {
                Some(at) => (&chunk[..at], at + 1, true),
                None => (chunk, chunk.len(), false),
            };
            let room = MAX_LINE.saturating_sub(line.len());
            line.extend_from_slice(&part[..part.len().min(room)]);
            reader.consume(used);
            if done && tx.send(std::mem::take(&mut line)).await.is_err() {
                break;
            }
        }
    });
    rx
}

/// stderr into the task log, keeping its last lines for the exit message.
fn spawn_stderr_reader(
    stderr: tokio::process::ChildStderr,
    log_path: PathBuf,
) -> tokio::task::JoinHandle<VecDeque<String>> {
    tokio::spawn(async move {
        let mut tail = VecDeque::new();
        let mut lines = BufReader::new(stderr).lines();
        let mut log = log_path
            .parent()
            .map(std::fs::create_dir_all)
            .and_then(Result::ok)
            .and_then(|_| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .ok()
            });
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(file) = log.as_mut() {
                let _ = writeln!(file, "{line}");
            }
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        tail
    })
}

#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    // SAFETY: signal 0 only probes whether any process is left in the group.
    libc::pid_t::try_from(pgid).is_ok_and(|g| g > 1 && unsafe { libc::killpg(g, 0) } == 0)
}

#[cfg(not(unix))]
fn group_alive(_pgid: u32) -> bool {
    false
}

fn terminate_groups_blocking(groups: &[u32], grace: Duration) {
    if groups.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        for &pgid in groups {
            crate::util::proc::signal_process_group(pgid, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline && groups.iter().any(|&g| group_alive(g)) {
            std::thread::sleep(Duration::from_millis(25));
        }
        for &pgid in groups {
            crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
}
