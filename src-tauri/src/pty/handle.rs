use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::broadcast;

/// Event emitted by a running PTY task.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
}

impl PtyHandle {
    /// Spawns an **interactive login shell** (`$SHELL -i -l`) inside the
    /// PTY. If `initial_command` is set, it's typed into the shell after
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

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        // No flags — shells (zsh, bash, fish) auto-detect a TTY on stdin
        // and go interactive. Skipping `-l` avoids login-shell rc files
        // that sometimes contain non-idempotent setup.
        cmd.cwd(&cwd);

        // Hint to prompts that this is a colour-capable TTY.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Keep the user's PATH and HOME — agents need them.
        for (key, value) in std::env::vars_os() {
            if key != "TERM" && key != "COLORTERM" {
                cmd.env(key, value);
            }
        }

        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Pty(e.to_string()))?;
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
        std::thread::Builder::new()
            .name(format!("phasr-pty-{task_id_for_thread}"))
            .spawn(move || pump_pty_output(task_id_for_thread, reader, log_file, tx_for_thread))
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

fn pump_pty_output(
    task_id: String,
    mut reader: Box<dyn Read + Send>,
    mut log_file: std::fs::File,
    tx: broadcast::Sender<PtyEvent>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let slice = &buf[..n];
                let _ = log_file.write_all(slice);
                let chunk = String::from_utf8_lossy(slice).into_owned();
                // If no subscribers, the send fails — that's fine, we still
                // wrote to the log.
                let _ = tx.send(PtyEvent::Output {
                    task_id: task_id.clone(),
                    chunk,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
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
