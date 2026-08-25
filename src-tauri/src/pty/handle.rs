use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        /// The PTY's bytes, verbatim. A terminal emulator is a byte
        /// protocol, so nothing here decodes them: they cross the IPC
        /// base64-encoded and are handed to the emulator as bytes.
        ///
        /// This used to be a lossy `String`, which forced a carry buffer to
        /// avoid splitting a codepoint across reads (mid-codepoint decoding
        /// corrupted column tracking) and turned any non-UTF-8 byte into
        /// U+FFFD permanently. Both problems are absent from a byte stream.
        #[serde(serialize_with = "serialize_base64")]
        chunk: Vec<u8>,
    },
    /// Child process exited.
    Exit {
        task_id: String,
        exit_code: Option<i64>,
    },
}

/// Base64, not a JSON array of numbers: an array costs ~4x the bytes and
/// would be strictly worse than the lossy string it replaces. Base64 is a
/// flat 1.333x with no characters JSON has to escape — measured against
/// 49 MB of real phasr PTY logs it is 2.3% *smaller* than the escaped
/// string was, because agent TUI output is dense in ESC (0x1b), which
/// `serde_json` expands to six characters each.
fn serialize_base64<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    use base64::Engine as _;
    s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
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
    /// Optional prompt typed into the running command once its TUI has
    /// taken over the terminal, then submitted with Enter. Use this for
    /// agents that take their prompt interactively (e.g.
    /// `claude --dangerously-skip-permissions` followed by the user's
    /// question). Delivery waits for the agent's TUI escape sequences
    /// rather than a fixed delay — see `run_initial_writes`.
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
    /// Wall-clock ms of the most recent PTY output, stamped by the
    /// coalescer thread. Initialised to spawn time so a freshly started
    /// task counts as active before its first byte arrives.
    last_output_at: Arc<std::sync::atomic::AtomicI64>,
}

