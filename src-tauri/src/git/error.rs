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
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()?;
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

    let mut child = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
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
