use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::broadcast;

use super::shell;

const REPLAY_BUFFER_BYTES: usize = 128 * 1024;

/// Event emitted by a running PTY task.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PtyEvent {
    /// A chunk of stdout/stderr output (PTYs merge them).
    Output {
        task_id: String,
        /// UTF-8 lossy decoding of the raw bytes; agents almost always emit
        /// UTF-8 and the loss only manifests as replacement chars for
        /// occasional non-UTF binary escapes.
        chunk: String,
    },
    /// Child process exited.
    Exit {
        task_id: String,
        exit_code: Option<i64>,
    },
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("task already running")]
    AlreadyRunning,
}

impl From<anyhow::Error> for PtyError {
    fn from(err: anyhow::Error) -> Self {
        PtyError::Pty(err.to_string())
    }
}

impl serde::Serialize for PtyError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct PtySpawnOptions {
    pub task_id: String,
    /// Optional command typed into the shell as if the user had entered
    /// it. Sent after a brief delay so the shell finishes initialising
    /// and shows its prompt first.
    pub initial_command: Option<String>,
    /// Optional prompt typed into the running command **after** it has
    /// started, then followed by `\n`. Use this for agents that take
    /// their prompt interactively (e.g. `claude --dangerously-skip-permissions`
    /// followed by the user's question).
    pub initial_prompt: Option<String>,
    pub cwd: PathBuf,
    pub log_path: PathBuf,
    pub rows: u16,
    pub cols: u16,
    /// Extra environment variables to set on the child, applied AFTER the
    /// terminal's own shaping (`shell::terminal_env`) so they win on a key
    /// clash. Empty for every ordinary spawn (start/open/run-command/session) so
    /// behavior is byte-identical; the scheduler's `spawn_ready_subtask` is the
    /// ONLY populator — it injects `PHASR_BIN`/`PHASR_SOCK`/`PHASR_TOKEN` so a
    /// ticket agent can advance its own board via `phasr <verb>` (CLI1 / §J3).
    pub env: Vec<(String, String)>,
}

/// Owns one running task's PTY. Cheaply cloneable (`Arc` inside).
pub struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Writer for the PTY's stdin. `MasterPty::take_writer()` is
    /// **one-shot**, so we take it once at spawn time and lock it for
    /// each write afterwards.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Separate killer handle. We have to hold this because the wait
    /// thread parks on `child.wait()` while holding the child mutex —
    /// calling `child.lock().kill()` from another thread would
    /// deadlock. `ChildKiller` lets us signal the child without going
    /// through that mutex.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    tx: broadcast::Sender<PtyEvent>,
    replay: Arc<Mutex<ReplayBuffer>>,
    /// Honest status (E0-T1): wall-clock ms of the most recent non-empty
    /// output chunk. Stamped on the byte-pump's hot path with a single
    /// relaxed atomic store — no lock, no DB — so the liveness poller can
    /// read "how long has this agent been silent" without touching the pump.
    /// Initialised to spawn time so a just-spawned agent reads as `Working`
    /// even before its first byte. `AtomicI64` because `Utc::now()` can
    /// legitimately drift; the poller only ever compares two wall-clock
    /// samples, so a monotonic clock isn't required here.
    last_activity: Arc<AtomicI64>,
}

impl PtyHandle {
    /// Spawns an interactive shell inside the PTY. Known user shells are
    /// launched as login shells so their normal terminal rc/history setup
    /// matches Terminal.app, iTerm, and Warp. If login launch fails, spawn
    /// retries with progressively more conservative fallbacks.
    ///
    /// If `initial_command` is set, it's typed into the shell after
    /// a brief delay (so the shell has time to print its prompt). The
    /// shell keeps running after the command finishes — the user can
    /// then run any other command (`ls`, `git status`, etc.) just like
    /// in Terminal.app.
    pub fn spawn(options: PtySpawnOptions) -> Result<Arc<Self>, PtyError> {
        let PtySpawnOptions {
            task_id,
            initial_command,
            initial_prompt,
            cwd,
            log_path,
            rows,
            cols,
            env,
        } = options;

        // Open the PTY and spawn the child.
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Pty(e.to_string()))?;

