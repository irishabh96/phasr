use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use super::handle::{PtyError, PtyHandle, PtySpawnOptions};

/// Registry of currently-running PTYs, keyed by task id.
pub struct TaskRuntime {
    /// Where per-task log files are written. Defaults to `<data_dir>/logs/`.
    pub log_dir: PathBuf,
    running: Mutex<HashMap<String, Arc<PtyHandle>>>,
}

impl TaskRuntime {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            log_dir,
            running: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(
        &self,
        task_id: String,
        initial_command: Option<String>,
        initial_prompt: Option<String>,
        cwd: PathBuf,
        rows: u16,
        cols: u16,
    ) -> Result<Arc<PtyHandle>, PtyError> {
        {
            let running = self.running.lock();
            if running.contains_key(&task_id) {
                return Err(PtyError::AlreadyRunning);
            }
        }

        let log_path = self.log_dir.join(format!("{task_id}.log"));
        let handle = PtyHandle::spawn(PtySpawnOptions {
            task_id: task_id.clone(),
            initial_command,
            initial_prompt,
            cwd,
            log_path,
            rows,
            cols,
        })?;

        self.running.lock().insert(task_id, handle.clone());
        Ok(handle)
    }

    pub fn get(&self, task_id: &str) -> Option<Arc<PtyHandle>> {
        self.running.lock().get(task_id).cloned()
    }

    /// Snapshot of `(task_id, last-output wall-clock ms)` for every live
    /// PTY. Tasks with no live PTY are simply absent.
    pub fn activity(&self) -> Vec<(String, i64)> {
        self.running
            .lock()
            .iter()
            .map(|(id, handle)| (id.clone(), handle.last_output_ms()))
            .collect()
    }

    /// Forget a task after it has exited. Doesn't kill — call `kill` on
    /// the handle first if needed.
    pub fn drop_task(&self, task_id: &str) {
        self.running.lock().remove(task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fresh_runtime() -> (TaskRuntime, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let runtime = TaskRuntime::new(dir.path().to_path_buf());
        (runtime, dir)
    }

    #[test]
    fn shell_runs_initial_command_then_can_be_exited() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();

        // Send the agent command + an `exit` so the shell terminates and
        // the test doesn't hang on an idle prompt.
        let handle = runtime
            .spawn(
                "t1".into(),
                Some("echo hello-phasr; exit".into()),
                None,
                cwd,
                24,
                80,
            )
            .unwrap();

        let mut rx = handle.subscribe();
        let mut combined = String::new();
        let mut exited = false;

        // `Exit` must NOT stop the read loop: the exit-wait thread and the
        // output pipeline race, and on a loaded machine the child's death is
        // observed before its final bytes clear reader → coalescer →
        // broadcast (the 8 ms coalescing window alone guarantees a gap).
        // Keep draining until the needle lands or the deadline rules.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if exited && combined.contains("hello-phasr") {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out (exited: {exited}); output so far: {combined:?}");
            }
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&String::from_utf8_lossy(&chunk))
                }
                Ok(super::super::PtyEvent::Exit { .. }) => exited = true,
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("unexpected recv error: {e:?}"),
            }
        }

        assert!(combined.contains("hello-phasr"), "output was: {combined:?}");
    }

    #[test]
    fn prompt_waits_for_tui_marker_then_submits() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();

        // Stand-in "agent": announces a TUI takeover (alt-screen escape),
        // then reads one line — the prompt, which the writer thread must
        // only type AFTER the escape — and echoes it back transformed.
        // The `got-` prefix is what proves the prompt was submitted with
        // Enter, not just echoed by the terminal while being typed.
        let handle = runtime
            .spawn(
                "p1".into(),
                Some(r#"printf '\033[?1049h'; read line; echo "got-$line"; exit"#.into()),
                Some("hello-prompt".into()),
                cwd,
                24,
                80,
            )
            .unwrap();

        let mut rx = handle.subscribe();
        let mut combined = String::new();

        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if combined.contains("got-hello-prompt") {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("prompt never submitted; output so far: {combined:?}");
            }
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&String::from_utf8_lossy(&chunk))
                }
                // Same exit-vs-final-output race as the test above: the
                // child dying does not mean its last bytes have been
                // broadcast yet. Keep draining; the deadline decides.
                Ok(super::super::PtyEvent::Exit { .. }) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("unexpected recv error: {e:?}"),
            }
        }

        assert!(
            combined.contains("got-hello-prompt"),
            "output was: {combined:?}"
        );
    }

    #[test]
    fn spawning_same_task_twice_errors() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();
        runtime
            .spawn("dupe".into(), None, None, cwd.clone(), 24, 80)
            .unwrap();
        let result = runtime.spawn("dupe".into(), None, None, cwd, 24, 80);
        assert!(matches!(result, Err(PtyError::AlreadyRunning)));
    }

    /// Real end-to-end against the actual Claude CLI: the production
    /// command, a real login shell, a fresh directory, the real boot
    /// race. Passes only if the typed prompt is SUBMITTED — claude's
    /// "esc to interrupt" processing indicator only renders after a
    /// submit, never while text merely sits in the composer.
    ///
    /// Needs `claude` installed and logged in, so it's ignored by
    /// default: `cargo test e2e_real_claude -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn e2e_real_claude_prompt_submits() {
        // Scrub inherited Claude session markers: when this test is
        // itself launched from a Claude Code session, the spawned CLI
        // detects a nested session and changes behavior (transcript
        // off, restore notices). Production phasr never has these set.
        for (key, _) in std::env::vars() {
            if key.starts_with("CLAUDE") {
                std::env::remove_var(&key);
            }
        }

        let (runtime, _dir) = fresh_runtime();
        let workdir = tempfile::tempdir().unwrap();

        let handle = runtime
            .spawn(
                "e2e-claude".into(),
                Some("claude --dangerously-skip-permissions".into()),
                Some("hello from the phasr readiness e2e".into()),
                workdir.path().to_path_buf(),
                40,
                120,
            )
            .unwrap();

        let mut rx = handle.subscribe();
        let mut combined = String::new();
        let mut trust_accepted = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let submitted = loop {
            if combined.contains("esc to interrupt") {
                break true;
            }
            // A brand-new folder gets claude's first-run trust dialog
            // ("Quick safety check … 1. Yes, I trust this folder").
            // TUIs paint with cursor jumps between words, so match a
            // single word. Answer it the way the user would in phasr's
            // visible terminal — this is exactly the moment the writer
            // thread must NOT have already spent its prompt + Enter on.
            if !trust_accepted && combined.contains("safety") {
                trust_accepted = true;
                let _ = handle.write(b"\r");
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&String::from_utf8_lossy(&chunk))
                }
                Ok(super::super::PtyEvent::Exit { .. }) => break false,
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => continue,
            }
        };
        let _ = handle.kill();
        // Full stream for post-mortem — the assert below can only show
        // a tail.
        let dump = std::env::temp_dir().join("phasr-e2e-claude.log");
        let _ = std::fs::write(&dump, &combined);
        assert!(
            submitted,
            "prompt was never submitted; full output at {dump:?}; last output: {:?}",
            &combined[combined.len().saturating_sub(2000)..]
        );
    }

    #[test]
    fn kill_terminates_process() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();
        let handle = runtime.spawn("k1".into(), None, None, cwd, 24, 80).unwrap();

        let mut rx = handle.subscribe();
        handle.kill().unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if std::time::Instant::now() > deadline {
                panic!("kill didn't terminate the child");
            }
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Exit { .. }) => break,
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}
