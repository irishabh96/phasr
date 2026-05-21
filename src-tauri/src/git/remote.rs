use std::path::Path;

use super::error::{run_git, GitError};

/// Best-effort lookup of `origin`'s fetch URL for a given local repo.
/// Returns `None` if the repo has no `origin` remote configured (or
/// isn't a git repo at all).
pub fn get_remote_url(repo_path: &Path) -> Option<String> {
    let stdout = run_git(repo_path, &["remote", "get-url", "origin"]).ok()?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Returns the repo's primary branch name. Tries (in order):
///   1. `git symbolic-ref --short HEAD`            current branch
///   2. `origin/HEAD` symbolic ref                 typical remote default
///   3. literal "main" / "master" if either exists
/// Falls back to `None` for detached HEAD with no `origin/HEAD`.
pub fn get_default_branch(repo_path: &Path) -> Option<String> {
    if let Ok(branch) = run_git(repo_path, &["symbolic-ref", "--short", "HEAD"]) {
        let trimmed = branch.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.into());
        }
    }
    if let Ok(branch) = run_git(repo_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(stripped) = branch.trim().strip_prefix("origin/") {
            return Some(stripped.into());
        }
    }
    for candidate in ["main", "master"] {
        if run_git(
            repo_path,
            &["rev-parse", "--verify", &format!("refs/heads/{candidate}")],
        )
        .is_ok()
        {
            return Some(candidate.into());
        }
    }
    None
}

/// Sorted list of local branch names (no `refs/heads/` prefix). Empty
/// repos return `[]` rather than erroring so the dropdown can fall back
/// to a free-text field gracefully.
pub fn list_local_branches(repo_path: &Path) -> Result<Vec<String>, GitError> {
    let stdout = run_git(
        repo_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    let mut names: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    Ok(names)
}