        let resolved_shell = shell::resolve_shell();
        let mut spawn_errors = Vec::new();
        let mut child = None;
        for launch in shell::spawn_candidates(&resolved_shell) {
            let mut cmd = CommandBuilder::new(&launch.shell);
            for arg in &launch.args {
                cmd.arg(arg);
            }
            cmd.cwd(&cwd);
            for (key, value) in shell::terminal_env(&launch.shell) {
                cmd.env(key, value);
            }
            // Caller-supplied env LAST so it overrides the terminal shaping on a
            // key clash (CLI1 injects PHASR_* here; empty for every other spawn).
            for (key, value) in &env {
                cmd.env(key, value);
            }

            match pty_pair.slave.spawn_command(cmd) {
                Ok(spawned) => {
                    child = Some(spawned);
                    break;
                }
                Err(err) => {
                    spawn_errors.push(format!(
                        "{} {}: {}",
                        launch.shell,
                        launch.args.join(" "),
                        err
                    ));
                }
            }
        }

        let child = child.ok_or_else(|| {
            PtyError::Pty(format!(
                "failed to spawn shell; attempted {}",
                spawn_errors.join("; ")
            ))
        })?;
        // Grab a kill handle BEFORE handing the child off to the
        // wait-thread mutex. The waiter parks on `wait()` while
        // holding the mutex; without this, `kill()` would deadlock.
        let killer = child.clone_killer();
        drop(pty_pair.slave);

        let master = pty_pair.master;
        let reader = master
            .try_clone_reader()
            .map_err(|e| PtyError::Pty(e.to_string()))?;
        // take_writer is one-shot per master — grab it now.
        let writer = master
            .take_writer()
            .map_err(|e| PtyError::Pty(e.to_string()))?;

        let (tx, _rx_initial) = broadcast::channel::<PtyEvent>(2048);

        let master = Arc::new(Mutex::new(master));
        let writer = Arc::new(Mutex::new(writer));
        let child = Arc::new(Mutex::new(child));