/// Wall-clock epoch milliseconds. The frontend compares this against
/// `Date.now()`, so it must be wall time, not a monotonic instant.
fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
    /// in Terminal.app. If `initial_prompt` is set, it's typed once the
    /// command's TUI has taken over the terminal, then submitted with
    /// Enter — see `run_initial_writes`.
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
            last_output_at: Arc::new(std::sync::atomic::AtomicI64::new(epoch_ms())),
        });

        // Schedule the agent command + optional prompt as keystrokes
        // into the running shell — see `run_initial_writes` for the
        // sequencing and why the prompt is gated on the agent's TUI
        // actually owning the terminal instead of a fixed delay.
        //
        // Subscribe before the byte-pump thread exists so no output —
        // and no TUI-readiness marker — can be emitted before the
        // receiver is listening.
        let handle_for_writes = handle.clone();
        let readiness_rx = tx.subscribe();
        std::thread::spawn(move || {
            run_initial_writes(
                handle_for_writes,
                readiness_rx,
                initial_command,
                initial_prompt,
            )
        });

        // Ensure log dir exists; open log file for appending.
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;

        // Two dedicated blocking threads — the PTY reader is sync and would
        // block the async runtime, and the flush timer needs a thread that
        // can wait on the clock instead of on `read`. See
        // `coalesce_pty_output`.
        let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let task_id_for_reader = task_id.clone();
        std::thread::Builder::new()
            .name(format!("phasr-pty-{task_id_for_reader}"))
            .spawn(move || {
                // No VT tap: `crate::vt` is scaffolding and is deliberately
                // not in the live path yet.
                pump_pty_output(reader, bytes_tx, None)
            })
            .map_err(PtyError::from)?;

        let task_id_for_coalesce = task_id.clone();
        let tx_for_coalesce = tx.clone();
        let replay_for_coalesce = handle.replay.clone();
        let last_output_for_coalesce = handle.last_output_at.clone();
        std::thread::Builder::new()
            .name(format!("phasr-pty-out-{task_id_for_coalesce}"))
            .spawn(move || {
                coalesce_pty_output(
                    task_id_for_coalesce,
                    bytes_rx,
                    log_file,
                    tx_for_coalesce,
                    replay_for_coalesce,
                    last_output_for_coalesce,
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

    /// Wall-clock ms of the most recent PTY output (spawn time until the
    /// first byte arrives). Drives the sidebar's activity dot.
    pub fn last_output_ms(&self) -> i64 {
        self.last_output_at
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PtyEvent> {
        self.tx.subscribe()
    }

    pub fn subscribe_with_replay(&self) -> (Vec<PtyEvent>, broadcast::Receiver<PtyEvent>) {
        subscribe_with_replay_locked(&self.tx, &self.replay)
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
}

/// Delay before the agent command is typed into the fresh shell. Only
/// paces the echo — bytes that arrive before the shell finishes its rc
/// files sit in the TTY buffer and the line editor picks them up.
const COMMAND_DELAY: Duration = Duration::from_millis(300);

/// How long to wait for the agent's TUI to take over the terminal
/// before typing the prompt blind (the pre-readiness behavior, kept as
/// a fallback for agents that never emit any TUI escape).
const TUI_WAIT_DEADLINE: Duration = Duration::from_secs(10);

/// Pause between the TUI appearing and the prompt being typed, so the
/// first paint finishes and the input widget is mounted.
const TUI_SETTLE: Duration = Duration::from_millis(250);

/// Gap between the prompt text and its Enter. Must sit comfortably
/// above TUI paste-burst windows so the Enter arrives as its own read
/// and registers as a submit keypress, never as part of a paste.
const ENTER_GAP: Duration = Duration::from_millis(300);

/// How long a typed prompt gets to echo back in the PTY output before
/// we conclude it fell into something that isn't a composer (a trust
/// dialog, a notice) and try again.
const ECHO_DEADLINE: Duration = Duration::from_secs(2);

/// How long to wait for the *next* screen takeover after an attempt
/// vanished — long enough for a human to answer a first-run dialog in
/// the visible terminal.
const REATTEMPT_WAIT: Duration = Duration::from_secs(30);

/// Typing attempts before falling back to the blind type-and-Enter.
const MAX_TYPE_ATTEMPTS: usize = 3;

/// Type the agent command, then the user's prompt, into the PTY.
///
/// The prompt is NOT sent on a timer. A fixed delay raced the agent's
/// cold start and lost routinely: prompt + Enter piled up in the
/// kernel's TTY buffer, the booting TUI drained them as ONE read, and
/// paste-burst detection swallowed the Enter — the prompt sat in the
/// composer unsubmitted. (With a slow shell init the bytes never even
/// reached the agent and fell through to the shell prompt.) Instead we
/// watch the PTY's own output for the escape sequences a TUI emits
/// when it takes the terminal over, type, and then require the typed
/// text to ECHO back before pressing Enter — echo is what separates a
/// real composer from a first-run dialog that silently eats input.
fn run_initial_writes(
    handle: Arc<PtyHandle>,
    mut events: broadcast::Receiver<PtyEvent>,
    initial_command: Option<String>,
    initial_prompt: Option<String>,
) {
    if let Some(cmd_text) = initial_command {
        let trimmed = cmd_text.trim();
        if !trimmed.is_empty() {
            std::thread::sleep(COMMAND_DELAY);
            let _ = handle.write(format!("{trimmed}\n").as_bytes());
        }
    }

    let Some(prompt) = initial_prompt else {
        return;
    };
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return;
    }

    match wait_for_tui(&mut events, TUI_WAIT_DEADLINE) {
        // PTY is gone. Typing now would at best be lost, at worst land
        // at a shell prompt where the text runs as a command.
        TuiWait::Ended => return,
        // No TUI escape ever appeared — the agent may render without
        // any. Fall back to typing blind, which is exactly what the
        // fixed delay always did.
        TuiWait::TimedOut => {
            type_prompt_blind(&handle, trimmed);
            return;
        }
        TuiWait::Ready => {}
    }

    // The TUI is up — but "up" may be a first-run dialog (folder
    // trust, a notice), not the composer. A composer echoes what you
    // type; a dialog silently ignores it. So: type, wait for a
    // distinctive word of the prompt to echo back, and only then
    // submit. Pressing Enter without that check is how a prompt ends
    // up ACCEPTING a trust dialog instead of submitting anything.
    // If the text vanished, wait for the next screen takeover (the
    // dialog being answered repaints the terminal) and try again.
    let needle = echo_needle(trimmed);
    for _ in 0..MAX_TYPE_ATTEMPTS {
        std::thread::sleep(TUI_SETTLE);
        let _ = handle.write(trimmed.as_bytes());
        match watch_after_typing(&mut events, &needle, ECHO_DEADLINE) {
            // The text is visibly in a composer — safe to submit.
            TypeOutcome::Echoed => {
                std::thread::sleep(ENTER_GAP);
                let _ = handle.write(b"\r");
                return;
            }
            // The screen repainted underneath us (a dialog resolved,
            // the real composer mounted) and our text isn't in it —
            // it went into a void. Type again on the new screen.
            TypeOutcome::Changed => continue,
            // Nothing moved at all: likely a modal waiting for a
            // human (first-run trust dialog in phasr's visible
            // terminal). Hold until the screen changes, then retry.
            TypeOutcome::Quiet => match wait_for_tui(&mut events, REATTEMPT_WAIT) {
                TuiWait::Ready => continue,
                TuiWait::Ended => return,
                TuiWait::TimedOut => break,
            },
            TypeOutcome::Ended => return,
        }
    }
    // Out of attempts — the echo check may be wrong (an exotic
    // composer that doesn't echo plainly). Take the blind path rather
    // than dropping the prompt.
    type_prompt_blind(&handle, trimmed);
}

/// The pre-readiness delivery: type the text and press Enter without
/// any feedback. Last-resort floor — never worse than the old fixed
/// delay was.
fn type_prompt_blind(handle: &PtyHandle, trimmed: &str) {
    let _ = handle.write(trimmed.as_bytes());
    std::thread::sleep(ENTER_GAP);
    let _ = handle.write(b"\r");
}

/// A word of the prompt distinctive enough to recognize in the echo.
/// TUIs repaint the composer with cursor jumps BETWEEN words but keep
/// each word contiguous, so a single word is the reliable unit. The
/// longest one collides least with banner/placeholder text.
fn echo_needle(prompt: &str) -> String {
    let longest = prompt
        .split_whitespace()
        .max_by_key(|w| w.len())
        .unwrap_or(prompt);
    let mut needle = longest.to_string();
    if needle.len() > 16 {
        let cut = (1..=16).rev().find(|i| needle.is_char_boundary(*i));
        needle.truncate(cut.unwrap_or(0));
    }
    needle
}

#[derive(Debug, PartialEq, Eq)]
enum TypeOutcome {
    /// The typed text echoed back — it's sitting in a composer.
    Echoed,
    /// No echo, but the screen repainted (fresh TUI markers): the text
    /// went into something that has since been replaced.
    Changed,
    /// No echo and no repaint — the screen is static (e.g. a modal
    /// waiting for a human).
    Quiet,
    /// The PTY exited or the channel closed.
    Ended,
}

/// After typing the prompt, watch the output for its echo AND for
/// fresh TUI takeover markers in the same stream. Both must be watched
/// together: markers consumed while waiting for an echo would
/// otherwise be lost to a later `wait_for_tui`.
fn watch_after_typing(
    events: &mut broadcast::Receiver<PtyEvent>,
    needle: &str,
    deadline: Duration,
) -> TypeOutcome {
    use tokio::sync::broadcast::error::TryRecvError;

    let give_up_at = Instant::now() + deadline;
    let mut marker_scanner = TuiMarkerScanner::default();
    let mut markers_seen = false;
    // Rolling buffer: keep enough tail to match a needle split across
    // chunk boundaries.
    let mut window = String::new();
    loop {
        if Instant::now() >= give_up_at {
            return if markers_seen {
                TypeOutcome::Changed
            } else {
                TypeOutcome::Quiet
            };
        }
        match events.try_recv() {
            Ok(PtyEvent::Output { chunk, .. }) => {
                markers_seen |= marker_scanner.scan(&chunk);
                // The echo is matched as text; the chunk is raw bytes, so
                // decode lossily HERE. A replacement char in a needle match
                // is harmless — unlike in the terminal, where it was not.
                window.push_str(&String::from_utf8_lossy(&chunk));
                if window.contains(needle) {
                    return TypeOutcome::Echoed;
                }
                if window.len() > 4 * 1024 {
                    let keep_from = window
                        .char_indices()
                        .rev()
                        .nth(needle.len().saturating_sub(1).max(64))
                        .map(|(i, _)| i)
                        .unwrap_or(0);
                    window.drain(..keep_from);
                }
            }
            Ok(PtyEvent::Exit { .. }) | Err(TryRecvError::Closed) => return TypeOutcome::Ended,
            Err(TryRecvError::Lagged(_)) => continue,
            Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(15)),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum TuiWait {
    /// A TUI takeover escape appeared in the output.
    Ready,
    /// Deadline passed without one.
    TimedOut,
    /// The PTY exited or the channel closed.
    Ended,
}

/// Block until the PTY output shows a TUI taking over the terminal,
/// the deadline passes, or the PTY goes away.
fn wait_for_tui(events: &mut broadcast::Receiver<PtyEvent>, deadline: Duration) -> TuiWait {
    use tokio::sync::broadcast::error::TryRecvError;

    let give_up_at = Instant::now() + deadline;
    let mut scanner = TuiMarkerScanner::default();
    loop {
        if Instant::now() >= give_up_at {
            return TuiWait::TimedOut;
        }
        match events.try_recv() {
            Ok(PtyEvent::Output { chunk, .. }) => {
                if scanner.scan(&chunk) {
                    return TuiWait::Ready;
                }
            }
            Ok(PtyEvent::Exit { .. }) | Err(TryRecvError::Closed) => return TuiWait::Ended,
            // Missed chunks (marker possibly among them) — keep
            // scanning what still arrives; the deadline backstops us.
            Err(TryRecvError::Lagged(_)) => continue,
            Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(15)),
        }
    }
}

/// Escape sequences a TUI emits when it takes over the terminal.
///
/// Deliberately EXCLUDES everything interactive shells emit while
/// drawing their own prompt — zsh enables bracketed paste (`[?2004h`)
/// and application cursor keys (`[?1h`) on every prompt, so neither
/// can be a readiness signal. Cursor-hide is the weakest entry (a
/// prompt theme could plausibly emit it) but it's what Ink-based
/// agents that never switch to the alt screen show first.
const TUI_MARKERS: &[&[u8]] = &[
    b"\x1b[?1049h", // alternate screen (codex, copilot, opencode)
    b"\x1b[?1000h", // mouse tracking (claude)
    b"\x1b[?1002h", // mouse button tracking
    b"\x1b[?1003h", // mouse any-event tracking
    b"\x1b[?1006h", // SGR mouse encoding
    b"\x1b[?1004h", // focus reporting (claude)
    b"\x1b[?25l",   // cursor hide (Ink apps, e.g. gemini)
];

/// Streaming search for any of `TUI_MARKERS`, tolerant of markers
/// split across PTY read boundaries.
#[derive(Default)]
struct TuiMarkerScanner {
    /// Tail of the previous chunk, long enough to complete a marker
    /// whose head arrived at the end of it.
    carry: Vec<u8>,
}

impl TuiMarkerScanner {
    fn scan(&mut self, chunk: &[u8]) -> bool {
        let mut haystack = std::mem::take(&mut self.carry);
        haystack.extend_from_slice(chunk);

        let found = TUI_MARKERS
            .iter()
            .any(|marker| haystack.windows(marker.len()).any(|w| w == *marker));
        if !found {
            let max_len = TUI_MARKERS.iter().map(|m| m.len()).max().unwrap_or(1);
            let keep = haystack.len().min(max_len - 1);
            self.carry = haystack[haystack.len() - keep..].to_vec();
        }
        found
    }
}

/// Size of a single PTY read. Unchanged — reading bigger doesn't help, the
/// kernel hands over only what it has.
const READ_BUF_BYTES: usize = 4096;

/// Bytes buffered before a flush is forced.
const COALESCE_BYTES: usize = 32 * 1024;

/// Longest any byte may sit in the coalescer before it is emitted. Bounds
/// the added latency: a byte read at t is on the frontend by t + 8ms.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// Thread A: read the PTY, hand raw bytes to the coalescer, nothing else.
///
/// It stays a pure `read → send` loop because `portable-pty`'s
/// `Box<dyn Read>` has no read timeout: a blocking `read` here can park for
/// seconds on an idle terminal, so a "flush after 8ms" timer cannot live in
/// this loop. It has to be a second thread that can wait on *either* bytes
/// or the clock.
///
/// Returning drops `out`, which is how the coalescer learns the PTY is done
/// and performs its final flush.
///
/// `vt_tap` is the second sink: an optional passive observer (`crate::vt`)
/// that gets the identical byte stream. It is a fan-out rather than a
/// subscriber on the broadcast because a VT engine must never miss bytes —
/// `broadcast` drops on lag, and an emulator fed a stream with a hole in it
/// is silently wrong from then on. A failing tap is dropped, never fatal:
/// the observer must not be able to disturb the terminal.
fn pump_pty_output(
    mut reader: Box<dyn Read + Send>,
    out: std::sync::mpsc::Sender<Vec<u8>>,
    vt_tap: Option<std::sync::mpsc::Sender<Vec<u8>>>,
) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(tap) = &vt_tap {
                    let _ = tap.send(buf[..n].to_vec());
                }
                // Err means the coalescer is gone; nothing left to feed.
                if out.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Thread B: batch the reader's bytes into far fewer, larger events.
///
/// Every 4096-byte read used to become its own `PtyEvent::Output`, one IPC
/// message and one emulator `write()` each. Flushing on 32 KiB *or* 8 ms —
/// whichever comes first — keeps the byte stream and its ordering exactly as
/// it was while collapsing a burst of reads into a single event, and bounds
/// added latency at 8 ms so interactive echo still feels immediate.
///
/// Same bytes to the log, same bytes to the frontend, same 128 KB replay
/// budget — only the framing changes. Fewer, larger messages also make
/// `RecvError::Lagged` on the broadcast materially less likely.
fn coalesce_pty_output<W: Write>(
    task_id: String,
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    mut log: W,
    tx: broadcast::Sender<PtyEvent>,
    replay: Arc<Mutex<ReplayBuffer>>,
    last_output_at: Arc<std::sync::atomic::AtomicI64>,
) {
    use std::sync::mpsc::RecvTimeoutError;

    let mut buf: Vec<u8> = Vec::with_capacity(COALESCE_BYTES);
    // When the oldest byte currently in `buf` must be flushed by. `None`
    // while `buf` is empty, so an idle PTY blocks instead of spinning.
    let mut deadline: Option<Instant> = None;

    loop {
        let received = match deadline {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
        };

        match received {
            Ok(bytes) => {
                // Stamped at receipt, not at flush — "the terminal produced
                // bytes" is the fact the activity dot reports, independent
                // of how those bytes are framed for delivery.
                last_output_at.store(epoch_ms(), std::sync::atomic::Ordering::Relaxed);
                // The log is the raw byte stream, written before any framing
                // decision — `read_task_log` and the B1 replay corpus both
                // depend on it being exactly what the PTY produced.
                let _ = log.write_all(&bytes);
                if buf.is_empty() {
                    deadline = Some(Instant::now() + COALESCE_WINDOW);
                }
                buf.extend_from_slice(&bytes);
                if buf.len() >= COALESCE_BYTES {
                    flush_output(&task_id, &mut buf, &tx, &replay);
                    deadline = None;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                flush_output(&task_id, &mut buf, &tx, &replay);
                deadline = None;
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush_output(&task_id, &mut buf, &tx, &replay);
                break;
            }
        }
    }
}

/// Emit everything buffered as ONE event. Leaves `buf` empty (capacity
/// retained).
///
/// There is no codepoint carry here: the chunk is bytes end to end, so a
/// multi-byte character split across two PTY reads is simply reassembled by
/// the emulator's own decoder — which is where that job belongs.
fn flush_output(
    task_id: &str,
    buf: &mut Vec<u8>,
    tx: &broadcast::Sender<PtyEvent>,
    replay: &Mutex<ReplayBuffer>,
) {
    if buf.is_empty() {
        return;
    }
    // Hand the buffer over and start a fresh one already sized for the next
    // batch — `take` would leave a zero-capacity Vec to regrow every cycle.
    let chunk = std::mem::replace(buf, Vec::with_capacity(COALESCE_BYTES));
    emit_output(task_id, chunk, tx, replay);
}

fn emit_output(
    task_id: &str,
    chunk: Vec<u8>,
    tx: &broadcast::Sender<PtyEvent>,
    replay: &Mutex<ReplayBuffer>,
) {
    let event = PtyEvent::Output {
        task_id: task_id.to_string(),
        chunk,
    };
    // Recorded for replay even with no subscribers — a send failure just
    // means nobody is attached yet, which is exactly what replay is for.
    //
    // The lock spans BOTH halves and that is the whole point; see
    // `subscribe_with_replay_locked`.
    let mut recorded = replay.lock();
    recorded.push(event.clone());
    let _ = tx.send(event);
}

/// Everything already produced, plus everything produced from now on —
/// each chunk **exactly once**.
///
/// The two halves have to be atomic against a producer. Subscribing first
/// and snapshotting afterwards (what this used to do) leaves a window: a
/// chunk pushed to the replay buffer between the two calls is in the
/// snapshot AND is then broadcast to the receiver that already exists, so
/// the terminal writes those bytes twice. Duplicated bytes are not a
/// cosmetic problem in a VT stream — a TUI's frame is cursor moves and
/// erases, and replaying part of one on top of the screen it already drew
/// corrupts the display until the program happens to repaint in full.
///
/// Holding the replay mutex across both calls here, and across
/// push-then-send in `emit_output`, serializes them: a subscriber either
/// runs entirely before a chunk is pushed (so it is not in the snapshot,
/// and the receiver — which exists before the send — gets it live) or
/// entirely after it is sent (so it IS in the snapshot, and the receiver
/// did not exist when it was sent). Never both.
fn subscribe_with_replay_locked(
    tx: &broadcast::Sender<PtyEvent>,
    replay: &Mutex<ReplayBuffer>,
) -> (Vec<PtyEvent>, broadcast::Receiver<PtyEvent>) {
    let recorded = replay.lock();
    let rx = tx.subscribe();
    (recorded.snapshot(), rx)
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

    fn output(chunk: &str) -> PtyEvent {
        PtyEvent::Output {
            task_id: "t".into(),
            chunk: chunk.as_bytes().to_vec(),
        }
    }

    #[test]
    fn scanner_finds_alt_screen_in_one_chunk() {
        let mut scanner = TuiMarkerScanner::default();
        assert!(scanner.scan(b"boot noise \x1b[?1049h\x1b[2J\x1b[H"));
    }

    #[test]
    fn scanner_finds_marker_split_across_chunks() {
        let mut scanner = TuiMarkerScanner::default();
        assert!(!scanner.scan(b"prelude\x1b[?10"));
        assert!(scanner.scan(b"49hrest"));
    }

    #[test]
    fn scanner_ignores_shell_prompt_escapes() {
        // Everything zsh emits while drawing its own prompt: bracketed
        // paste, application cursor keys, colors, titles. None of it
        // may count as "the agent's TUI is up".
        let mut scanner = TuiMarkerScanner::default();
        assert!(!scanner.scan(b"\x1b[1;32m>\x1b[0m \x1b[K\x1b[?1h\x1b=\x1b[?2004h"));
        assert!(!scanner.scan(b"\x1b]2;claude --dangerously-skip-permissions\x07"));
    }

    #[test]
    fn scanner_accepts_cursor_hide_for_inline_tuis() {
        let mut scanner = TuiMarkerScanner::default();
        assert!(scanner.scan(b"\x1b[?25l"));
    }

    #[test]
    fn wait_for_tui_returns_ready_on_marker() {
        let (tx, mut rx) = broadcast::channel(16);
        tx.send(output("shell prompt \x1b[?2004h")).unwrap();
        tx.send(output("\x1b[?1049h")).unwrap();
        assert_eq!(
            wait_for_tui(&mut rx, Duration::from_secs(2)),
            TuiWait::Ready
        );
    }

    #[test]
    fn wait_for_tui_times_out_without_marker() {
        let (tx, mut rx) = broadcast::channel(16);
        tx.send(output("just a shell \x1b[?2004h")).unwrap();
        assert_eq!(
            wait_for_tui(&mut rx, Duration::from_millis(120)),
            TuiWait::TimedOut
        );
    }

    #[test]
    fn echo_needle_picks_longest_word() {
        assert_eq!(echo_needle("fix the authentication bug"), "authentication");
        assert_eq!(echo_needle("hello"), "hello");
        // Truncated to 16 bytes on a char boundary.
        assert_eq!(
            echo_needle("supercalifragilisticexpialidocious"),
            "supercalifragili"
        );
    }

    #[test]
    fn watch_sees_echo_split_across_chunks() {
        let (tx, mut rx) = broadcast::channel(16);
        tx.send(output("\u{276f} auth")).unwrap();
        tx.send(output("entication and more")).unwrap();
        assert_eq!(
            watch_after_typing(&mut rx, "authentication", Duration::from_secs(2)),
            TypeOutcome::Echoed
        );
    }

    #[test]
    fn watch_reports_quiet_when_a_modal_eats_input() {
        let (tx, mut rx) = broadcast::channel(16);
        // A static trust dialog: plain text, no echo, no repaint.
        tx.send(output("Quick safety check: do you trust this folder?"))
            .unwrap();
        assert_eq!(
            watch_after_typing(&mut rx, "authentication", Duration::from_millis(120)),
            TypeOutcome::Quiet
        );
    }

    #[test]
    fn watch_reports_changed_when_screen_repaints_without_echo() {
        let (tx, mut rx) = broadcast::channel(16);
        // The dialog resolves and the real TUI mounts (alt-screen) —
        // but the typed text is nowhere in it.
        tx.send(output("\u{1b}[?1049h\u{1b}[2J fresh composer"))
            .unwrap();
        assert_eq!(
            watch_after_typing(&mut rx, "authentication", Duration::from_millis(120)),
            TypeOutcome::Changed
        );
    }

    #[test]
    fn wait_for_tui_ends_when_pty_exits() {
        let (tx, mut rx) = broadcast::channel(16);
        tx.send(PtyEvent::Exit {
            task_id: "t".into(),
            exit_code: Some(1),
        })
        .unwrap();
        assert_eq!(
            wait_for_tui(&mut rx, Duration::from_secs(2)),
            TuiWait::Ended
        );
    }

    // -- coalescing -------------------------------------------------------
    //
    // These pin the two properties the rest of the file depends on: the
    // BYTES are unchanged (log and events both), and only the FRAMING moves.
    // Everything downstream — the marker scanner's carry, the echo watcher's
    // rolling window, the replay buffer — was written to tolerate arbitrary
    // chunk boundaries, and the tests below are what keep that true now that
    // the boundaries are 8× larger.

    /// Run the coalescer to completion over a scripted byte stream.
    /// Returns (emitted chunks, bytes written to the log).
    fn run_coalescer(reads: Vec<Vec<u8>>) -> (Vec<Vec<u8>>, Vec<u8>) {
        let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (tx, mut rx) = broadcast::channel::<PtyEvent>(256);
        let replay = Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_BUFFER_BYTES)));
        for r in reads {
            bytes_tx.send(r).unwrap();
        }
        drop(bytes_tx);

        let mut sink: Vec<u8> = Vec::new();
        let last_output = Arc::new(std::sync::atomic::AtomicI64::new(0));
        coalesce_pty_output("t".into(), bytes_rx, &mut sink, tx, replay, last_output);

        let mut chunks = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let PtyEvent::Output { chunk, .. } = event {
                chunks.push(chunk);
            }
        }
        (chunks, sink)
    }

    #[test]
    fn coalescer_stamps_activity_on_every_received_chunk() {
        let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (tx, _rx) = broadcast::channel::<PtyEvent>(16);
        let replay = Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_BUFFER_BYTES)));
        let last_output = Arc::new(std::sync::atomic::AtomicI64::new(0));

        bytes_tx.send(b"hello".to_vec()).unwrap();
        drop(bytes_tx);

        let before = epoch_ms();
        let mut sink: Vec<u8> = Vec::new();
        coalesce_pty_output(
            "t".into(),
            bytes_rx,
            &mut sink,
            tx,
            replay,
            last_output.clone(),
        );

        let stamped = last_output.load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            stamped >= before,
            "activity stamp {stamped} should be at or after {before}"
        );
    }

    #[test]
    fn coalescer_merges_many_small_reads_into_one_event() {
        // 40 reads that would have been 40 separate IPC messages + 40
        // synchronous emulator writes.
        let reads: Vec<Vec<u8>> = (0..40).map(|i| format!("line {i}\r\n").into_bytes()).collect();
        let expected: Vec<u8> = (0..40)
            .map(|i| format!("line {i}\r\n"))
            .collect::<String>()
            .into_bytes();

        let (chunks, log) = run_coalescer(reads);

        assert_eq!(chunks.len(), 1, "expected one coalesced event");
        assert_eq!(chunks[0], expected);
        // Same bytes to the log, regardless of framing.
        assert_eq!(log, expected);
    }

    #[test]
    fn coalescer_flushes_at_the_byte_ceiling_not_only_on_the_timer() {
        // 3 x 32 KiB of reads must not be held back waiting for a timer.
        let reads: Vec<Vec<u8>> = (0..24).map(|_| vec![b'x'; 4096]).collect();
        let (chunks, log) = run_coalescer(reads);

        assert!(
            chunks.len() >= 3,
            "expected >=3 ceiling flushes, got {}",
            chunks.len()
        );
        for chunk in chunks.iter().take(chunks.len() - 1) {
            assert!(
                chunk.len() >= COALESCE_BYTES,
                "non-final chunk should be a full ceiling flush, was {}",
                chunk.len()
            );
        }
        assert_eq!(chunks.concat().len(), 24 * 4096);
        assert_eq!(log.len(), 24 * 4096);
    }

    #[test]
    fn coalescer_is_byte_exact_across_a_split_codepoint() {
        // A 3-byte box-drawing char straddling the 32 KiB ceiling. As a
        // BYTE stream this needs no carry at all: the halves are forwarded
        // untouched and the emulator's own decoder rejoins them. What must
        // hold is that the concatenation is identical to the input.
        let filler = COALESCE_BYTES - 1;
        let mut first = vec![b'x'; filler];
        first.extend_from_slice(&"\u{2500}".as_bytes()[..1]);
        let mut second = "\u{2500}".as_bytes()[1..].to_vec();
        second.extend_from_slice(b"done");
        let expected: Vec<u8> = first.iter().chain(second.iter()).copied().collect();

        let (chunks, log) = run_coalescer(vec![first, second]);

        assert!(chunks.len() >= 2, "expected a ceiling flush mid-codepoint");
        assert_eq!(chunks.concat(), expected);
        assert_eq!(log, expected);
    }

    #[test]
    fn coalescer_preserves_non_utf8_bytes_verbatim() {
        // The correctness win of a byte wire: these bytes are not valid
        // UTF-8 anywhere. The old lossy `String` replaced each with U+FFFD
        // permanently, so the emulator could never see the real sequence.
        let raw = vec![0x1b, b'[', b'0', b'm', 0xff, 0xfe, 0x80, b'o', b'k'];
        let (chunks, log) = run_coalescer(vec![raw.clone()]);
        assert_eq!(chunks.concat(), raw);
        assert_eq!(log, raw);
    }

    #[test]
    fn coalescer_delivers_a_truncated_codepoint_at_eof() {
        // Stream ends mid-character. The bytes still belong to the
        // emulator, not to a lossy decoder in the middle.
        let tail = "\u{2500}".as_bytes()[..2].to_vec();
        let mut expected = b"ok".to_vec();
        expected.extend_from_slice(&tail);
        let (chunks, log) = run_coalescer(vec![b"ok".to_vec(), tail]);
        assert_eq!(chunks.concat(), expected);
        assert_eq!(log, expected);
    }

    #[test]
    fn output_chunk_serializes_as_base64() {
        // The wire contract the frontend decodes. A JSON number array would
        // be ~4x and strictly worse; a raw string could not carry the
        // non-UTF-8 bytes above at all.
        let event = PtyEvent::Output {
            task_id: "t".into(),
            chunk: vec![0x1b, b'[', b'2', b'K', 0xff],
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"type":"output","taskId":"t","chunk":"G1syS/8="}"#
        );
    }

    #[test]
    fn scanner_finds_marker_split_across_a_ceiling_flush() {
        // Coalescing makes chunks 8× bigger, so splits are rarer — but a
        // marker can still straddle a 32 KiB ceiling flush, and the carry
        // has to survive a chunk far longer than the marker.
        let mut scanner = TuiMarkerScanner::default();
        let mut first = vec![b'x'; COALESCE_BYTES - 4];
        first.extend_from_slice(b"\x1b[?10");
        assert!(!scanner.scan(&first));
        assert!(scanner.scan(b"49h\x1b[2J"));
    }

    #[test]
    fn watch_finds_echo_inside_an_oversized_chunk() {
        // One 32 KiB event, needle near the end: the window is searched
        // BEFORE it is trimmed, so chunk size never hides an echo.
        let (tx, mut rx) = broadcast::channel(16);
        let mut chunk = "x".repeat(COALESCE_BYTES);
        chunk.push_str("\u{276f} authentication");
        tx.send(output(&chunk)).unwrap();
        assert_eq!(
            watch_after_typing(&mut rx, "authentication", Duration::from_secs(2)),
            TypeOutcome::Echoed
        );
    }

    #[test]
    fn watch_finds_echo_split_across_two_oversized_chunks() {
        // The needle straddles two ceiling flushes. The rolling window trims
        // a 32 KiB chunk down to its tail — that tail must still be long
        // enough to complete the needle on the next event.
        let (tx, mut rx) = broadcast::channel(16);
        let mut first = "x".repeat(COALESCE_BYTES);
        first.push_str("auth");
        tx.send(output(&first)).unwrap();
        tx.send(output(&format!("entication{}", "y".repeat(COALESCE_BYTES))))
            .unwrap();
        assert_eq!(
            watch_after_typing(&mut rx, "authentication", Duration::from_secs(2)),
            TypeOutcome::Echoed
        );
    }

    /// A subscriber must see every chunk exactly once — not once in the
    /// replay snapshot and again on the live receiver.
    ///
    /// This is a race, so it is hammered rather than asserted once: a
    /// producer emits monotonically numbered chunks as fast as it can while
    /// this thread attaches over and over. Before the lock spanned
    /// push-then-send and snapshot-then-subscribe, the seam between the
    /// snapshot's last chunk and the receiver's first repeated a number
    /// within a few hundred attaches on every machine it was tried on.
    #[test]
    fn attaching_mid_stream_never_delivers_a_chunk_twice() {
        // No long-lived receiver: one that never drains would fill the ring
        // and make every later attach report Lagged instead of exercising
        // the seam this test is about.
        let (tx, initial) = broadcast::channel::<PtyEvent>(4096);
        drop(initial);
        let replay = Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_BUFFER_BYTES)));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let producer = {
            let tx = tx.clone();
            let replay = replay.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut n: u64 = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    emit_output("t", format!("{n}\n").into_bytes(), &tx, &replay);
                    n += 1;
                }
            })
        };

        let seq = |event: &PtyEvent| -> Option<u64> {
            match event {
                PtyEvent::Output { chunk, .. } => {
                    String::from_utf8_lossy(chunk).trim().parse().ok()
                }
                PtyEvent::Exit { .. } => None,
            }
        };

        // Coverage-driven, not attempt-driven: each landed attach is an
        // independent proof of the exactly-once seam, but how many land
        // per attempt depends entirely on scheduler interleaving — a
        // loaded 2-core CI runner managed 74 in 2,000 fixed attempts
        // where a dev machine gets hundreds. Spend wall time until the
        // evidence bar is met instead of betting on a lucky scheduler.
        let started = std::time::Instant::now();
        let mut checked = 0usize;
        while checked < 100 && started.elapsed() < Duration::from_secs(15) {
            let (snapshot, mut rx) = subscribe_with_replay_locked(&tx, &replay);
            let Some(last_replayed) = snapshot.last().and_then(seq) else {
                continue;
            };
            // The producer is hot, so the next chunk lands within
            // microseconds; spin rather than sleep so the attach and the
            // send stay interleaved.
            let mut first_live = None;
            for _ in 0..10_000 {
                match rx.try_recv() {
                    Ok(event) => {
                        first_live = seq(&event);
                        break;
                    }
                    Err(broadcast::error::TryRecvError::Empty) => std::hint::spin_loop(),
                    // Producer outran the ring while this thread was
                    // descheduled — says nothing about the seam.
                    Err(_) => break,
                }
            }
            let Some(first_live) = first_live else {
                continue;
            };
            assert_eq!(
                first_live,
                last_replayed + 1,
                "chunk {last_replayed} was delivered in the replay AND live \
                 (attach #{checked})",
            );
            checked += 1;
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        producer.join().unwrap();
        // 30 exactly-once proofs is ample signal; below that the test was
        // starved into vacuousness and must say so rather than pass.
        assert!(
            checked >= 30,
            "only {checked} attaches landed mid-stream in {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn replay_budget_is_unchanged_by_bigger_events() {
        // Same 128 KB ceiling, just reached in fewer steps.
        let mut replay = ReplayBuffer::new(REPLAY_BUFFER_BYTES);
        for _ in 0..16 {
            replay.push(output(&"z".repeat(COALESCE_BYTES)));
        }
        let held: usize = replay
            .snapshot()
            .iter()
            .map(|e| match e {
                PtyEvent::Output { chunk, .. } => chunk.len(),
                PtyEvent::Exit { .. } => 0,
            })
            .sum();
        assert!(
            held <= REPLAY_BUFFER_BYTES,
            "replay held {held} bytes, over the {REPLAY_BUFFER_BYTES} budget"
        );
        assert_eq!(held, REPLAY_BUFFER_BYTES);
    }
}
