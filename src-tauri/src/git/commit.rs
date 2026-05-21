use std::path::Path;

use serde::Serialize;

use super::error::{run_git, run_git_with_stdin, GitError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutput {
    pub sha: String,
    pub message: String,
}

/// Adds the given paths to the index. Pass an empty slice to stage all
/// tracked changes (equivalent to `git add -A`).
pub fn stage(cwd: &Path, paths: &[&str]) -> Result<(), GitError> {
    let mut args: Vec<&str> = vec!["add"];
    if paths.is_empty() {
        args.push("-A");
    } else {
        args.push("--");
        args.extend_from_slice(paths);
    }
    run_git(cwd, &args)?;
    Ok(())
}

/// Removes paths from the index without modifying the working tree.
pub fn unstage(cwd: &Path, paths: &[&str]) -> Result<(), GitError> {
    let mut args: Vec<&str> = vec!["restore", "--staged"];
    if paths.is_empty() {
        args.push(".");
    } else {
        args.push("--");
        args.extend_from_slice(paths);
    }
    run_git(cwd, &args)?;
    Ok(())
}

/// Discards working-tree changes (and untracked files if any are listed).
/// `paths` must be specified — never call this with an empty slice from
/// the UI without a confirm.
pub fn discard(cwd: &Path, paths: &[&str]) -> Result<(), GitError> {
    if paths.is_empty() {
        // Discarding everything: reset index + working tree, then sweep untracked.
        run_git(cwd, &["restore", "--staged", "--worktree", "--source=HEAD", ":/"])?;
        run_git(cwd, &["clean", "-fd"])?;
        return Ok(());
    }
    // `--staged --worktree` resets both the index and the working tree
    // to HEAD. Without `--staged`, a fully-staged file would end up in
    // a "still-staged + worktree-now-differs" partial state.
    let mut args: Vec<&str> = vec!["restore", "--staged", "--worktree", "--source=HEAD"];
    args.push("--");
    args.extend_from_slice(paths);
    // Tolerated: `restore` errors for paths not in HEAD (untracked
    // files). The `clean` below handles those.
    let _ = run_git(cwd, &args);
    let mut clean_args: Vec<&str> = vec!["clean", "-fd"];
    clean_args.push("--");
    clean_args.extend_from_slice(paths);
    let _ = run_git(cwd, &clean_args);
    Ok(())
}

pub fn commit(cwd: &Path, message: &str) -> Result<CommitOutput, GitError> {
    // Use `-F -` so we never have to escape multi-line messages on
    // shell. `--cleanup=verbatim` keeps the message exactly as given.
    let stdout = run_git_with_stdin(
        cwd,
        &["commit", "--cleanup=verbatim", "-F", "-"],
        message,
    )?;

    // Parse `[branch sha] message` from stdout.
    let sha = stdout
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .map(|s| s.trim_end_matches(']').to_string())
        .unwrap_or_default();
    Ok(CommitOutput {
        sha,
        message: message.to_string(),
    })
}

pub fn push(cwd: &Path, remote: &str, branch: &str) -> Result<(), GitError> {
    run_git(cwd, &["push", "--set-upstream", remote, branch])?;
    Ok(())
}