        let handle = Arc::new(Self {
            master,
            writer,
            killer: Mutex::new(killer),
            tx: tx.clone(),
            replay: Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_BUFFER_BYTES))),
            // Spawn time counts as the first "activity" so the agent reads
            // Working during its startup before any prompt output arrives.
            last_activity: Arc::new(AtomicI64::new(now_ms())),
        });

        // Schedule the agent command + optional prompt as keystrokes into the
        // running shell:
        //   1. Wait for the shell to finish printing its prompt, then "type" and
        //      ENTER the agent command.
        //   2. Deliver the prompt — but ONLY once the agent is input-ready
        //      (`deliver_prompt_when_ready`), not on a blind timer.
        //
        // Issue #2: the old path slept a FIXED ~1.2s and then typed the prompt.
        // On a slow launch (cold start, repo indexing, MCP init) the agent's TUI
        // wasn't listening yet, so the keystrokes were dropped and the agent sat
        // at an empty prompt forever — "running" but doing nothing. And a
        // multi-line prompt (every scheduled subtask: persona + brief + contract
        // handoff) was typed with its embedded newlines raw, so the TUI submitted
        // it one fragment at a time. Both are fixed below.
        let handle_for_writes = handle.clone();
        std::thread::spawn(move || {
            let launched_at = Instant::now();
            // Subscribe BEFORE typing the command so the readiness detector can't
            // miss the shell's tty-handoff (`ESC[?2004l`) that follows it.
            let ready_rx = handle_for_writes.subscribe();
            if let Some(cmd_text) = initial_command {
                let trimmed = cmd_text.trim();
                if !trimmed.is_empty() {
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = handle_for_writes.write(format!("{trimmed}\n").as_bytes());
                }
            }
            if let Some(prompt) = initial_prompt {
                let trimmed = prompt.trim();
                if !trimmed.is_empty() {
                    deliver_prompt_when_ready(&handle_for_writes, ready_rx, trimmed, launched_at);
                }
            }
        });

        // Ensure log dir exists; open log file for appending.
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;

        // Spawn the byte-pump on a dedicated blocking thread — the PTY
        // reader is sync and would block the async runtime.
        let task_id_for_thread = task_id.clone();
        let tx_for_thread = tx.clone();
        let replay_for_thread = handle.replay.clone();
        let last_activity_for_thread = handle.last_activity.clone();
        std::thread::Builder::new()
            .name(format!("phasr-pty-{task_id_for_thread}"))
            .spawn(move || {
                pump_pty_output(
                    task_id_for_thread,
                    reader,
                    log_file,
                    tx_for_thread,
                    replay_for_thread,
                    last_activity_for_thread,
                )
            })
            .map_err(PtyError::from)?;

        // Spawn a waiter thread that reports the exit code.
        let task_id_for_wait = task_id.clone();
        let child_for_wait = child.clone();
        let tx_for_wait = tx;
        std::thread::Builder::new()
            .name(format!("phasr-pty-wait-{task_id_for_wait}"))
            .spawn(move || {
                let exit_code = {
                    let mut guard = child_for_wait.lock();
                    guard.wait().ok().and_then(exit_status_to_code)
                };
                let _ = tx_for_wait.send(PtyEvent::Exit {
                    task_id: task_id_for_wait,
                    exit_code,
                });
            })
            .map_err(PtyError::from)?;

        Ok(handle)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PtyEvent> {
        self.tx.subscribe()
    }

    pub fn subscribe_with_replay(&self) -> (Vec<PtyEvent>, broadcast::Receiver<PtyEvent>) {
        let rx = self.tx.subscribe();
        let replay = self.replay.lock().snapshot();
        (replay, rx)
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), PtyError> {
        let mut writer = self.writer.lock();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), PtyError> {
        let master = self.master.lock();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Pty(e.to_string()))?;
        Ok(())
    }

    /// Best-effort SIGINT (Ctrl-C). Most agent CLIs treat this as "stop".
    pub fn interrupt(&self) -> Result<(), PtyError> {
        self.write(b"\x03")
    }

    /// Forcefully kills the child process. Signals via the separate
    /// `ChildKiller` handle so we don't block on the waiter thread's
    /// long-held lock on the child itself.
    pub fn kill(&self) -> Result<(), PtyError> {
        let mut killer = self.killer.lock();
        killer.kill().map_err(|e| PtyError::Pty(e.to_string()))?;
        Ok(())
    }

    /// Wall-clock ms of the most recent output chunk (or spawn time if the
    /// agent has been silent since launch). Read by the liveness poller to
    /// derive Working/Idle/Wedged. A single relaxed load — never blocks the
    /// pump.
    pub fn last_activity_ms(&self) -> i64 {
        self.last_activity.load(Ordering::Relaxed)
    }

    /// Backdate the activity stamp to simulate an agent that has been silent
    /// for a while — lets the poller tests exercise the Idle→Wedged timer
    /// transition deterministically without a real 3-minute sleep.
    #[cfg(test)]
    pub fn set_last_activity_ms(&self, ms: i64) {
        self.last_activity.store(ms, Ordering::Relaxed);
    }
}

