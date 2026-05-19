use std::path::Path;

use super::error::{run_git, GitError};

/// Clone a template repo, then reset history so the user owns the
/// project from commit 0. Steps:
///   1. `git clone --depth 1 <url> <destination>`
///   2. Remove `<destination>/.git`
///   3. `git init -b main`
///   4. `git add -A`
///   5. `git commit -m "Initial commit from template"`
///
/// Same destination contract as `clone_repo`: must not exist or must be empty.
pub fn init_from_template(template_url: &str, destination: &Path) -> Result<(), GitError> {
    if destination.exists() {
        let is_empty = std::fs::read_dir(destination)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(GitError::CommandFailed(format!(
                "destination already exists and is non-empty: {}",
                destination.display()
            )));
        }
    }

    let parent = destination.parent().ok_or(GitError::InvalidPath)?;
    std::fs::create_dir_all(parent)?;
    let dest_str = destination.to_str().ok_or(GitError::InvalidPath)?;

    run_git(parent, &["clone", "--depth", "1", template_url, dest_str])?;

    // Drop the template's history.
    let git_dir = destination.join(".git");
    if git_dir.exists() {
        std::fs::remove_dir_all(&git_dir)?;
    }

    // Fresh repo owned by the user.
    run_git(destination, &["init", "-b", "main"])?;

    // Same identity fallback as init.rs: only inject `phasr@local` if
    // the user has no global git identity configured.
    let has_identity = run_git(destination, &["config", "user.email"]).is_ok();

    run_git(destination, &["add", "-A"])?;

    let commit_args: Vec<&str> = if has_identity {
        vec!["commit", "-m", "Initial commit from template"]
    } else {
        vec![
            "-c",
            "user.email=phasr@local",
            "-c",
            "user.name=Phasr",
            "commit",
            "-m",
            "Initial commit from template",
        ]
    };
    run_git(destination, &commit_args)?;

    Ok(())
}
