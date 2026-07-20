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

    /// `env` sets extra child-process environment on TOP of the terminal's
    /// shaping. Every ordinary spawn passes an empty vec (byte-identical to
    /// before); only the scheduler's `spawn_ready_subtask` populates it with the
    /// per-ticket `PHASR_*` CLI vars (CLI1 / §J3).
    pub fn spawn(
        &self,
        task_id: String,
        initial_command: Option<String>,
        initial_prompt: Option<String>,
        cwd: PathBuf,
        rows: u16,
        cols: u16,
        env: Vec<(String, String)>,
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
            env,
        })?;

        self.running.lock().insert(task_id, handle.clone());
        Ok(handle)
    }

    pub fn get(&self, task_id: &str) -> Option<Arc<PtyHandle>> {
        self.running.lock().get(task_id).cloned()
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
                Vec::new(),
            )
            .unwrap();

        let mut rx = handle.subscribe();
        let mut combined = String::new();

        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            if std::time::Instant::now() > deadline {
                panic!("timed out; output so far: {combined:?}");
            }
            match rx.try_recv() {
                Ok(super::super::PtyEvent::Output { chunk, .. }) => combined.push_str(&chunk),
                Ok(super::super::PtyEvent::Exit { .. }) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("unexpected recv error: {e:?}"),
            }
        }

        assert!(combined.contains("hello-phasr"), "output was: {combined:?}");
    }

    #[test]
    fn spawning_same_task_twice_errors() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();
        runtime
            .spawn("dupe".into(), None, None, cwd.clone(), 24, 80, Vec::new())
            .unwrap();
        let result = runtime.spawn("dupe".into(), None, None, cwd, 24, 80, Vec::new());
        assert!(matches!(result, Err(PtyError::AlreadyRunning)));
    }

    #[test]
    fn kill_terminates_process() {
        let (runtime, _dir) = fresh_runtime();
        let cwd = std::env::temp_dir();
        let handle = runtime
            .spawn("k1".into(), None, None, cwd, 24, 80, Vec::new())
            .unwrap();

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