/// Wall-clock milliseconds. Used for the activity stamp; must share the
/// same clock the liveness poller diffs against (`chrono::Utc`).
fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Timing gate for prompt delivery (issue #2). Prompt keystrokes are held until
/// the agent is actually INPUT-READY instead of firing on a blind fixed delay
/// that raced the agent's TUI startup and dropped the prompt.
struct PromptGate {
    /// Never deliver sooner than this after launch. Preserves the original
    /// ~1.5s floor (300ms shell-prompt wait + 1.2s launch) so a fast agent's
    /// timing is unchanged, and it steps past the shell's echo of the command.
    min_floor: Duration,
    /// Quiet window that marks "the agent stopped rendering its UI and is now
    /// waiting for input": a burst of startup output, then silence ⇒ ready.
    settle: Duration,
    /// Hard cap — deliver anyway if the agent never settles (e.g. an animated
    /// idle status line), so delivery can never hang. Bounds worst-case latency.
    max_wait: Duration,
}

impl Default for PromptGate {
    fn default() -> Self {
        Self {
            min_floor: Duration::from_millis(1_500),
            settle: Duration::from_millis(500),
            max_wait: Duration::from_secs(8),
        }
    }
}

/// The ALT-SCREEN enable (DECSET 1049) — a full-screen TUI's request to take
/// over the terminal. An interactive shell NEVER enters the alternate screen
/// (only a TUI does), which is exactly why this is the readiness signal.
const ALT_SCREEN_ENABLE: &[u8] = b"\x1b[?1049h";

/// Detects the moment an agent's full-screen TUI has taken over the terminal
/// (and is about to render its input box), from its PTY output: the ALT-SCREEN
/// enable (`ESC[?1049h`).
///
/// Why the alt-screen and NOT the bracketed-paste enable (`ESC[?2004h`) we tried
/// first: a fancy interactive shell (zsh + starship + syntax-highlighting /
/// autosuggestions) toggles paste mode REPEATEDLY while redrawing its prompt, so
/// a `2004l`→`2004h` pair fires BEFORE the agent ever takes over — delivering the
/// prompt straight into the shell (`zsh: command not found: …`, the regression a
/// real fancy shell exposed). The alt-screen enter has no such chrome to confuse
/// it: the shell stays on the primary screen throughout, and every real agent TUI
/// (verified: claude emits `ESC[?1049h` as its first act) switches to the alt
/// screen. An agent that never does simply never fires this and falls back to the
/// hard-cap timer — no worse than the old blind delay.
///
/// Pure and incremental (fed one chunk at a time) so it is unit-testable without
/// a real PTY. Carries a short tail across chunks so an escape split at a read
/// boundary is still matched.
struct ReadinessDetector {
    carry: Vec<u8>,
}

impl ReadinessDetector {
    fn new() -> Self {
        Self { carry: Vec::new() }
    }

    /// Feed one output chunk; returns `true` the first time the agent's TUI
    /// enters the alternate screen (input-ready).
    fn observe(&mut self, chunk: &[u8]) -> bool {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);

        if buf
            .windows(ALT_SCREEN_ENABLE.len())
            .any(|w| w == ALT_SCREEN_ENABLE)
        {
            self.carry.clear();
            return true;
        }

        // Keep a partial tail (< one full sequence) so an escape split across a
        // read boundary is still matched next round, without re-scanning a
        // complete sequence.
        let keep = ALT_SCREEN_ENABLE.len() - 1;
        if buf.len() > keep {
            self.carry = buf.split_off(buf.len() - keep);
        } else {
            self.carry = buf;
        }
        false
    }
}

/// Bracketed-paste DELIMITERS (the `200~`/`201~` markers that wrap the pasted
/// text itself — distinct from the mode toggles above). A terminal frames pasted
/// text in these so a TUI treats embedded newlines as LITERAL text rather than a
/// stream of Enter keys.
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// The bytes to type for the prompt BODY (the submitting `\r` is sent
/// separately, exactly as a real paste-then-Enter would be). A MULTI-LINE prompt
/// (personas, briefs, contract handoffs — every scheduled subtask) is wrapped in
/// a bracketed paste so its embedded newlines don't submit the prompt one
/// fragment at a time (issue #2). A single-line prompt is sent verbatim —
/// byte-identical to the original behavior, and safe even for a rare agent that
/// doesn't enable bracketed-paste mode.
fn frame_prompt(prompt: &str) -> Vec<u8> {
    if prompt.contains('\n') {
        let mut out = Vec::with_capacity(prompt.len() + PASTE_START.len() + PASTE_END.len());
        out.extend_from_slice(PASTE_START);
        out.extend_from_slice(prompt.as_bytes());
        out.extend_from_slice(PASTE_END);
        out
    } else {
        prompt.as_bytes().to_vec()
    }
}

