//! Merge helpers. We intentionally don't expose a "merge into main"
//! command from the desktop app — Phase 7 routes that flow through
//! the user's git provider via `open_pull_request` instead. Only the
//! `has_unpushed_commits` helper is still wired up; the rest stays
//! here for any future local-merge UI.

#![allow(dead_code)]

use std::path::Path;

use serde::Serialize;

use super::error::{run_git, GitError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MergeOutcome {
    Clean { message: String },
    Conflicts { files: Vec<String> },
}

/// Returns true if `branch` has commits that aren't reachable from
/// `origin/<branch>`. Used to warn before deleting unmerged work.
pub fn has_unpushed_commits(repo_path: &Path, branch: &str) -> Result<bool, GitError> {
    // Bail out if the branch doesn't have an upstream — assume yes
    // (caller can still delete with confirmation).
    if run_git(
        repo_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{branch}"),
        ],
    )
    .is_err()
    {
        // Any commits at all on the local branch?
        let any = run_git(
            repo_path,
            &["rev-list", "--count", &format!("refs/heads/{branch}")],
        )?;
        return Ok(any.trim().parse::<u64>().unwrap_or(0) > 0);
    }
    let stdout = run_git(
        repo_path,
        &[
            "rev-list",
            "--count",
            &format!("origin/{branch}..refs/heads/{branch}"),
        ],
    )?;
    Ok(stdout.trim().parse::<u64>().unwrap_or(0) > 0)
}

/// Merge `branch` into `target` from `repo_path` (the main checkout,
/// not a worktree). Returns Clean on success, Conflicts on failure
/// listing the files that need attention. Either way the working
/// state is left as-is — the caller chooses to abort/commit.
pub fn merge_branch(
    repo_path: &Path,
    target: &str,
    branch: &str,
) -> Result<MergeOutcome, GitError> {
    // Resolve the real target. If the configured `target` doesn't
    // exist locally (e.g. workspace was created when default_branch
    // was hardcoded to "main" but the repo uses "master"), fall back
    // to whatever the repo's actual default is. Lets existing rows
    // continue to work without forcing a column rewrite.
    let resolved_target = if run_git(
        repo_path,
        &["rev-parse", "--verify", &format!("refs/heads/{target}")],
    )
    .is_ok()
    {
        target.to_string()
    } else {
        super::remote::get_default_branch(repo_path).ok_or_else(|| {
            GitError::CommandFailed(format!(
                "target branch `{target}` doesn't exist and no default could be detected"
            ))
        })?
    };

    // Ensure we're on the target branch first.
    run_git(repo_path, &["checkout", &resolved_target])?;

    // Try a no-ff merge so the topology stays clear (every workspace
    // gets a merge commit even when fast-forward would have worked).
    let output = std::process::Command::new("git")
        .args(["merge", "--no-ff", branch])
        .current_dir(repo_path)
        .output()
        .map_err(GitError::Io)?;
    if output.status.success() {
        let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(MergeOutcome::Clean { message });
    }

    // Non-zero exit: either a conflict or a different problem. If
    // there's no MERGE_HEAD, it wasn't a conflict — surface the
    // stderr as an error.
    if !repo_path.join(".git").join("MERGE_HEAD").exists() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::CommandFailed(stderr));
    }

    // Identify the conflicting files (`git diff --name-only --diff-filter=U`).
    let conflicts = run_git(
        repo_path,
        &["diff", "--name-only", "--diff-filter=U"],
    )?;
    Ok(MergeOutcome::Conflicts {
        files: conflicts.lines().map(String::from).collect(),
    })
}
