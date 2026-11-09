use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use super::handle::{PtyError, PtyHandle, SpawnSpec};

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

    pub fn spawn(&self, spec: SpawnSpec) -> Result<Arc<PtyHandle>, PtyError> {
        {
            let running = self.running.lock();
            if running.contains_key(&spec.task_id) {
                return Err(PtyError::AlreadyRunning);
            }
        }

        let task_id = spec.task_id.clone();
        let log_path = self.log_dir.join(format!("{task_id}.log"));
        let handle = PtyHandle::spawn(spec, log_path)?;

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

    /// App quit: take down every PTY's whole session (agents, dev servers,
    /// background jobs), in parallel, bounded by about `2 × grace`. Without
    /// this, jobs started in phasr terminals outlived the app.
    pub fn terminate_all_blocking(&self, grace: std::time::Duration) {
        let handles: Vec<Arc<PtyHandle>> = self.running.lock().values().cloned().collect();
        let threads: Vec<_> = handles
            .into_iter()
            .map(|h| std::thread::spawn(move || h.terminate_blocking(grace)))
            .collect();
        for t in threads {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::handle::LaunchMode;
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
                SpawnSpec::new("t1", cwd)
                    .with_initial_command(Some("echo hello-phasr; exit".into())),
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
                SpawnSpec::new("p1", cwd)
                    .with_initial_command(Some(
                        r#"printf '\033[?1049h'; read line; echo "got-$line"; exit"#.into(),
                    ))
                    .with_initial_prompt(Some("hello-prompt".into())),
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
        runtime.spawn(SpawnSpec::new("dupe", cwd.clone())).unwrap();
        let result = runtime.spawn(SpawnSpec::new("dupe", cwd));
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
                SpawnSpec::new("e2e-claude", workdir.path())
                    .with_initial_command(Some("claude --dangerously-skip-permissions".into()))
                    .with_initial_prompt(Some("hello from the phasr readiness e2e".into()))
                    .with_size(40, 120),
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

    /// Drain `rx` until the PTY exits; returns its exit code. Falls back to
    /// `exit_code()` so an exit that beat the subscription isn't missed.
    fn wait_for_exit(
        handle: &PtyHandle,
        rx: &mut tokio::sync::broadcast::Receiver<super::super::PtyEvent>,
        output: &mut String,
    ) -> Option<i64> {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "pty never exited; output so far: {output:?}"
            );
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    output.push_str(&String::from_utf8_lossy(&chunk))
                }
                Ok(super::super::PtyEvent::Exit { exit_code, .. }) => return exit_code,
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    if let Some(code) = handle.exit_code() {
                        return code;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(e) => panic!("unexpected recv error: {e:?}"),
            }
        }
    }

    /// Keep reading output (past Exit — see the first test for why) until
    /// `needle` shows up.
    fn drain_until(
        rx: &mut tokio::sync::broadcast::Receiver<super::super::PtyEvent>,
        output: &mut String,
        needle: &str,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !output.contains(needle) {
            assert!(
                std::time::Instant::now() < deadline,
                "never saw {needle:?}; output so far: {output:?}"
            );
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    output.push_str(&String::from_utf8_lossy(&chunk))
                }
                Ok(super::super::PtyEvent::Exit { .. }) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                    panic!("channel closed before {needle:?}; output: {output:?}")
                }
            }
        }
    }

    /// Exec mode's whole point: the PTY's exit code IS the command's, not
    /// the surrounding interactive shell's. Runs through the account's
    /// real login shell, like production.
    #[test]
    fn exec_mode_reports_the_commands_exit_code() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(
                SpawnSpec::new("exec-3", std::env::temp_dir())
                    .with_launch(LaunchMode::Exec("exit 3".into())),
            )
            .unwrap();
        let mut rx = handle.subscribe();
        let mut output = String::new();
        assert_eq!(wait_for_exit(&handle, &mut rx, &mut output), Some(3));

        let ok = runtime
            .spawn(
                SpawnSpec::new("exec-0", std::env::temp_dir())
                    .with_launch(LaunchMode::Exec("true".into())),
            )
            .unwrap();
        let mut rx = ok.subscribe();
        assert_eq!(wait_for_exit(&ok, &mut rx, &mut output), Some(0));
    }

    #[test]
    fn exec_mode_rejects_a_typed_initial_command() {
        let (runtime, _dir) = fresh_runtime();
        let result = runtime.spawn(
            SpawnSpec::new("exec-typed", std::env::temp_dir())
                .with_launch(LaunchMode::Exec("true".into()))
                .with_initial_command(Some("echo typed".into())),
        );
        assert!(matches!(result, Err(PtyError::Pty(_))));
    }

    /// `extra_env` reaches the child, and wins over phasr's own terminal
    /// defaults (TERM is set by `terminal_env`). Also exercises
    /// `shell_override` — `/bin/sh` keeps the output free of the
    /// developer's rc-file noise.
    #[test]
    fn extra_env_reaches_the_child_and_overrides_terminal_defaults() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(
                SpawnSpec::new("env", std::env::temp_dir())
                    .with_shell(Some("/bin/sh".into()))
                    .with_env("PHASR_TEST", "from-spawn-spec")
                    .with_env("TERM", "phasr-test-term")
                    .with_launch(LaunchMode::Exec(
                        r#"echo "env=$PHASR_TEST term=$TERM""#.into(),
                    )),
            )
            .unwrap();
        let mut rx = handle.subscribe();
        let mut output = String::new();
        drain_until(
            &mut rx,
            &mut output,
            "env=from-spawn-spec term=phasr-test-term",
        );
    }

    /// With the program in paste mode, `send_message` delivers the text
    /// inside paste markers and then submits it. The stand-in program turns
    /// on bracketed paste, reads one line, and prints it with ESC made
    /// visible as `E`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn send_message_wraps_in_paste_markers_when_the_program_asks() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(
                SpawnSpec::new("paste-on", std::env::temp_dir())
                    .with_shell(Some("/bin/sh".into()))
                    .with_launch(LaunchMode::Exec(
                        r#"printf '\033[?2004h'; IFS= read -r line; printf 'got[%s]\n' "$line" | tr '\033' 'E'"#
                            .into(),
                    )),
            )
            .unwrap();
        let mut rx = handle.subscribe();

        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !handle.bracketed_paste_enabled() {
            assert!(
                std::time::Instant::now() < deadline,
                "paste mode never detected"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        handle.send_message("hello-msg", true).await.unwrap();

        let mut output = String::new();
        let handle_for_drain = handle.clone();
        let output = tokio::task::spawn_blocking(move || {
            let _keep = handle_for_drain;
            drain_until(&mut rx, &mut output, "got[E[200~hello-msgE[201~]");
            output
        })
        .await
        .unwrap();
        assert!(output.contains("got[E[200~hello-msgE[201~]"));
    }

    /// Paste mode off: no markers, and a multi-line message is folded onto
    /// one line instead of submitting each line separately.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn send_message_collapses_newlines_without_paste_mode() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(
                SpawnSpec::new("paste-off", std::env::temp_dir())
                    .with_shell(Some("/bin/sh".into()))
                    .with_launch(LaunchMode::Exec(
                        r#"IFS= read -r line; printf 'got[%s]\n' "$line""#.into(),
                    )),
            )
            .unwrap();
        let mut rx = handle.subscribe();
        assert!(!handle.bracketed_paste_enabled());

        handle.send_message("one\ntwo", true).await.unwrap();

        let output = tokio::task::spawn_blocking(move || {
            let mut output = String::new();
            drain_until(&mut rx, &mut output, "got[one two]");
            output
        })
        .await
        .unwrap();
        assert!(output.contains("got[one two]"));
    }

    /// An agent that exited back to the shell must not receive a message:
    /// pasted text + Enter would run as a shell command.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn send_message_refuses_when_the_shell_is_back_in_the_foreground() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(SpawnSpec::new("bare-shell", std::env::temp_dir()).with_shell(Some("/bin/sh".into())))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while handle.shell_in_foreground() != Some(true) {
            assert!(std::time::Instant::now() < deadline, "shell never took the foreground");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let err = handle.send_message("echo `id`", true).await.unwrap_err();
        assert_eq!(err.to_string(), "agent not running");
        handle.kill().unwrap();
    }

    /// Exec mode: the final burst of output is broadcast BEFORE `Exit`, so
    /// a viewer that stops at `Exit` still sees the failing summary.
    #[test]
    fn exec_output_is_flushed_before_exit() {
        let (runtime, _dir) = fresh_runtime();
        let handle = runtime
            .spawn(
                SpawnSpec::new("flush", std::env::temp_dir())
                    .with_shell(Some("/bin/sh".into()))
                    .with_launch(LaunchMode::Exec("printf 'summary-%s' tail; exit 3".into())),
            )
            .unwrap();
        let mut rx = handle.subscribe();
        let mut combined = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            assert!(std::time::Instant::now() < deadline, "no exit; output: {combined:?}");
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&String::from_utf8_lossy(&chunk))
                }
                Ok(super::super::PtyEvent::Exit { exit_code, .. }) => {
                    assert_eq!(exit_code, Some(3));
                    break;
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("unexpected recv error: {e:?}"),
            }
        }
        assert!(combined.contains("summary-tail"), "output before Exit: {combined:?}");
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // Exists and isn't a zombie awaiting its reaper.
        let exists = unsafe { libc::kill(pid, 0) == 0 };
        exists
            && !std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim_start().starts_with('Z'))
                .unwrap_or(false)
    }

    /// Stop must reach every job the terminal started — a background job
    /// and a foreground one in their own process groups, one of them
    /// ignoring SIGHUP and SIGTERM (only SIGKILL gets it).
    #[cfg(unix)]
    #[test]
    fn terminate_kills_the_whole_session_with_escalation() {
        let (runtime, dir) = fresh_runtime();
        let pids = dir.path().join("pids");
        let script = format!(
            "sleep 300 & echo $! >> {p}; sh -c 'trap \"\" HUP TERM; echo $$ >> {p}; while :; do sleep 1; done'",
            p = pids.display()
        );
        let handle = runtime
            .spawn(
                SpawnSpec::new("session", std::env::temp_dir())
                    .with_shell(Some("/bin/sh".into()))
                    .with_initial_command(Some(script)),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let read = || -> Vec<i32> {
            std::fs::read_to_string(&pids)
                .unwrap_or_default()
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        };
        while read().len() < 2 {
            assert!(std::time::Instant::now() < deadline, "jobs never started");
            std::thread::sleep(Duration::from_millis(50));
        }
        let jobs = read();
        assert!(jobs.iter().all(|p| alive(*p)));

        handle.terminate_blocking(Duration::from_millis(400));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while jobs.iter().any(|p| alive(*p)) {
            assert!(std::time::Instant::now() < deadline, "survivors: {:?}", jobs.iter().filter(|p| alive(**p)).collect::<Vec<_>>());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn kill_terminates_process() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();
        let handle = runtime.spawn(SpawnSpec::new("k1", cwd)).unwrap();

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
