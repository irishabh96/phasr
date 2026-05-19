use std::path::Path;

use super::error::run_git;

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
