use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("git command failed: {0}")]
    CommandFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid path")]
    InvalidPath,
}

impl serde::Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Upper bound on the stdout we hand back to a caller. A pathological
/// diff (a lockfile, a generated bundle, a minified vendor blob) can be
/// tens of MB; past this we truncate so a single git call can't flood
/// the IPC channel with one giant JSON string or spike memory on the
/// React side parsing it. This is well above any `status`/`worktree
/// list`/`log` output, so it only ever bites a runaway `diff`/`show`.
const MAX_STDOUT_BYTES: usize = 16 * 1024 * 1024;

/// Decode captured stdout, truncating past `MAX_STDOUT_BYTES`. Truncation
/// happens on a byte boundary; `from_utf8_lossy` cleans up any char split
/// at the cut. A marker is appended so the UI shows the diff is partial
/// rather than silently dropping the tail.
fn capture_stdout(stdout: Vec<u8>) -> String {
    if stdout.len() > MAX_STDOUT_BYTES {
        let mut s = String::from_utf8_lossy(&stdout[..MAX_STDOUT_BYTES]).into_owned();
        s.push_str("\n… [output truncated by phasr — 16 MiB cap]\n");
        s
    } else {
        String::from_utf8_lossy(&stdout).into_owned()
    }
}

/// `git` in `cwd`, for every call phasr makes.
///
/// `GIT_OPTIONAL_LOCKS=0`: phasr polls `status` / `diff` constantly (board
/// cards, check fingerprints, the Changes panel) in worktrees where an
/// agent or the user runs git at the same time. Without it each poll may
/// take `index.lock` to refresh the stat cache, and the user's own `git
/// commit` fails with "Unable to create index.lock". Set once here rather
/// than `--no-optional-locks` per call site, which kept being missed.
pub(super) fn git_command(cwd: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(cwd).env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

/// Refuse a branch name before it reaches git as an argument (see
/// `domain::repository_config::validate_branch_name`: `--mirror` read as
/// an option, `main:victim` as a refspec). Every git op that takes a
/// task's branch or base calls this, whatever the caller validated.
pub fn ensure_branch_name(name: &str) -> Result<(), GitError> {
    crate::domain::repository_config::validate_branch_name(name).map_err(GitError::CommandFailed)
}

/// `run_git` with an upper bound, for calls that talk to a remote
/// (`push`): a hung credential helper, an SSH host-key prompt with no
/// terminal, or a dead network would otherwise block the caller (and any
/// lock it holds) forever. The whole process group is killed on timeout —
/// ssh and credential helpers are git's children.
pub(super) fn run_git_with_timeout(
    cwd: &std::path::Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String, GitError> {
    use std::io::Read;
    use std::process::Stdio;

    let mut cmd = git_command(cwd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Never wait on a prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    // Drain both pipes on their own threads so a chatty remote can't fill
    // one and deadlock the wait below.
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            #[cfg(unix)]
            crate::util::proc::signal_process_group(child.id(), libc::SIGKILL);
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let Some(status) = status else {
        return Err(GitError::CommandFailed(format!(
            "git {} timed out after {}s",
            args.first().copied().unwrap_or_default(),
            timeout.as_secs()
        )));
    };
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(GitError::CommandFailed(if stderr.is_empty() {
            format!("git {} exited with {status}", args.join(" "))
        } else {
            stderr
        }));
    }
    Ok(capture_stdout(stdout))
}

/// Run `git` in `cwd` with the given args. Stdout returned on success;
/// non-zero exits become `CommandFailed(stderr)`.
///
/// Synchronous by design — it shells out to a subprocess and blocks the
/// calling thread. Command handlers MUST run it inside
/// `tokio::task::spawn_blocking` (see `commands::git::blocking_git`) so a
/// diff/status burst can't starve the async runtime (terminal input,
/// sync). Keeping it sync also lets the `git/*` unit tests call the ops
/// directly with real `git` under a plain `#[test]`.
pub(super) fn run_git(cwd: &std::path::Path, args: &[&str]) -> Result<String, GitError> {
    let output = git_command(cwd).args(args).output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::CommandFailed(if stderr.is_empty() {
            format!("git {} exited with {}", args.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(capture_stdout(output.stdout))
}

/// `run_git` with extra environment (e.g. `GIT_INDEX_FILE` for a scratch
/// index).
pub(super) fn run_git_env(
    cwd: &std::path::Path,
    args: &[&str],
    env: &[(&str, &std::ffi::OsStr)],
) -> Result<String, GitError> {
    let mut cmd = git_command(cwd);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::CommandFailed(if stderr.is_empty() {
            format!("git {} exited with {}", args.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(capture_stdout(output.stdout))
}

/// Like `run_git` but accepts stdin (used for `git apply` etc).
pub(super) fn run_git_with_stdin(
    cwd: &std::path::Path,
    args: &[&str],
    stdin: &str,
) -> Result<String, GitError> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = git_command(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut sin) = child.stdin.take() {
        sin.write_all(stdin.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::CommandFailed(stderr));
    }
    Ok(capture_stdout(output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init", "-q"]).unwrap();
        dir
    }

    /// Every call phasr makes runs with optional locks off, so a status
    /// poll never takes `index.lock` from under the user's own commit.
    #[test]
    fn every_git_call_runs_without_optional_locks() {
        let dir = scratch_repo();
        let out = run_git(dir.path(), &["-c", "alias.env=!printf %s \"$GIT_OPTIONAL_LOCKS\"", "env"]).unwrap();
        assert_eq!(out, "0");
        let out = run_git_with_stdin(dir.path(), &["-c", "alias.env=!printf %s \"$GIT_OPTIONAL_LOCKS\"", "env"], "")
            .unwrap();
        assert_eq!(out, "0");
    }

    #[test]
    fn a_hung_remote_call_times_out_instead_of_blocking_forever() {
        let dir = scratch_repo();
        let started = std::time::Instant::now();
        let err = run_git_with_timeout(
            dir.path(),
            &["-c", "alias.hang=!sleep 30", "hang"],
            std::time::Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // A quick call is unaffected.
        let ok = run_git_with_timeout(dir.path(), &["rev-parse", "--git-dir"], std::time::Duration::from_secs(10))
            .unwrap();
        assert_eq!(ok.trim(), ".git");
    }

    #[test]
    fn capture_stdout_passes_through_small_output() {
        let out = capture_stdout(b"hello\n".to_vec());
        assert_eq!(out, "hello\n");
    }

    #[test]
    fn capture_stdout_truncates_and_marks_oversized_output() {
        let big = vec![b'a'; MAX_STDOUT_BYTES + 4096];
        let out = capture_stdout(big);
        assert!(out.len() < MAX_STDOUT_BYTES + 200);
        assert!(out.contains("truncated by phasr"));
        // The kept prefix is intact up to the cap.
        assert!(out.starts_with(&"a".repeat(1024)));
    }
}
