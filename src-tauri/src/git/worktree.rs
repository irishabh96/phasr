use std::path::Path;

use serde::Serialize;

use super::error::{run_git, GitError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// Creates a new worktree at `worktree_path` checked out to a fresh
/// branch named `branch`, based on `base_ref` (typically `main` or
/// `origin/main`). Idempotent: if the worktree directory already exists
/// and is registered against this repo, returns Ok without re-creating.
pub fn create_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    base_ref: &str,
) -> Result<(), GitError> {
    // If the worktree already exists for this repo, no-op. We compare
    // by canonical path so that symlink prefixes (e.g. macOS
    // `/var/folders` ↔ `/private/var/folders`) don't cause spurious
    // misses.
    if list_worktrees(repo_path)?
        .iter()
        .any(|w| paths_equal(Path::new(&w.path), worktree_path))
    {
        return Ok(());
    }

    // Ensure parent dir exists. `git worktree add` will create the
    // leaf directory itself.
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let worktree_path_str = worktree_path.to_str().ok_or(GitError::InvalidPath)?;

    // If `branch` already exists locally, skip the `-b` flag.
    let branch_exists = run_git(
        repo_path,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_ok();

    if branch_exists {
        run_git(
            repo_path,
            &["worktree", "add", worktree_path_str, branch],
        )?;
        return Ok(());
    }

    // Resolve `base_ref` defensively: if the workspace's recorded
    // default branch (e.g. `main`) doesn't exist in this repo, fall
    // back to `HEAD` so we still get a usable starting point. Most
    // repos either use `main`, `master`, or something else entirely.
    let resolved_base = if run_git(repo_path, &["rev-parse", "--verify", base_ref]).is_ok() {
        base_ref.to_string()
    } else {
        "HEAD".to_string()
    };

    run_git(
        repo_path,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path_str,
            &resolved_base,
        ],
    )?;
    Ok(())
}

/// Removes a worktree (force). Pairs with `branch_delete` if the caller
/// also wants to delete the branch.
pub fn remove_worktree(repo_path: &Path, worktree_path: &Path) -> Result<(), GitError> {
    let path_str = worktree_path.to_str().ok_or(GitError::InvalidPath)?;
    // `git worktree remove` accepts `-f` but errors if the path isn't
    // a registered worktree; tolerate that case so cleanup is idempotent.
    let _ = run_git(repo_path, &["worktree", "remove", "-f", path_str]);
    let _ = run_git(repo_path, &["worktree", "prune"]);
    // The directory may linger if `git worktree remove` failed; clean
    // it up so re-creation works.
    if worktree_path.exists() {
        let _ = std::fs::remove_dir_all(worktree_path);
    }
    Ok(())
}

/// List all worktrees registered against `repo_path`. Uses the
/// porcelain output for stable parsing.
pub fn list_worktrees(repo_path: &Path) -> Result<Vec<WorktreeRef>, GitError> {
    let stdout = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut current: Option<(String, Option<String>, Option<String>)> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some((path, branch, head)) = current.take() {
                worktrees.push(WorktreeRef { path, branch, head });
            }
            current = Some((path.to_string(), None, None));
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            if let Some(entry) = current.as_mut() {
                entry.2 = Some(head.to_string());
            }
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(entry) = current.as_mut() {
                entry.1 = Some(branch.trim_start_matches("refs/heads/").to_string());
            }
        } else if line.is_empty() {
            if let Some((path, branch, head)) = current.take() {
                worktrees.push(WorktreeRef { path, branch, head });
            }
        }
    }
    if let Some((path, branch, head)) = current.take() {
        worktrees.push(WorktreeRef { path, branch, head });
    }
    Ok(worktrees)
}

/// Force-deletes a local branch. Idempotent: missing branches return Ok.
pub fn branch_delete(repo_path: &Path, branch: &str) -> Result<(), GitError> {
    if run_git(
        repo_path,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_err()
    {
        return Ok(());
    }
    run_git(repo_path, &["branch", "-D", branch])?;
    Ok(())
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Initialises a throwaway repo at `path` with one commit on `main`.
    fn init_repo(path: &Path) {
        Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(path).status().unwrap();
        Command::new("git").args(["config", "user.email", "t@example.com"]).current_dir(path).status().unwrap();
        Command::new("git").args(["config", "user.name", "tester"]).current_dir(path).status().unwrap();
        std::fs::write(path.join("README.md"), "hi").unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(path).status().unwrap();
        Command::new("git").args(["commit", "-qm", "init"]).current_dir(path).status().unwrap();
    }

    #[test]
    fn create_and_remove_worktree_round_trips() {
        let repo_dir = tempfile::tempdir().unwrap();
        let worktree_base = tempfile::tempdir().unwrap();
        init_repo(repo_dir.path());

        let worktree_path = worktree_base.path().join("task-abc");
        create_worktree(repo_dir.path(), &worktree_path, "phasr/test", "main").unwrap();

        assert!(worktree_path.join("README.md").exists());

        let canonical = std::fs::canonicalize(&worktree_path).unwrap();
        let list = list_worktrees(repo_dir.path()).unwrap();
        assert!(list
            .iter()
            .any(|w| Path::new(&w.path) == canonical));

        remove_worktree(repo_dir.path(), &worktree_path).unwrap();
        let list_after = list_worktrees(repo_dir.path()).unwrap();
        assert!(!list_after
            .iter()
            .any(|w| Path::new(&w.path) == canonical));
        assert!(!worktree_path.exists());
    }

    #[test]
    fn create_worktree_is_idempotent() {
        let repo_dir = tempfile::tempdir().unwrap();
        let worktree_base = tempfile::tempdir().unwrap();
        init_repo(repo_dir.path());

        let wt = worktree_base.path().join("task-x");
        create_worktree(repo_dir.path(), &wt, "phasr/x", "main").unwrap();
        // Calling again should not error.
        create_worktree(repo_dir.path(), &wt, "phasr/x", "main").unwrap();
        let canonical = std::fs::canonicalize(&wt).unwrap();
        let list = list_worktrees(repo_dir.path()).unwrap();
        assert_eq!(
            list.iter().filter(|w| Path::new(&w.path) == canonical).count(),
            1
        );
    }
}
