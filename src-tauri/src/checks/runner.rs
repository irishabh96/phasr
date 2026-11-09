//! One check, outside any PTY: `$SHELL -l -c <command>` in the task's
//! worktree, merged stdout/stderr streamed to a log file and to the caller
//! (batched), a bounded tail kept for the row, and the whole process tree
//! killed on cancel / timeout / exit.
//!
//! Not a PTY on purpose: a check has no one typing into it, its exit code
//! is the result, and a pipe can't be fooled into an interactive prompt
//! (`stdin` is /dev/null, `CI=1`).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use crate::agent_signals::heuristics::incomplete_utf8_suffix;

/// The tail kept on the check row (the full output is in the log file).
pub const TAIL_BYTES: usize = 64 * 1024;
/// Output reaches listeners at most this often per run.
pub const OUTPUT_THROTTLE: Duration = Duration::from_millis(250);
/// After the shell exits, how long its output pipes may stay open (a
/// backgrounded grandchild holding them) before the group is killed.
const DRAIN_GRACE: Duration = Duration::from_millis(500);
/// SIGTERM → SIGKILL escalation on cancel / timeout: long enough for a test
/// runner to tear down its workers, short enough that Cancel feels instant.
const TERM_GRACE: Duration = Duration::from_secs(2);

/// The process groups of the checks running right now. Each check leads
/// its own group (`process_group(0)`), outside any PTY, so nothing else
/// would stop them when the app quits: `RunEvent::Exit` calls
/// `terminate_all_blocking`.
#[derive(Debug, Clone, Default)]
pub struct ProcessGroups(std::sync::Arc<parking_lot::Mutex<std::collections::HashSet<u32>>>);

impl ProcessGroups {
    fn add(&self, pgid: u32) {
        self.0.lock().insert(pgid);
    }

    fn remove(&self, pgid: u32) {
        self.0.lock().remove(&pgid);
    }

    pub fn len(&self) -> usize {
        self.0.lock().len()
    }

