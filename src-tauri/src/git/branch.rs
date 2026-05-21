use std::path::Path;

use serde::Serialize;

use super::error::{run_git, GitError};

/// Snapshot of a worktree's branch position relative to its upstream.
/// Drives the workspace-header chip and gates the Push button in the
/// ChangesPanel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    /// Current branch name, or the literal `HEAD` when detached. When
    /// detached, callers should display the short SHA instead.
    pub branch: String,
    /// Symbolic upstream ref such as `origin/phasr/refactor-auth`.
    /// `None` when no upstream is set (newly-created local branch).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// At least one remote is configured. When `false` we hide the
    /// "no upstream" hint in the UI — there's nothing to push to.
    pub has_remote: bool,
    pub detached: bool,
}

pub fn branch_status(cwd: &Path) -> Result<BranchStatus, GitError> {
    let branch_raw = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch_raw.trim().to_string();
    let detached = branch == "HEAD";

    let has_remote = run_git(cwd, &["remote"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let upstream = run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let (ahead, behind) = match &upstream {
        Some(_) => parse_counts(
            &run_git(
                cwd,
                &["rev-list", "--count", "--left-right", "@{upstream}...HEAD"],
            )
            .unwrap_or_default(),
        ),
        None => (0, 0),
    };

    Ok(BranchStatus {
        branch,
        upstream,
        ahead,
        behind,
        has_remote,
        detached,
    })
}

/// Parses `git rev-list --count --left-right` output. The stdout is one
/// line with two tab-separated counts: `behind\tahead` (left = upstream,
/// right = HEAD).
fn parse_counts(stdout: &str) -> (u32, u32) {
    let line = stdout.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let behind: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn init_repo(path: &Path) {
        Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(path).status().unwrap();
        Command::new("git").args(["config", "user.email", "t@example.com"]).current_dir(path).status().unwrap();
        Command::new("git").args(["config", "user.name", "tester"]).current_dir(path).status().unwrap();
        std::fs::write(path.join("README.md"), "hi").unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(path).status().unwrap();
        Command::new("git").args(["commit", "-qm", "init"]).current_dir(path).status().unwrap();
    }

    fn add_commit(path: &Path, file: &str, msg: &str) {
        std::fs::write(path.join(file), msg).unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(path).status().unwrap();
        Command::new("git").args(["commit", "-qm", msg]).current_dir(path).status().unwrap();
    }

    #[test]
    fn no_remote_reports_branch_only() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());

        let s = branch_status(dir.path()).unwrap();
        assert_eq!(s.branch, "main");
        assert!(s.upstream.is_none());
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert!(!s.has_remote);
        assert!(!s.detached);
    }

    #[test]
    fn upstream_with_no_drift_reports_zero_zero() {
        // Create a bare "remote" and a clone that tracks it. After
        // cloning, HEAD === upstream so both counts should be 0.
        let remote = tempfile::tempdir().unwrap();
        Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).current_dir(remote.path()).status().unwrap();

        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        Command::new("git").args(["remote", "add", "origin", remote.path().to_str().unwrap()]).current_dir(work.path()).status().unwrap();
        Command::new("git").args(["push", "-q", "-u", "origin", "main"]).current_dir(work.path()).status().unwrap();

        let s = branch_status(work.path()).unwrap();
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert!(s.has_remote);
    }

    #[test]
    fn ahead_only_reports_ahead_count() {
        let remote = tempfile::tempdir().unwrap();
        Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).current_dir(remote.path()).status().unwrap();

        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        Command::new("git").args(["remote", "add", "origin", remote.path().to_str().unwrap()]).current_dir(work.path()).status().unwrap();
        Command::new("git").args(["push", "-q", "-u", "origin", "main"]).current_dir(work.path()).status().unwrap();

        add_commit(work.path(), "a.txt", "a");
        add_commit(work.path(), "b.txt", "b");

        let s = branch_status(work.path()).unwrap();
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 0);
    }

    #[test]
    fn diverged_reports_both_sides() {
        // Set up remote with one extra commit beyond what `work` has.
        let remote = tempfile::tempdir().unwrap();
        Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).current_dir(remote.path()).status().unwrap();

        let work = tempfile::tempdir().unwrap();
        init_repo(work.path());
        Command::new("git").args(["remote", "add", "origin", remote.path().to_str().unwrap()]).current_dir(work.path()).status().unwrap();
        Command::new("git").args(["push", "-q", "-u", "origin", "main"]).current_dir(work.path()).status().unwrap();

        // Second clone pushes a divergent commit to the remote.
        let other = tempfile::tempdir().unwrap();
        Command::new("git").args(["clone", "-q", remote.path().to_str().unwrap(), other.path().to_str().unwrap()]).status().unwrap();
        Command::new("git").args(["config", "user.email", "t@example.com"]).current_dir(other.path()).status().unwrap();
        Command::new("git").args(["config", "user.name", "tester"]).current_dir(other.path()).status().unwrap();
        add_commit(other.path(), "remote-only.txt", "remote-only");
        Command::new("git").args(["push", "-q"]).current_dir(other.path()).status().unwrap();

        // Now have `work` diverge locally too.
        add_commit(work.path(), "local-1.txt", "local-1");
        add_commit(work.path(), "local-2.txt", "local-2");
        // Fetch so upstream ref updates without touching local HEAD.
        Command::new("git").args(["fetch", "-q"]).current_dir(work.path()).status().unwrap();

        let s = branch_status(work.path()).unwrap();
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
    }

    #[test]
    fn detached_head_is_flagged() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "a.txt", "a");
        // Checkout HEAD directly to detach.
        let sha = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        Command::new("git").args(["checkout", "-q", &sha]).current_dir(dir.path()).status().unwrap();

        let s = branch_status(dir.path()).unwrap();
        assert!(s.detached);
        assert_eq!(s.branch, "HEAD");
        assert!(s.upstream.is_none());
    }

    #[test]
    fn parses_left_right_counts() {
        assert_eq!(parse_counts("3\t7\n"), (7, 3));
        assert_eq!(parse_counts("0\t0\n"), (0, 0));
        assert_eq!(parse_counts(""), (0, 0));
        assert_eq!(parse_counts("garbage"), (0, 0));
    }
}