/// Wait for the agent's TUI to signal it is input-ready (see `ReadinessDetector`),
/// then type the prompt as a single (paste-framed) unit and submit with Enter.
/// Runs on the injection thread. `launched_at` is when that thread began, so the
/// floor and cap are measured from launch. `rx` was subscribed BEFORE the launch
/// command was typed, so the handoff can't be missed.
fn deliver_prompt_when_ready(
    handle: &PtyHandle,
    mut rx: broadcast::Receiver<PtyEvent>,
    prompt: &str,
    launched_at: Instant,
) {
    let gate = PromptGate::default();
    let mut detector = ReadinessDetector::new();

    // Block on the readiness signal, bounded by the hard cap so delivery can
    // never hang for an agent that never emits it (we then fall back to typing
    // anyway — no worse than the old blind delay, just later).
    while launched_at.elapsed() < gate.max_wait {
        match rx.try_recv() {
            Ok(PtyEvent::Output { chunk, .. }) => {
                if detector.observe(chunk.as_bytes()) {
                    break;
                }
            }
            // The agent process died before we could hand it the prompt (a
            // launch failure) — nothing to deliver.
            Ok(PtyEvent::Exit { .. }) => return,
            Err(broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            // A verbose startup can outrun the buffer; the signal is likely
            // still ahead of us, so keep scanning.
            Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(broadcast::error::TryRecvError::Closed) => break,
        }
    }

    // Honor the floor (never type sooner than the original ~1.5s, so a fast
    // agent is unchanged) and let the just-rendered input box settle before we
    // paste into it.
    let floor_remaining = gate.min_floor.saturating_sub(launched_at.elapsed());
    if !floor_remaining.is_zero() {
        std::thread::sleep(floor_remaining);
    }
    std::thread::sleep(gate.settle);

    let _ = handle.write(&frame_prompt(prompt));
    // Submit. Most TUI agents accept a plain Enter; the tty translates \r → \n.
    std::thread::sleep(Duration::from_millis(60));
    let _ = handle.write(b"\r");
}

fn pump_pty_output(
    task_id: String,
    mut reader: Box<dyn Read + Send>,
    mut log_file: std::fs::File,
    tx: broadcast::Sender<PtyEvent>,
    replay: Arc<Mutex<ReplayBuffer>>,
    last_activity: Arc<AtomicI64>,
) {
    let mut buf = [0u8; 4096];
    // Holds the trailing bytes of an incomplete UTF-8 codepoint from the
    // previous read. PTY reads can split a multi-byte codepoint (box-drawing
    // chars used by TUIs are 3 bytes each) — decoding mid-codepoint
    // produces `` and corrupts xterm.js's column tracking.
    let mut pending: Vec<u8> = Vec::with_capacity(4);
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                if !pending.is_empty() {
                    // Honest status (E0-T1): a single relaxed atomic store —
                    // no lock, no DB — records that this agent just produced
                    // output. The liveness poller reads it out-of-band.
                    last_activity.store(now_ms(), Ordering::Relaxed);
                    let chunk = String::from_utf8_lossy(&pending).into_owned();
                    let event = PtyEvent::Output {
                        task_id: task_id.clone(),
                        chunk,
                    };
                    replay.lock().push(event.clone());
                    let _ = tx.send(event);
                    pending.clear();
                }
                break;
            }
            Ok(n) => {
                let slice = &buf[..n];
                let _ = log_file.write_all(slice);

                let combined: &[u8] = if pending.is_empty() {
                    slice
                } else {
                    pending.extend_from_slice(slice);
                    &pending[..]
                };
                let split = last_utf8_boundary(combined);
                let chunk = String::from_utf8_lossy(&combined[..split]).into_owned();
                let tail = combined[split..].to_vec();
                pending = tail;

                if !chunk.is_empty() {
                    // Honest status (E0-T1): stamp activity on the hot path
                    // with one relaxed atomic — no lock, no DB touch.
                    last_activity.store(now_ms(), Ordering::Relaxed);
                    // If no subscribers, the send fails — that's fine, we still
                    // wrote to the log.
                    let event = PtyEvent::Output {
                        task_id: task_id.clone(),
                        chunk,
                    };
                    replay.lock().push(event.clone());
                    let _ = tx.send(event);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

#[derive(Debug)]
struct ReplayBuffer {
    cap_bytes: usize,
    bytes: usize,
    events: std::collections::VecDeque<PtyEvent>,
}

impl ReplayBuffer {
    fn new(cap_bytes: usize) -> Self {
        Self {
            cap_bytes,
            bytes: 0,
            events: std::collections::VecDeque::new(),
        }
    }

    fn push(&mut self, event: PtyEvent) {
        let event_bytes = match &event {
            PtyEvent::Output { chunk, .. } => chunk.len(),
            PtyEvent::Exit { .. } => 0,
        };
        self.bytes += event_bytes;
        self.events.push_back(event);

        while self.bytes > self.cap_bytes {
            let Some(head) = self.events.pop_front() else {
                self.bytes = 0;
                break;
            };
            if let PtyEvent::Output { chunk, .. } = head {
                self.bytes = self.bytes.saturating_sub(chunk.len());
            }
        }
    }

    fn snapshot(&self) -> Vec<PtyEvent> {
        self.events.iter().cloned().collect()
    }
}

/// Returns the byte index at which to split `bytes` so the prefix ends on a
/// UTF-8 codepoint boundary (or contains only definitively invalid bytes that
/// can't become valid with more data). The suffix is held for the next read.
fn last_utf8_boundary(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => match e.error_len() {
            // Trailing bytes are incomplete — wait for more.
            None => e.valid_up_to(),
            // Definitively invalid bytes in the middle — emit everything lossy
            // rather than hold garbage forever.
            Some(_) => bytes.len(),
        },
    }
}

fn exit_status_to_code(status: portable_pty::ExitStatus) -> Option<i64> {
    if status.success() {
        Some(0)
    } else {
        // portable_pty doesn't expose the raw code separately on all
        // platforms; the Display impl shows "exit code: N" which is what
        // we surface for now.
        let s = status.to_string();
        s.split_whitespace()
            .last()
            .and_then(|tok| tok.parse::<i64>().ok())
            .or(Some(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn spawn_shell(dir: &std::path::Path) -> Arc<PtyHandle> {
        PtyHandle::spawn(PtySpawnOptions {
            task_id: "activity-test".into(),
            initial_command: None,
            initial_prompt: None,
            cwd: std::env::temp_dir(),
            log_path: dir.join("activity-test.log"),
            rows: 24,
            cols: 80,
            env: Vec::new(),
        })
        .expect("spawn a shell")
    }

    /// Drain output events until `needle` appears (or we time out).
    fn wait_for_output(rx: &mut broadcast::Receiver<PtyEvent>, needle: &str) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(PtyEvent::Output { chunk, .. }) if chunk.contains(needle) => return true,
                Ok(_) => {}
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return false,
            }
        }
        false
    }

    // E0-T1: a byte of output advances `last_activity_ms`. We backdate the
    // stamp to the epoch, force a fresh line of output via stdin, and assert
    // the stamp jumped forward to ~now — proving the pump stamps on output
    // (and only on output). Deterministic: after the backdate the ONLY thing
    // that can move the stamp off 0 is a new chunk, which the write forces.
    #[test]
    fn last_activity_advances_on_output() {
        let dir = tempfile::tempdir().unwrap();
        let handle = spawn_shell(dir.path());
        let mut rx = handle.subscribe();

        // Spawn time seeded the stamp to ~now.
        assert!(
            handle.last_activity_ms() > 0,
            "spawn should seed last_activity to a positive wall-clock ms"
        );

        // Backdate to the epoch, then force output the shell must echo/run.
        handle.set_last_activity_ms(0);
        handle.write(b"echo phasr-activity-marker\n").unwrap();

        assert!(
            wait_for_output(&mut rx, "phasr-activity-marker"),
            "the forced echo should reach the output pump"
        );

        let after = handle.last_activity_ms();
        assert!(
            after > 1_600_000_000_000,
            "output must re-stamp last_activity to a recent wall-clock ms, got {after}"
        );

        handle.kill().unwrap();
    }

    // CLI1 (§J3): a `PtySpawnOptions.env` entry reaches the spawned child. We set
    // a marker var, then `echo $VAR` in the login shell and assert the value comes
    // back — proving the injected `PHASR_*` env is actually inherited by the agent
    // process (the env-plumbing this whole feature hinges on).
    #[test]
    fn spawn_options_env_is_inherited_by_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let handle = PtyHandle::spawn(PtySpawnOptions {
            task_id: "env-test".into(),
            // Echo the injected var so its value shows up in the PTY output.
            initial_command: Some("echo marker=$PHASR_TEST_VAR; exit".into()),
            initial_prompt: None,
            cwd: std::env::temp_dir(),
            log_path: dir.path().join("env-test.log"),
            rows: 24,
            cols: 80,
            env: vec![("PHASR_TEST_VAR".into(), "phasr-marker-9137".into())],
        })
        .expect("spawn a shell with injected env");

        let mut rx = handle.subscribe();
        assert!(
            wait_for_output(&mut rx, "marker=phasr-marker-9137"),
            "the injected env var must be inherited and expand in the child shell"
        );

        let _ = handle.kill();
    }

    // Issue #2 (readiness gate): the detector fires on a paste-mode ENABLE that
    // follows the shell's tty-handoff DISABLE — and ONLY then. The shell's own
    // pre-handoff enable (prompt draw) must be ignored, which is the whole point
    // (it is the chrome a naive heuristic mistakes for the agent).
    #[test]
    fn readiness_detector_fires_on_alt_screen_enter() {
        let mut d = ReadinessDetector::new();
        // The shell's prompt chrome (paste-mode toggles, redraws) must NOT fire —
        // the shell never enters the alt screen.
        assert!(!d.observe(b"\x1b[?2004hshell prompt> claude\r\n"));
        assert!(!d.observe(b"running \x1b[?2004l\r\n"));
        // The agent's TUI enters the alt screen → input ready.
        assert!(d.observe(b"\x1b[?1049h\x1b[2J\x1b[H agent ui"));
    }

    // Bracketed-paste toggles are the shell's own chrome (zsh + syntax
    // highlighting) — they must NEVER be read as readiness (the regression fix).
    #[test]
    fn readiness_detector_ignores_shell_paste_chrome() {
        let mut d = ReadinessDetector::new();
        assert!(!d.observe(b"\x1b[?2004h"));
        assert!(!d.observe(b"redraw \x1b[?2004l more \x1b[?2004h chrome"));
    }

    // The alt-screen enter can share a chunk with other startup bytes.
    #[test]
    fn readiness_detector_fires_when_alt_screen_shares_a_chunk() {
        let mut d = ReadinessDetector::new();
        assert!(d.observe(b"\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?1049h\x1b[2J ready"));
    }

    // The mode escape can be split across two PTY reads (they cut at 4 KiB and
    // mid-codepoint); the carry must still match it.
    #[test]
    fn readiness_detector_matches_escape_split_across_chunks() {
        let mut d = ReadinessDetector::new();
        assert!(!d.observe(b"boot \x1b[?10")); // alt-screen enter, split ...
        assert!(d.observe(b"49h\x1b[2J> ")); // ... completes across the boundary
    }

    // Issue #2 (multi-line submit): a single-line prompt is byte-identical to the
    // pre-fix delivery; a multi-line prompt is wrapped in a bracketed paste so
    // its embedded newlines can never fire as per-line submits.
    #[test]
    fn frame_prompt_wraps_only_multiline_in_bracketed_paste() {
        assert_eq!(frame_prompt("do the thing"), b"do the thing".to_vec());

        let multi = "You are a backend engineer.\n\n---\n\nBuild the API.";
        let framed = frame_prompt(multi);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"\x1b[200~");
        expected.extend_from_slice(multi.as_bytes());
        expected.extend_from_slice(b"\x1b[201~");
        assert_eq!(framed, expected);
        // The newline stays INSIDE the paste — it is never delivered as a bare
        // submit that would fire off a fragment of the prompt.
        assert!(framed.starts_with(b"\x1b[200~"));
        assert!(framed.ends_with(b"\x1b[201~"));
    }

    // Issue #2 (end-to-end regression): the prompt must be delivered only AFTER
    // the agent is input-ready, not on a blind timer. A fake agent stays SILENT
    // for 2s (longer than the old fixed ~1.5s delay), then emits the paste-mode
    // ENABLE a real TUI sends when its input is ready, prints a READY marker, and
    // reads one line. The tty echoes typed input where it was typed, so the
    // prompt's echo lands in the output stream at delivery time: with the old
    // blind delay it would appear BEFORE the marker; with readiness gating it
    // appears AFTER. We assert the prompt follows the marker — which fails on the
    // old code — and that the agent received the full prompt.
    #[test]
    fn prompt_is_delivered_after_the_agent_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        // A slow-starting fake agent, written to a file to avoid nested-quote
        // escaping when it is typed into the login shell. `printf '\033[?1049h'`
        // mimics the TUI entering the alternate screen — the input-ready signal
        // the detector keys on (a bare shell never enters the alt screen, so it
        // can't false-fire).
        let script = dir.path().join("slow-agent.sh");
        std::fs::write(
            &script,
            "sleep 2\n\
             printf '\\033[?1049h'\n\
             printf 'READY-MARKER-7739\\n'\n\
             IFS= read -r line\n\
             printf 'RECEIVED:%s\\n' \"$line\"\n\
             exit\n",
        )
        .unwrap();

        let handle = PtyHandle::spawn(PtySpawnOptions {
            task_id: "ready-gate".into(),
            initial_command: Some(format!("sh {}", script.display())),
            initial_prompt: Some("phasr-prompt-8842".into()),
            cwd: std::env::temp_dir(),
            log_path: dir.path().join("ready-gate.log"),
            rows: 24,
            cols: 80,
            env: Vec::new(),
        })
        .expect("spawn a slow-start fake agent");

        let mut rx = handle.subscribe();
        let mut combined = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&chunk);
                    if combined.contains("RECEIVED:phasr-prompt-8842") {
                        break;
                    }
                }
                Ok(PtyEvent::Exit { .. }) => break,
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
        let _ = handle.kill();

        let marker_at = combined
            .find("READY-MARKER-7739")
            .unwrap_or_else(|| panic!("agent should print its ready marker; output: {combined:?}"));
        let prompt_at = combined.find("phasr-prompt-8842").unwrap_or_else(|| {
            panic!("the prompt should be delivered to the agent; output: {combined:?}")
        });
        assert!(
            prompt_at > marker_at,
            "prompt must be typed AFTER the agent signalled ready (readiness gate), \
             got prompt@{prompt_at} <= marker@{marker_at}; output: {combined:?}"
        );
        assert!(
            combined.contains("RECEIVED:phasr-prompt-8842"),
            "the agent should receive the full prompt back through its own read; output: {combined:?}"
        );
    }
}
