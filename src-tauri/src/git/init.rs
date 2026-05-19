use std::path::Path;

use super::error::{run_git, GitError};

/// Runs `git init -b main` in `path` and seeds it with an empty
/// initial commit so HEAD exists. Worktree creation requires a
/// reachable HEAD, and the user's first commit is the natural place
/// for that — we make it for them so "Initialize git here" lands them
/// in a repo that's already usable for a new workspace.
pub fn init_repo(path: &Path) -> Result<(), GitError> {
    run_git(path, &["init", "-b", "main"])?;

    // If the user has a global identity (`user.email` resolves), let
    // git use it. Otherwise inject a phasr fallback for THIS commit
    // only via `-c key=value`, so we don't overwrite any global config.
    let has_identity = run_git(path, &["config", "user.email"]).is_ok();
    let args: Vec<&str> = if has_identity {
        vec!["commit", "--allow-empty", "-m", "Initial commit"]
    } else {
        vec![
            "-c",
            "user.email=phasr@local",
            "-c",
            "user.name=Phasr",
            "commit",
            "--allow-empty",
            "-m",
            "Initial commit",
        ]
    };
    run_git(path, &args)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_repo_creates_main_with_initial_commit() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();

        let head = run_git(dir.path(), &["symbolic-ref", "--short", "HEAD"]).unwrap();
        assert_eq!(head.trim(), "main");

        let log = run_git(dir.path(), &["log", "--oneline"]).unwrap();
        assert!(log.contains("Initial commit"));
    }
}
