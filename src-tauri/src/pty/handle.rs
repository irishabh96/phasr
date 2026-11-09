use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
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
    /// `send_message` into an interactive PTY whose agent has exited back
    /// to the shell: the text would run as a shell command.
    #[error("agent not running")]
    AgentNotRunning,
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

/// How the PTY's child process is started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LaunchMode {
    /// An interactive login shell; `SpawnSpec::initial_command` (if any) is
    /// *typed* into it. The shell outlives the command, so the user can keep
    /// working in the terminal — but the PTY's exit code is the shell's,
    /// which says nothing about how the command went.
    #[default]
    InteractiveTyped,
    /// `$SHELL -l -i -c <command>`: the shell runs exactly this command and
    /// exits with its status, so `PtyEvent::Exit` carries the command's real
    /// exit code. `-l -i` keeps the user's full PATH/rc environment, which
    /// is why this isn't a bare `exec` of the binary.
    Exec(String),
}

/// What `run_initial_writes` may do with the initial prompt right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptGateDecision {
    /// Nothing on screen objects: type it.
    Proceed,
    /// Something that must not receive keystrokes is up (e.g. the agent's
    /// folder-trust dialog): ask again shortly.
    Wait,
    /// Never type it (the dialog was declined and the agent exited).
    Abandon,
}

/// Consulted by `run_initial_writes` before it types the initial prompt,
/// and again before every retry and blind fallback. The PTY layer knows
/// bytes, not what an agent's screen means; the layer that does
/// (`AgentSignals`) holds the prompt while a dialog that a stray Enter
/// would answer wrongly is on screen.
pub trait PromptGate: Send + Sync + std::fmt::Debug {
    fn check(&self) -> PromptGateDecision;
}

/// Everything needed to start one PTY. Built with `SpawnSpec::new` plus the
/// `with_*` setters so new knobs don't grow a positional argument list at
/// every call site.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub task_id: String,
    pub cwd: PathBuf,
    pub rows: u16,
    pub cols: u16,
    pub launch: LaunchMode,
    /// `LaunchMode::InteractiveTyped` only: a command typed into the shell
    /// as if the user had entered it, after a brief delay so the shell
    /// finishes initialising and shows its prompt first.
    pub initial_command: Option<String>,
    /// Optional prompt typed into the running command once its TUI has
    /// taken over the terminal, then submitted with Enter. Use this for
    /// agents that take their prompt interactively (e.g.
    /// `claude --dangerously-skip-permissions` followed by the user's
    /// question). Delivery waits for the agent's TUI escape sequences
    /// rather than a fixed delay — see `run_initial_writes`. Valid in
    /// either launch mode.
    pub initial_prompt: Option<String>,
    /// Applied AFTER `shell::terminal_env`, so these win over both the
    /// inherited environment and phasr's terminal defaults.
    pub extra_env: Vec<(String, String)>,
    /// Use this shell instead of the account's login shell.
    pub shell_override: Option<String>,
    /// Holds `initial_prompt` while the agent shows a dialog it must not
    /// be typed into. `None` = type as soon as the TUI is ready.
    pub prompt_gate: Option<Arc<dyn PromptGate>>,
}