    /// SIGTERM every group, wait (≤ `grace`) for them to go, SIGKILL the
    /// rest. Blocking.
    pub fn terminate_all_blocking(&self, grace: Duration) {
        let groups: Vec<u32> = self.0.lock().iter().copied().collect();
        if groups.is_empty() {
            return;
        }
        #[cfg(unix)]
        {
            for &pgid in &groups {
                crate::util::proc::signal_process_group(pgid, libc::SIGTERM);
            }
            let deadline = Instant::now() + grace;
            // `killpg(pgid, 0)` fails once no process is left in the group.
            let alive = |pgid: u32| {
                libc::pid_t::try_from(pgid).is_ok_and(|g| g > 1 && unsafe { libc::killpg(g, 0) } == 0)
            };
            while Instant::now() < deadline && groups.iter().any(|&g| alive(g)) {
                std::thread::sleep(Duration::from_millis(25));
            }
            for &pgid in &groups {
                crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        let _ = grace;
        self.0.lock().clear();
    }
}

#[derive(Debug, Clone)]
pub struct CheckSpec {
    pub command: String,
    pub cwd: PathBuf,
    pub log_path: PathBuf,
    pub timeout: Duration,
    /// The shell to run `command` with (`-l -c` for shells known to take
    /// `-l`, plain `-c` otherwise).
    pub shell: String,
    /// Base environment (`pty::terminal_env`); `CI=1` is added on top.
    pub env: Vec<(OsString, OsString)>,
    /// Where the run's process group is registered while it runs.
    pub groups: ProcessGroups,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckEnd {
    /// The shell exited. `None` = killed by a signal / status unreadable.
    Exited(Option<i64>),
    TimedOut,
    Cancelled,
    /// The shell couldn't be started (or the log couldn't be written).
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct CheckResult {
    pub end: CheckEnd,
    /// Last `TAIL_BYTES` of merged output, lossily decoded.
    pub tail: String,
    pub duration: Duration,
}

/// Run `spec` to completion. `cancel` flipping to `true` stops it;
/// `on_output` receives merged output in batches (≤ 1 per
/// `OUTPUT_THROTTLE`, plus a final flush), never splitting a UTF-8
/// character.
pub async fn run_check<F>(spec: CheckSpec, mut cancel: watch::Receiver<bool>, mut on_output: F) -> CheckResult
where
    F: FnMut(String) + Send,
{
    let started = Instant::now();
    let fail = |msg: String| CheckResult {
        end: CheckEnd::Failed(msg),
        tail: String::new(),
        duration: started.elapsed(),
    };
    if let Some(parent) = spec.log_path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            return fail(format!("can't create the check log directory: {err}"));
        }
    }
    let mut log = match tokio::fs::File::create(&spec.log_path).await {
        Ok(f) => f,
        Err(err) => return fail(format!("can't write the check log: {err}")),
    };

    let mut args = crate::pty::login_args_for_shell(&spec.shell);
    args.push("-c".into());
    args.push(spec.command.clone());
    let mut cmd = tokio::process::Command::new(&spec.shell);
    cmd.args(&args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Backstop if this future is dropped mid-run; the group kill below
        // covers descendants.
        .kill_on_drop(true)
        .env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.env("CI", "1");
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => return fail(format!("failed to start `{}`: {err}", spec.shell)),
    };
    let pgid = child.id();
    if let Some(pgid) = pgid {
        spec.groups.add(pgid);
    }

    // Both pipes feed one channel: "merged" output, ordered by arrival.
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    if let Some(out) = child.stdout.take() {
        spawn_pipe_reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_pipe_reader(err, tx.clone());
    }
    drop(tx);

    let mut tail = Tail::default();
    let mut batch = Batch::default();
    let deadline = tokio::time::sleep(spec.timeout);
    tokio::pin!(deadline);
    let mut ticker = tokio::time::interval(OUTPUT_THROTTLE);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut pipes_open = true;

    let end = loop {
        tokio::select! {
            chunk = rx.recv(), if pipes_open => match chunk {
                Some(bytes) => {
                    let _ = log.write_all(&bytes).await;
                    tail.push(&bytes);
                    batch.push(&bytes);
                }
                None => pipes_open = false,
            },
            _ = ticker.tick() => batch.flush(&mut on_output),
            status = child.wait() => {
                break CheckEnd::Exited(status.ok().and_then(|s| s.code()).map(i64::from));
            }
            _ = &mut deadline => break CheckEnd::TimedOut,
            changed = cancel.changed() => {
                // A dropped sender isn't a cancel; keep running.
                if changed.is_ok() && *cancel.borrow() {
                    break CheckEnd::Cancelled;
                }
            }
        }
    };

    if matches!(end, CheckEnd::TimedOut | CheckEnd::Cancelled) {
        terminate(&mut child, pgid).await;
    }
    // Drain what's left; a grandchild that keeps a pipe open (a dev server
    // the check backgrounded) only gets `DRAIN_GRACE`.
    let drain_until = tokio::time::Instant::now() + DRAIN_GRACE;
    while pipes_open {
        match tokio::time::timeout_at(drain_until, rx.recv()).await {
            Ok(Some(bytes)) => {
                let _ = log.write_all(&bytes).await;
                tail.push(&bytes);
                batch.push(&bytes);
            }
            Ok(None) | Err(_) => pipes_open = false,
        }
    }
    // Whatever the check left behind dies with it: a check is done when
    // its shell is, and an orphaned watcher would hold the worktree.
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
    }
    if let Some(pgid) = pgid {
        spec.groups.remove(pgid);
    }
    batch.finish(&mut on_output);
    let _ = log.flush().await;

    CheckResult {
        end,
        tail: tail.into_string(),
        duration: started.elapsed(),
    }
}

fn spawn_pipe_reader<R>(mut pipe: R, tx: mpsc::Sender<Vec<u8>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// SIGTERM the group, give it `TERM_GRACE`, then SIGKILL it.
async fn terminate(child: &mut tokio::process::Child, pgid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        crate::util::proc::signal_process_group(pgid, libc::SIGTERM);
    }
    if tokio::time::timeout(TERM_GRACE, child.wait()).await.is_err() {
        #[cfg(unix)]
        if let Some(pgid) = pgid {
            crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
        }
        let _ = child.kill().await;
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

/// The last `TAIL_BYTES` of output.
#[derive(Default)]
struct Tail(Vec<u8>);

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
        if self.0.len() > TAIL_BYTES * 2 {
            let cut = self.0.len() - TAIL_BYTES;
            self.0.drain(..cut);
        }
    }

    fn into_string(mut self) -> String {
        if self.0.len() > TAIL_BYTES {
            let cut = self.0.len() - TAIL_BYTES;
            self.0.drain(..cut);
        }
        // Skip a UTF-8 continuation run the cut may have started in.
        let start = self.0.iter().take(3).take_while(|b| (**b & 0b1100_0000) == 0b1000_0000).count();
        String::from_utf8_lossy(&self.0[start..]).into_owned()
    }
}

/// Output waiting for the next throttled flush.
#[derive(Default)]
struct Batch(Vec<u8>);

impl Batch {
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    /// Emit everything but a trailing partial UTF-8 character.
    fn flush<F: FnMut(String)>(&mut self, on_output: &mut F) {
        let keep = incomplete_utf8_suffix(&self.0);
        if self.0.len() <= keep {
            return;
        }
        let rest = self.0.split_off(self.0.len() - keep);
        let text = String::from_utf8_lossy(&self.0).into_owned();
        self.0 = rest;
        on_output(text);
    }

