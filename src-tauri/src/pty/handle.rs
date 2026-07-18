use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

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

        // Schedule the agent command + optional prompt as keystrokes
        // into the running shell. We use staged delays so:
        //   1. The shell finishes printing its prompt.
        //   2. The agent command is "typed" and ENTERed.
        //   3. The agent has time to start up.
        //   4. The user's prompt is typed into the agent's UI.
        let handle_for_writes = handle.clone();
        std::thread::spawn(move || {
            if let Some(cmd_text) = initial_command {
                let trimmed = cmd_text.trim();
                if !trimmed.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = handle_for_writes.write(format!("{trimmed}\n").as_bytes());
                }
            }
            if let Some(prompt) = initial_prompt {
                let trimmed = prompt.trim();
                if !trimmed.is_empty() {
                    // Give the agent ~1.2s to launch its UI before we
                    // start pasting the prompt.
                    std::thread::sleep(std::time::Duration::from_millis(1_200));
                    let _ = handle_for_writes.write(trimmed.as_bytes());
                    // Submit the prompt with Enter. Most TUI agents
                    // accept a plain newline; for the rare ones that
                    // need \r, the shell will translate.
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    let _ = handle_for_writes.write(b"\r");
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
}
