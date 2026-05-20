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

/// Run `git` in `cwd` with the given args. Stdout returned on success;
/// non-zero exits become `CommandFailed(stderr)`.
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
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