impl SpawnSpec {
    pub fn new(task_id: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            task_id: task_id.into(),
            cwd: cwd.into(),
            rows: 24,
            cols: 80,
            launch: LaunchMode::InteractiveTyped,
            initial_command: None,
            initial_prompt: None,
            extra_env: Vec::new(),
            shell_override: None,
            prompt_gate: None,
        }
    }

    pub fn with_size(mut self, rows: u16, cols: u16) -> Self {
        self.rows = rows;
        self.cols = cols;
        self
    }

    pub fn with_initial_command(mut self, command: Option<String>) -> Self {
        self.initial_command = command;
        self
    }

    pub fn with_initial_prompt(mut self, prompt: Option<String>) -> Self {
        self.initial_prompt = prompt;
        self
    }

    pub fn with_launch(mut self, launch: LaunchMode) -> Self {
        self.launch = launch;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }

    pub fn with_prompt_gate(mut self, gate: Option<Arc<dyn PromptGate>>) -> Self {
        self.prompt_gate = gate;
        self
    }

    pub fn with_shell(mut self, shell: Option<String>) -> Self {
        self.shell_override = shell;
        self
    }
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
    /// Whether the program in the PTY last asked for bracketed paste
    /// (`CSI ? 2004 h` / `l`), tracked by the coalescer thread. Decides how
    /// `send_message` frames text.
    bracketed_paste: Arc<AtomicBool>,
    /// The child's exit code once it has exited. Set by the wait thread
    /// BEFORE it broadcasts `PtyEvent::Exit`, so "subscribe, then check
    /// this" can never miss an exit that raced the subscription — which a
    /// fast `LaunchMode::Exec` command readily does.
    exit_code: Arc<OnceLock<Option<i64>>>,
    /// The PTY's own child (the shell) — compared against the terminal's
    /// foreground process group to tell "the agent is running" from "back
    /// at the shell prompt".
    shell_pid: Option<u32>,
    /// `LaunchMode::InteractiveTyped`: the shell outlives the program typed
    /// into it, so "shell in the foreground" means that program is gone.
    /// (In `Exec` mode the shell IS the program; builtins like `read` keep
    /// it in the foreground legitimately.)
    interactive: bool,
    /// The PTY's slave device (`ttys012` / `pts/3`): every job started in
    /// this terminal has it as its controlling tty — how `terminate` finds
    /// them all, even after the shell itself has gone.
    tty: Option<String>,
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
    /// Spawns a shell inside the PTY. Known user shells are launched as
    /// login shells so their normal terminal rc/history setup matches
    /// Terminal.app, iTerm, and Warp. If login launch fails, spawn retries
    /// with progressively more conservative fallbacks.
    ///
    /// In `LaunchMode::InteractiveTyped`, `initial_command` (if set) is
    /// typed into the shell after a brief delay (so the shell has time to
    /// print its prompt). The shell keeps running after the command
    /// finishes — the user can then run any other command (`ls`, `git
    /// status`, etc.) just like in Terminal.app. In `LaunchMode::Exec` the
    /// shell runs the command and exits with its status. Either way, if
    /// `initial_prompt` is set it's typed once the command's TUI has taken
    /// over the terminal, then submitted with Enter — see
    /// `run_initial_writes`.
    pub fn spawn(spec: SpawnSpec, log_path: PathBuf) -> Result<Arc<Self>, PtyError> {
        let SpawnSpec {
            task_id,
            cwd,
            rows,
            cols,
            launch,
            initial_command,
            initial_prompt,
            extra_env,
            shell_override,
            prompt_gate,
        } = spec;
        // A typed command in Exec mode would land in whatever the exec'd
        // program reads from stdin — never what a caller means.
        if matches!(launch, LaunchMode::Exec(_)) && initial_command.is_some() {
            return Err(PtyError::Pty(
                "initial_command is only valid with LaunchMode::InteractiveTyped".into(),
            ));
        }

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

        let resolved_shell = shell_override
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(shell::resolve_shell);
        let candidates = match &launch {
            LaunchMode::InteractiveTyped => shell::spawn_candidates(&resolved_shell),
            LaunchMode::Exec(command) => shell::exec_candidates(&resolved_shell, command),
        };
        let mut spawn_errors = Vec::new();
        let mut child = None;
        for launch in candidates {
            let mut cmd = CommandBuilder::new(&launch.shell);
            for arg in &launch.args {
                cmd.arg(arg);
            }
            cmd.cwd(&cwd);
            for (key, value) in shell::terminal_env(&launch.shell) {
                cmd.env(key, value);
            }
            // After terminal_env so a caller's value is never clobbered by
            // phasr's defaults (TERM, PATH, …).
            for (key, value) in &extra_env {
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
        let shell_pid = child.process_id();
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
        let interactive = matches!(launch, LaunchMode::InteractiveTyped);
        #[cfg(unix)]
        let tty = master
            .tty_name()
            .map(|p| p.to_string_lossy().trim_start_matches("/dev/").to_string());
        #[cfg(not(unix))]
        let tty: Option<String> = None;

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
            bracketed_paste: Arc::new(AtomicBool::new(false)),
            exit_code: Arc::new(OnceLock::new()),
            shell_pid,
            interactive,
            tty,
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
                prompt_gate,
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
        let observers = OutputObservers {
            last_output_at: handle.last_output_at.clone(),
            bracketed_paste: handle.bracketed_paste.clone(),
        };
        // Dropped (never sent on) when the coalescer returns — i.e. after its
        // final flush. The wait thread blocks on it so `Exit` is broadcast
        // AFTER the last output, not racing it.
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(format!("phasr-pty-out-{task_id_for_coalesce}"))
            .spawn(move || {
                let _drained = drained_tx;
                coalesce_pty_output(
                    task_id_for_coalesce,
                    bytes_rx,
                    log_file,
                    tx_for_coalesce,
                    replay_for_coalesce,
                    observers,
                )
            })
            .map_err(PtyError::from)?;

        // Spawn a waiter thread that reports the exit code.
        let task_id_for_wait = task_id.clone();
        let child_for_wait = child.clone();
        let tx_for_wait = tx;
        let exit_code_for_wait = handle.exit_code.clone();
        std::thread::Builder::new()
            .name(format!("phasr-pty-wait-{task_id_for_wait}"))
            .spawn(move || {
                let exit_code = {
                    let mut guard = child_for_wait.lock();
                    guard.wait().ok().and_then(exit_status_to_code)
                };
                // Let the output pipeline drain first: the child's last
                // bytes (an exec command's failing test summary) are often
                // still in the kernel buffer or the 8 ms coalescing window
                // when it exits, and viewers stop reading at `Exit`. Bounded,
                // because a background job that inherited the PTY keeps the
                // reader from ever seeing EOF.
                let _ = drained_rx.recv_timeout(EXIT_DRAIN_TIMEOUT);
                // Recorded before the broadcast — see `PtyHandle::exit_code`.
                let _ = exit_code_for_wait.set(exit_code);
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

    /// Whether the program currently in the PTY has bracketed paste on —
    /// i.e. the last `CSI ? 2004 h|l` it emitted was `h`. Interactive shells
    /// toggle this around every prompt, and agent TUIs turn it on at boot.
    pub fn bracketed_paste_enabled(&self) -> bool {
        self.bracketed_paste.load(Ordering::Acquire)
    }

    /// `None` while the child is running; `Some(code)` once it has exited
    /// (`code` itself is `None` if the status couldn't be read). Check this
    /// AFTER subscribing to cover an exit that happened before the
    /// subscription existed.
    pub fn exit_code(&self) -> Option<Option<i64>> {
        self.exit_code.get().copied()
    }

    /// Deliver `text` to the program in the PTY as ONE message (a reply in
    /// an agent's composer), and press Enter if `submit`.
    ///
    /// With bracketed paste on, the text is wrapped in paste markers so a
    /// multi-line message lands as a single paste rather than as lines that
    /// each submit. With it off, newlines would each act as Enter, so they
    /// are collapsed to spaces.
    ///
    /// Enter goes out as a separate write `ENTER_GAP` after the text, in
    /// both modes — the same rule `run_initial_writes` learned the hard
    /// way: TUIs with paste-burst detection fold an Enter that arrives in
    /// the same read as the text into the paste instead of submitting.
    ///
    /// Writes run on the blocking pool: a PTY write blocks once the
    /// kernel's input buffer is full (the program isn't reading yet), and
    /// a long message must not park a Tokio worker while it waits.
    ///
    /// Refuses with `AgentNotRunning` in an interactive PTY whose shell is
    /// back in the foreground: the agent exited, and a pasted message plus
    /// Enter would run as a shell command (backticks and all).
    pub async fn send_message(self: &Arc<Self>, text: &str, submit: bool) -> Result<(), PtyError> {
        if self.interactive && self.shell_in_foreground() == Some(true) {
            return Err(PtyError::AgentNotRunning);
        }
        let body = frame_message(text, self.bracketed_paste_enabled());
        if !body.is_empty() {
            self.write_off_runtime(body).await?;
        }
        if submit {
            if !text.is_empty() {
                tokio::time::sleep(ENTER_GAP).await;
            }
            self.write_off_runtime(b"\r".to_vec()).await?;
        }
        Ok(())
    }

    async fn write_off_runtime(self: &Arc<Self>, bytes: Vec<u8>) -> Result<(), PtyError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.write(&bytes))
            .await
            .map_err(|e| PtyError::Pty(format!("pty write task failed: {e}")))?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PtyEvent> {
        self.tx.subscribe()
    }

    /// Whether the PTY's own shell is the terminal's foreground job, i.e.
    /// no program it launched (the agent) is running right now. A job the
    /// shell starts gets its own process group, so the foreground group's
    /// leader is the shell only when the shell itself has the terminal.
    /// `None` when the platform can't tell.
    pub fn shell_in_foreground(&self) -> Option<bool> {
        #[cfg(unix)]
        {
            let leader = self.master.lock().process_group_leader()?;
            let shell = self.shell_pid?;
            Some(u32::try_from(leader).ok()? == shell)
        }
        #[cfg(not(unix))]
        {
            None
        }
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
    ///
    /// Only the shell itself: jobs it started (a dev server, the agent, a
    /// `&` background job) live in their own process groups and survive.
    /// Stop paths use `terminate` instead.
    pub fn kill(&self) -> Result<(), PtyError> {
        let mut killer = self.killer.lock();
        killer.kill().map_err(|e| PtyError::Pty(e.to_string()))?;
        Ok(())
    }

    /// Stop EVERYTHING running in this terminal, escalating: SIGHUP (what
    /// closing a terminal sends), then SIGTERM after `grace`, then SIGKILL
    /// after another `grace` — each to every process in the PTY's session.
    ///
    /// The session, not the shell's process group: the PTY's shell is a
    /// session leader (portable-pty `setsid`s it), and job control gives
    /// every job it starts — the agent, `pnpm dev`, `cmd &` — its own
    /// process group, so signalling the shell (`kill`) or its group left
    /// them running, holding ports and files. Returns immediately; the
    /// escalation runs on its own thread.
    pub fn terminate(&self, grace: Duration) {
        #[cfg(unix)]
        if let Some(sid) = self.shell_pid {
            let tty = self.tty.clone();
            std::thread::spawn(move || terminate_session(sid, tty.as_deref(), grace));
            return;
        }
        let _ = self.kill();
    }

    /// Every process running in this terminal (blocking: shells out to
    /// `pgrep`). Empty where that can't be determined.
    pub fn process_ids(&self) -> Vec<u32> {
        #[cfg(unix)]
        if let Some(shell) = self.shell_pid.and_then(|p| libc::pid_t::try_from(p).ok()) {
            return terminal_members(shell, self.tty.as_deref())
                .into_iter()
                .filter_map(|p| u32::try_from(p).ok())
                .collect();
        }
        Vec::new()
    }

    /// `terminate`, synchronously and bounded by roughly `2 × grace` — for
    /// app quit, where nothing may outlive the process.
    pub fn terminate_blocking(&self, grace: Duration) {
        #[cfg(unix)]
        if let Some(sid) = self.shell_pid {
            terminate_session(sid, self.tty.as_deref(), grace);
            return;
        }
        let _ = self.kill();
    }
}

#[cfg(unix)]
fn pgrep(args: &[&str]) -> Vec<libc::pid_t> {
    std::process::Command::new("pgrep")
        .args(args)
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Everything running in the terminal: the shell, every process whose
/// controlling tty is the PTY (`pgrep -t` — macOS' pgrep has no `-s`),
/// and the shell's descendants (`pgrep -P`, walked down), which also
/// catches a child that detached from the tty. Never ourselves or init.
#[cfg(unix)]
fn terminal_members(shell: libc::pid_t, tty: Option<&str>) -> Vec<libc::pid_t> {
    let mut out = vec![shell];
    if let Some(tty) = tty {
        out.extend(pgrep(&["-t", tty]));
    }
    let mut frontier = vec![shell];
    // Bounded walk: process trees here are shallow.
    for _ in 0..16 {
        let mut next = Vec::new();
        for parent in frontier {
            for child in pgrep(&["-P", &parent.to_string()]) {
                if !out.contains(&child) {
                    out.push(child);
                    next.push(child);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    let me = std::process::id() as libc::pid_t;
    out.sort_unstable();
    out.dedup();
    out.retain(|p| *p > 1 && *p != me);
    out
}

#[cfg(unix)]
fn gone(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only probes for existence.
    let missing = unsafe { libc::kill(pid, 0) != 0 };
    missing || is_zombie(pid)
}

/// HUP → TERM → KILL to everything in the terminal. Members are gathered
/// BEFORE the first signal (once the shell dies, its orphans reparent and
/// the descendant walk can't find them) and re-gathered each step (a
/// dying process may have spawned more), so the final SIGKILL reaches
/// everything ever seen.
#[cfg(unix)]
fn terminate_session(shell: u32, tty: Option<&str>, grace: Duration) {
    let Ok(shell) = libc::pid_t::try_from(shell) else {
        return;
    };
    let mut seen = terminal_members(shell, tty);
    for (signal, then_wait) in [(libc::SIGHUP, true), (libc::SIGTERM, true), (libc::SIGKILL, false)] {
        for pid in terminal_members(shell, tty) {
            if !seen.contains(&pid) {
                seen.push(pid);
            }
        }
        seen.retain(|p| !gone(*p));
        if seen.is_empty() {
            return;
        }
        for pid in &seen {
            // SAFETY: only processes that ran in this PTY.
            unsafe {
                libc::kill(*pid, signal);
            }
        }
        if !then_wait {
            return;
        }
        let until = Instant::now() + grace;
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
            if seen.iter().all(|p| gone(*p)) {
                return;
            }
        }
    }
}

/// A process that exited but hasn't been reaped yet still answers
/// `kill(pid, 0)`; it is gone for our purposes.
#[cfg(unix)]
fn is_zombie(pid: libc::pid_t) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_start().starts_with('Z'))
        .unwrap_or(false)
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

/// Longest the wait thread holds `Exit` back for the output pipeline to
/// drain (see the wait thread in `PtyHandle::spawn`).
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// Make message text inert as terminal input: line breaks normalised to
/// `\n`, then every ESC, every C1 control (U+0080–U+009F, incl. the
/// single-character CSI U+009B), DEL and every C0 control except `\t` and
/// `\n` removed. With no ESC/CSI left, no paste marker, key sequence or
/// control keystroke (Ctrl-C, Ctrl-U, a bare CR = Enter) can survive in the
/// body, whatever nesting the content tries — review comments and file
/// excerpts are repo content, so the repo itself could supply them.
///
/// Whole paste markers are removed first (to a fixpoint) purely so that a
/// marker in the text vanishes instead of leaving a `[201~` stub; the
/// control strip is what makes it safe.
fn sanitize_message(text: &str) -> String {
    let mut text = text.replace("\r\n", "\n").replace('\r', "\n");
    loop {
        let next = text.replace(PASTE_END, "").replace(PASTE_START, "");
        if next == text {
            break;
        }
        text = next;
    }
    text.chars()
        .filter(|&c| match c {
            '\t' | '\n' => true,
            '\u{00}'..='\u{1f}' | '\u{7f}' | '\u{80}'..='\u{9f}' => false,
            _ => true,
        })
        .collect()
}

/// The bytes `send_message` writes for `text` (Enter not included).
fn frame_message(text: &str, bracketed_paste: bool) -> Vec<u8> {
    let clean = sanitize_message(text);
    if clean.is_empty() {
        return Vec::new();
    }
    if bracketed_paste {
        // Sanitised first, so nothing inside can close the paste early and
        // turn the rest into keystrokes.
        let mut out = Vec::with_capacity(clean.len() + PASTE_START.len() + PASTE_END.len());
        out.extend_from_slice(PASTE_START.as_bytes());
        out.extend_from_slice(clean.as_bytes());
        out.extend_from_slice(PASTE_END.as_bytes());
        out
    } else {
        // Each line break would be an Enter; one message must stay one
        // line (CRs were already normalised to `\n`).
        clean.replace('\n', " ").into_bytes()
    }
}

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
    gate: Option<Arc<dyn PromptGate>>,
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
            if pass_gate(&handle, gate.as_ref(), &mut events) {
                type_prompt_blind(&handle, trimmed);
            }
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
        // Before EVERY attempt: a folder-trust dialog focused on "No, exit"
        // must never receive the prompt, and above all not its Enter.
        if !pass_gate(&handle, gate.as_ref(), &mut events) {
            return;
        }
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
    // than dropping the prompt — unless the gate holds it.
    if pass_gate(&handle, gate.as_ref(), &mut events) {
        type_prompt_blind(&handle, trimmed);
    }
}

/// How often a holding `PromptGate` is asked again.
const GATE_POLL: Duration = Duration::from_millis(50);

/// Block until `gate` lets the prompt through. `false` = drop the prompt:
/// the gate abandoned it, the PTY went away while it was held, or — after
/// a hold — the shell itself is back in the foreground. That last check is
/// what keeps a prompt from being typed (and Entered) as a shell command
/// when the user answered "No, exit" in the terminal and the agent quit.
fn pass_gate(
    handle: &PtyHandle,
    gate: Option<&Arc<dyn PromptGate>>,
    events: &mut broadcast::Receiver<PtyEvent>,
) -> bool {
    use tokio::sync::broadcast::error::TryRecvError;

    let Some(gate) = gate else {
        return true;
    };
    let mut held = false;
    loop {
        match gate.check() {
            PromptGateDecision::Proceed => {
                return !(held && handle.shell_in_foreground() == Some(true));
            }
            PromptGateDecision::Abandon => return false,
            PromptGateDecision::Wait => held = true,
        }
        // Only an exit matters while held; the typing that follows watches
        // fresh output for its own echo.
        loop {
            match events.try_recv() {
                Ok(PtyEvent::Exit { .. }) | Err(TryRecvError::Closed) => return false,
                Ok(_) | Err(TryRecvError::Lagged(_)) => continue,
                Err(TryRecvError::Empty) => break,
            }
        }
        std::thread::sleep(GATE_POLL);
    }
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

/// Streaming tracker for DECSET/DECRST 2004 (bracketed paste) in PTY
/// output.
///
/// A small state machine over `ESC [ ? <params> h|l` rather than a search
/// for the literal `\x1b[?2004h`: state carries across calls, so a sequence
/// split at ANY byte between two PTY reads is still recognised, and the
/// combined form some programs emit (`\x1b[?1049;2004h`) counts too. Last
/// sequence wins, which is the terminal's own semantics.
#[derive(Default)]
struct PasteModeScanner {
    state: PasteScanState,
    /// Digits of the parameter currently being read.
    param: u32,
    /// Whether any completed parameter in this sequence was 2004.
    saw_2004: bool,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum PasteScanState {
    #[default]
    Ground,
    Esc,
    Csi,
    Private,
}

impl PasteModeScanner {
    /// Feed bytes; returns the mode set by the LAST complete 2004 sequence
    /// in them, or `None` if they contained none.
    fn scan(&mut self, bytes: &[u8]) -> Option<bool> {
        let mut result = None;
        for &b in bytes {
            match (self.state, b) {
                // ESC always (re)starts a sequence, even mid-sequence.
                (_, 0x1b) => self.state = PasteScanState::Esc,
                (PasteScanState::Esc, b'[') => self.state = PasteScanState::Csi,
                (PasteScanState::Csi, b'?') => {
                    self.state = PasteScanState::Private;
                    self.param = 0;
                    self.saw_2004 = false;
                }
                (PasteScanState::Private, b'0'..=b'9') => {
                    // Saturate: an absurd parameter just never equals 2004.
                    self.param = self
                        .param
                        .saturating_mul(10)
                        .saturating_add(u32::from(b - b'0'));
                }
                (PasteScanState::Private, b';') => {
                    self.saw_2004 |= self.param == 2004;
                    self.param = 0;
                }
                (PasteScanState::Private, b'h' | b'l') => {
                    if self.saw_2004 || self.param == 2004 {
                        result = Some(b == b'h');
                    }
                    self.state = PasteScanState::Ground;
                }
                _ => self.state = PasteScanState::Ground,
            }
        }
        result
    }
}

/// Side-channel state the coalescer stamps as bytes arrive, before any
/// framing decision.
struct OutputObservers {
    last_output_at: Arc<std::sync::atomic::AtomicI64>,
    bracketed_paste: Arc<AtomicBool>,
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
    observers: OutputObservers,
) {
    use std::sync::mpsc::RecvTimeoutError;

    let OutputObservers {
        last_output_at,
        bracketed_paste,
    } = observers;
    let mut paste_scanner = PasteModeScanner::default();
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
                // Scanned at receipt, before the bytes are even framed, so
                // by the time anyone has SEEN a prompt the flag describing
                // it is already set.
                if let Some(enabled) = paste_scanner.scan(&bytes) {
                    bracketed_paste.store(enabled, Ordering::Release);
                }
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

    fn observers() -> OutputObservers {
        OutputObservers {
            last_output_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            bracketed_paste: Arc::new(AtomicBool::new(false)),
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
        coalesce_pty_output("t".into(), bytes_rx, &mut sink, tx, replay, observers());

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
            OutputObservers {
                last_output_at: last_output.clone(),
                bracketed_paste: Arc::new(AtomicBool::new(false)),
            },
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

    // -- bracketed paste --------------------------------------------------

    #[test]
    fn paste_scanner_tracks_set_and_reset() {
        let mut scanner = PasteModeScanner::default();
        assert_eq!(scanner.scan(b"plain output, no modes"), None);
        assert_eq!(scanner.scan(b"$ \x1b[?2004h"), Some(true));
        assert_eq!(scanner.scan(b"\x1b[?2004lrunning cmd"), Some(false));
        // Last sequence in a chunk wins.
        assert_eq!(scanner.scan(b"\x1b[?2004l...\x1b[?2004h"), Some(true));
    }

    #[test]
    fn paste_scanner_survives_a_split_at_every_byte() {
        for (stream, expected) in [
            (&b"zsh prompt \x1b[?2004h tail"[..], true),
            (&b"exec cmd \x1b[?2004l tail"[..], false),
        ] {
            for split in 0..=stream.len() {
                let mut scanner = PasteModeScanner::default();
                let first = scanner.scan(&stream[..split]);
                let second = scanner.scan(&stream[split..]);
                assert_eq!(
                    second.or(first),
                    Some(expected),
                    "split at {split} of {:?}",
                    String::from_utf8_lossy(stream)
                );
            }
        }
    }

    #[test]
    fn paste_scanner_reads_combined_params_and_ignores_lookalikes() {
        let mut scanner = PasteModeScanner::default();
        // Combined DECSET, as some TUIs emit at boot.
        assert_eq!(scanner.scan(b"\x1b[?1049;2004h"), Some(true));
        assert_eq!(scanner.scan(b"\x1b[?2004;25l"), Some(false));
        // Other private modes, a DECRQM query for 2004, a non-private CSI
        // with the same digits, and a longer number that merely starts
        // with 2004 — none of them change paste mode.
        assert_eq!(scanner.scan(b"\x1b[?1049h\x1b[?25l"), None);
        assert_eq!(scanner.scan(b"\x1b[?2004$p"), None);
        assert_eq!(scanner.scan(b"\x1b[2004h"), None);
        assert_eq!(scanner.scan(b"\x1b[?20045h"), None);
    }

    #[test]
    fn coalescer_sets_paste_flag_from_a_marker_split_across_reads() {
        let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (tx, _rx) = broadcast::channel::<PtyEvent>(16);
        let replay = Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_BUFFER_BYTES)));
        let flag = Arc::new(AtomicBool::new(false));
        bytes_tx.send(b"prompt \x1b[?20".to_vec()).unwrap();
        bytes_tx.send(b"04h".to_vec()).unwrap();
        drop(bytes_tx);

        let mut sink: Vec<u8> = Vec::new();
        coalesce_pty_output(
            "t".into(),
            bytes_rx,
            &mut sink,
            tx,
            replay,
            OutputObservers {
                last_output_at: Arc::new(std::sync::atomic::AtomicI64::new(0)),
                bracketed_paste: flag.clone(),
            },
        );
        assert!(flag.load(Ordering::Acquire));
        // Observing the stream never alters it.
        assert_eq!(sink, b"prompt \x1b[?2004h");
    }

    #[test]
    fn frame_message_wraps_in_paste_markers_when_paste_is_on() {
        assert_eq!(
            frame_message("line one\nline two", true),
            b"\x1b[200~line one\nline two\x1b[201~".to_vec()
        );
    }

    #[test]
    fn frame_message_collapses_newlines_when_paste_is_off() {
        assert_eq!(
            frame_message("line one\nline two\r\nthree\rfour", false),
            b"line one line two three four".to_vec()
        );
        assert!(frame_message("", true).is_empty());
        assert!(frame_message("", false).is_empty());
    }

    /// The single-pass strip turned this into a REAL paste-end; the
    /// sanitiser must leave no ESC behind however the markers nest.
    #[test]
    fn frame_message_survives_nested_paste_markers() {
        let framed = frame_message("a\x1b[20\x1b[201~1~b; rm -rf ~", true);
        assert_eq!(framed, b"\x1b[200~ab; rm -rf ~\x1b[201~".to_vec());
        let body = &framed[PASTE_START.len()..framed.len() - PASTE_END.len()];
        assert!(!body.contains(&0x1b));
        // Doubly nested, too.
        let framed = frame_message("\x1b[20\x1b[20\x1b[201~1~1~x", true);
        assert_eq!(framed, b"\x1b[200~x\x1b[201~".to_vec());
    }

    #[test]
    fn frame_message_strips_raw_control_bytes_in_both_modes() {
        // ESC sequence, C1 CSI (U+009B), Ctrl-C, Ctrl-U, BEL, DEL, NUL — none
        // may reach the program; tabs and newlines survive.
        let nasty = "x\x1b[A\u{9b}2~\x03\x15\x07\x7f\x00y\tz\nw";
        assert_eq!(
            frame_message(nasty, true),
            b"\x1b[200~x[A2~y\tz\nw\x1b[201~".to_vec()
        );
        assert_eq!(frame_message(nasty, false), b"x[A2~y\tz w".to_vec());
        // A message that is ONLY controls frames to nothing.
        assert!(frame_message("\x1b\x03\x07", true).is_empty());
    }

    #[test]
    fn frame_message_cannot_be_broken_out_of_by_its_own_content() {
        // An embedded paste-end would otherwise turn "; rm -rf" into typed
        // keystrokes after the paste closes.
        let framed = frame_message("before\x1b[201~; rm -rf ~\x1b[200~after", true);
        assert_eq!(framed, b"\x1b[200~before; rm -rf ~after\x1b[201~".to_vec());
    }
}
