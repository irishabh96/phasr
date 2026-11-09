//! Bounded, non-interactive subprocess execution.
//!
//! Everything phasr shells out to *outside* a PTY — `which`, `<agent>
//! --version`, the login-shell PATH probe, check runs later — goes through
//! `run_with_timeout`. A bare `Command::output()` has no upper bound, and
//! that is not theoretical: `gemini --version` has been observed to hang for
//! well over two minutes on a real machine, which would wedge whatever
//! awaited it (agent detection, a settings page) indefinitely.

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcError {
    #[error("failed to start `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("`{program}` failed while running: {source}")]
    Wait {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("`{program}` timed out after {}ms", .timeout.as_millis())]
    TimedOut { program: String, timeout: Duration },
}

impl serde::Serialize for ProcError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Run `program args…` to completion, or kill it after `timeout`.
///
/// A non-zero exit is NOT an error — callers inspect `Output::status`;
/// only failing to start, failing to wait, or running out of time are.
///
/// The child gets its own process group so the timeout can kill the whole
/// tree, not just the direct child. That matters because the things we run
/// are frequently wrappers — a node shim, a login shell, a version manager
/// — whose grandchildren keep the stdout pipe open: killing only the
/// wrapper would leave `wait_with_output` blocked on a pipe that a
/// surviving grandchild still holds, and leave that grandchild running.
///
/// stdin is `/dev/null` so anything that tries to prompt (an rc file, a
/// first-run wizard) fails fast instead of waiting for input that will
/// never come.
pub async fn run_with_timeout<S: AsRef<OsStr>>(
    program: &str,
    args: &[S],
    cwd: Option<&Path>,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<Output, ProcError> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Backstop for every early-return path (including the caller's
        // future being dropped mid-await): the direct child never outlives
        // this call. The group kill below covers its descendants.
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd.spawn().map_err(|source| ProcError::Spawn {
        program: program.to_string(),
        source,
    })?;
    // With `process_group(0)` the child's pgid is its own pid. Captured
    // before `wait_with_output` takes ownership of the child.
    #[cfg(unix)]
    let pgid = child.id();

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|source| ProcError::Wait {
            program: program.to_string(),
            source,
        }),
        Err(_) => {
            // The wait future (and with it the child) was dropped by
            // `timeout`, so kill_on_drop has already SIGKILLed the direct
            // child. Take the rest of its group down with it.
            #[cfg(unix)]
            if let Some(pgid) = pgid {
                kill_process_group(pgid);
            }
            Err(ProcError::TimedOut {
                program: program.to_string(),
                timeout,
            })
        }
    }
}

#[cfg(unix)]
fn kill_process_group(pgid: u32) {
    signal_process_group(pgid, libc::SIGKILL);
}

/// Send `signal` to every process in group `pgid` (a child spawned with
/// `process_group(0)` leads a group whose id is its pid). Best-effort:
/// ESRCH — the group already exited — is the common, ignored outcome.
#[cfg(unix)]
pub fn signal_process_group(pgid: u32, signal: libc::c_int) {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return;
    };
    // pgid 0/1 would mean "our own group" / init — never what we spawned.
    if pgid <= 1 {
        return;
    }
    // SAFETY: killpg only sends a signal; ESRCH (group already gone) is
    // the expected outcome when the tree exited on its own and is ignored.
    unsafe {
        libc::killpg(pgid, signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn returns_output_with_cwd_and_env_applied() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_with_timeout(
            "/bin/sh",
            &["-c", "pwd; printf '%s' \"$PHASR_PROC_TEST\"; exit 4"],
            Some(dir.path()),
            &[("PHASR_PROC_TEST".into(), "env-ok".into())],
            Duration::from_secs(5),
        )
        .await
        .expect("a fast command must complete");

        let stdout = String::from_utf8_lossy(&out.stdout);
        // macOS tempdirs live under /var → /private/var; compare the tail.
        let leaf = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(stdout.contains(&leaf), "cwd not applied: {stdout:?}");
        assert!(stdout.ends_with("env-ok"), "env not applied: {stdout:?}");
        // Non-zero exit is data, not an error.
        assert_eq!(out.status.code(), Some(4));
    }

    #[tokio::test]
    async fn kills_a_hung_command_at_the_timeout() {
        let started = Instant::now();
        let err = run_with_timeout("sleep", &["10"], None, &[], Duration::from_millis(200))
            .await
            .expect_err("sleep 10 must not finish inside 200ms");

        assert!(matches!(err, ProcError::TimedOut { .. }), "got {err:?}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timeout took {:?}",
            started.elapsed()
        );
    }

    /// The reason for the process group: a wrapper whose grandchild holds
    /// stdout open. Killing only the wrapper leaves the grandchild alive
    /// (and, before the group kill, kept `wait_with_output` blocked).
    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_grandchildren_too() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());

        let err = run_with_timeout(
            "/bin/sh",
            &["-c", &script],
            None,
            &[],
            Duration::from_millis(300),
        )
        .await
        .expect_err("must time out");
        assert!(matches!(err, ProcError::TimedOut { .. }));

        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("grandchild wrote its pid")
            .trim()
            .parse()
            .unwrap();
        // Orphaned by the kill, the grandchild is reaped by launchd/init;
        // give that a moment, then it must be gone (ESRCH).
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            // SAFETY: signal 0 only probes for existence.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild {pid} survived the timeout"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn missing_program_is_a_spawn_error() {
        let err = run_with_timeout(
            "phasr-definitely-not-a-real-binary",
            &[] as &[&str],
            None,
            &[],
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ProcError::Spawn { .. }));
        assert!(err
            .to_string()
            .contains("phasr-definitely-not-a-real-binary"));
    }
}