    fn finish<F: FnMut(String)>(&mut self, on_output: &mut F) {
        if !self.0.is_empty() {
            on_output(String::from_utf8_lossy(&std::mem::take(&mut self.0)).into_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn spec(dir: &std::path::Path, command: &str, timeout: Duration) -> CheckSpec {
        CheckSpec {
            command: command.into(),
            cwd: dir.to_path_buf(),
            log_path: dir.join("logs").join("check.log"),
            timeout,
            shell: "/bin/sh".into(),
            env: std::env::vars_os().collect(),
            groups: ProcessGroups::default(),
        }
    }

    async fn run(spec: CheckSpec) -> (CheckResult, String) {
        let (_tx, rx) = watch::channel(false);
        let streamed = Arc::new(Mutex::new(String::new()));
        let s = streamed.clone();
        let result = run_check(spec, rx, move |chunk| s.lock().unwrap().push_str(&chunk)).await;
        let streamed = streamed.lock().unwrap().clone();
        (result, streamed)
    }

    fn assert_dead(pid_file: &std::path::Path) {
        let pid: libc::pid_t = std::fs::read_to_string(pid_file).unwrap().trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        // SAFETY: signal 0 only probes for existence.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "grandchild {pid} survived");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[tokio::test]
    async fn exit_codes_cwd_env_and_merged_output_land_everywhere() {
        let dir = tempfile::tempdir().unwrap();
        let (ok, streamed) = run(spec(
            dir.path(),
            "echo out-$CI; echo err >&2; basename \"$PWD\"",
            Duration::from_secs(10),
        ))
        .await;
        assert_eq!(ok.end, CheckEnd::Exited(Some(0)));
        let leaf = dir.path().file_name().unwrap().to_string_lossy().into_owned();
        for needle in ["out-1", "err", leaf.as_str()] {
            assert!(ok.tail.contains(needle), "tail missing {needle}: {:?}", ok.tail);
            assert!(streamed.contains(needle), "stream missing {needle}: {streamed:?}");
        }
        let log = std::fs::read_to_string(dir.path().join("logs/check.log")).unwrap();
        assert!(log.contains("out-1") && log.contains("err"));

        let (failed, _) = run(spec(dir.path(), "exit 3", Duration::from_secs(10))).await;
        assert_eq!(failed.end, CheckEnd::Exited(Some(3)));
    }

    #[tokio::test]
    async fn tail_keeps_only_the_last_64k() {
        let dir = tempfile::tempdir().unwrap();
        // ~200 KB: "start" must fall out of the tail, "the-end" must remain.
        let (res, _) = run(spec(
            dir.path(),
            "echo start; i=0; while [ $i -lt 4000 ]; do printf '%050d\\n' $i; i=$((i+1)); done; echo the-end",
            Duration::from_secs(20),
        ))
        .await;
        assert_eq!(res.end, CheckEnd::Exited(Some(0)));
        assert!(res.tail.len() <= TAIL_BYTES);
        assert!(res.tail.ends_with("the-end\n"));
        assert!(!res.tail.contains("start"));
    }

    #[tokio::test]
    async fn timeout_kills_the_tree_including_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("gc.pid");
        let started = Instant::now();
        let (res, _) = run(spec(
            dir.path(),
            &format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
            Duration::from_millis(400),
        ))
        .await;
        assert_eq!(res.end, CheckEnd::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        assert_dead(&pid_file);
    }

    #[tokio::test]
    async fn cancel_kills_the_tree_including_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("gc.pid");
        let (tx, rx) = watch::channel(false);
        let s = spec(
            dir.path(),
            &format!("sleep 30 & echo $! > '{}'; echo started; wait", pid_file.display()),
            Duration::from_secs(60),
        );
        let handle = tokio::spawn(run_check(s, rx, |_| {}));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() {
            assert!(Instant::now() < deadline, "check never started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tx.send(true).unwrap();
        let res = tokio::time::timeout(Duration::from_secs(6), handle).await.unwrap().unwrap();
        assert_eq!(res.end, CheckEnd::Cancelled);
        assert!(res.tail.contains("started"));
        assert_dead(&pid_file);
    }

    /// A check that exits but leaves a background process holding stdout:
    /// it must finish (not hang on the pipe) and the straggler must die.
    #[tokio::test]
    async fn a_lingering_grandchild_neither_hangs_nor_survives_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("gc.pid");
        let started = Instant::now();
        let (res, _) = run(spec(
            dir.path(),
            &format!("sleep 30 & echo $! > '{}'; echo done", pid_file.display()),
            Duration::from_secs(60),
        ))
        .await;
        assert_eq!(res.end, CheckEnd::Exited(Some(0)));
        assert!(started.elapsed() < Duration::from_secs(5), "hung on the pipe: {:?}", started.elapsed());
        assert_dead(&pid_file);
    }

    /// Quitting the app (`RunEvent::Exit`) kills a running check's whole
    /// process group — it runs outside any PTY, so nothing else would.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quitting_terminates_running_checks_and_their_children() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let mut s = spec(
            dir.path(),
            &format!("sleep 60 & echo $! > '{}'; wait", pid_file.display()),
            Duration::from_secs(120),
        );
        let groups = ProcessGroups::default();
        s.groups = groups.clone();
        let (_tx, rx) = watch::channel(false);
        let check = tokio::spawn(run_check(s, rx, |_| {}));
        let deadline = Instant::now() + Duration::from_secs(10);
        while (groups.len() == 0 || !pid_file.exists()) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(groups.len(), 1, "the running check's group is registered");
        let killer = groups.clone();
        tokio::task::spawn_blocking(move || killer.terminate_all_blocking(Duration::from_millis(500)))
            .await
            .unwrap();
        let res = tokio::time::timeout(Duration::from_secs(10), check).await.unwrap().unwrap();
        assert!(matches!(res.end, CheckEnd::Exited(_)), "{:?}", res.end);
        assert_dead(&pid_file);
        assert_eq!(groups.len(), 0);
    }

    #[tokio::test]
    async fn a_missing_shell_is_a_failure_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec(dir.path(), "true", Duration::from_secs(5));
        s.shell = "/definitely/not/a/shell".into();
        let (res, _) = run(s).await;
        assert!(matches!(res.end, CheckEnd::Failed(_)), "{:?}", res.end);
    }

    #[test]
    fn batches_never_split_a_utf8_character() {
        let mut b = Batch::default();
        let mut got = Vec::new();
        let euro = "€".as_bytes(); // 3 bytes
        b.push(b"a");
        b.push(&euro[..2]);
        b.flush(&mut |s| got.push(s));
        b.push(&euro[2..]);
        b.flush(&mut |s| got.push(s));
        assert_eq!(got, vec!["a".to_string(), "€".to_string()]);
    }
}
