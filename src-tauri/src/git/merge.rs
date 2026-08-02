//! Merge helpers used by the Sync-with-main and Merge-to-main flows.
//!
//! Sync runs INSIDE a worktree (the workspace's branch is checked out
//! there). Merge-to-main runs in the repository's MAIN checkout, where
//! the default branch lives. Both share `MergeOutcome` and the conflict
//! resolver helpers — once a merge has stopped on conflicts, the
//! caller drives `set_resolution` → `continue_after_resolution` or
//! `abort`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::error::{run_git, GitError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MergeOutcome {
    Clean { message: String },
    Conflicts { files: Vec<String> },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeStrategy {
    Merge,
    Squash,
    FastForward,
    Rebase,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InProgress {
    None,
    Merge { conflicts: Vec<String> },
    Rebase { conflicts: Vec<String> },
}

/// Returns true if `branch` has commits that aren't reachable from
/// `origin/<branch>`. Used to warn before deleting unmerged work.
pub fn has_unpushed_commits(repo_path: &Path, branch: &str) -> Result<bool, GitError> {
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

/// Merges `source_ref` into the current branch of `worktree`. Used by
/// the Sync-with-main flow — `worktree` is the workspace's worktree
/// and `source_ref` is typically `origin/<defaultBranch>`.
///
/// `MergeStrategy::Rebase` swaps the operation for `git rebase`; the
/// rest stay on `git merge` with the matching flag (`--squash`,
/// `--ff-only`, default `--no-ff`).
pub fn merge_into(
    worktree: &Path,
    source_ref: &str,
    strategy: MergeStrategy,
) -> Result<MergeOutcome, GitError> {
    require_clean_index(worktree)?;
    let args = match strategy {
        MergeStrategy::Merge => vec!["merge", "--no-ff", source_ref],
        MergeStrategy::Squash => vec!["merge", "--squash", source_ref],
        MergeStrategy::FastForward => vec!["merge", "--ff-only", source_ref],
        MergeStrategy::Rebase => vec!["rebase", source_ref],
    };
    run_or_conflict(worktree, &args, strategy)
}

/// Merges `source_branch` into `target_branch` from the main repo path.
/// Used by Merge-to-main — checks out target first, then merges. Aborts
/// up front if the main checkout has unstaged changes (a dirty working
/// tree makes the checkout fail with a confusing error).
pub fn merge_to(
    main_repo: &Path,
    target_branch: &str,
    source_branch: &str,
    strategy: MergeStrategy,
) -> Result<MergeOutcome, GitError> {
    require_clean_worktree(main_repo)?;
    let resolved = resolve_target(main_repo, target_branch)?;
    run_git(main_repo, &["checkout", &resolved])?;
    let args = match strategy {
        MergeStrategy::Merge => vec!["merge", "--no-ff", source_branch],
        MergeStrategy::Squash => vec!["merge", "--squash", source_branch],
        MergeStrategy::FastForward => vec!["merge", "--ff-only", source_branch],
        MergeStrategy::Rebase => {
            return Err(GitError::CommandFailed(
                "rebase is not a valid strategy for merge-to-main".into(),
            ));
        }
    };
    run_or_conflict(main_repo, &args, strategy)
}

fn run_or_conflict(
    cwd: &Path,
    args: &[&str],
    strategy: MergeStrategy,
) -> Result<MergeOutcome, GitError> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(GitError::Io)?;

    if output.status.success() {
        // Squash leaves the changes staged but not committed; finish
        // the job here so the caller sees one clean outcome.
        if matches!(strategy, MergeStrategy::Squash) {
            run_git(cwd, &["commit", "--no-edit"])?;
        }
        let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(MergeOutcome::Clean { message });
    }

    // Non-zero. If it landed in a merge- or rebase-in-progress state
    // there are conflict files. Otherwise surface the stderr.
    let progress = in_progress(cwd)?;
    match progress {
        InProgress::Merge { conflicts } | InProgress::Rebase { conflicts } => {
            Ok(MergeOutcome::Conflicts { files: conflicts })
        }
        InProgress::None => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(GitError::CommandFailed(stderr))
        }
    }
}

/// Returns the in-progress merge / rebase state for `cwd`. Used by the
/// frontend to know when to surface the conflict banner instead of the
/// commit textarea.
pub fn in_progress(cwd: &Path) -> Result<InProgress, GitError> {
    let git_dir = resolve_git_dir(cwd)?;
    if git_dir.join("MERGE_HEAD").exists() {
        return Ok(InProgress::Merge {
            conflicts: conflict_files(cwd)?,
        });
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Ok(InProgress::Rebase {
            conflicts: conflict_files(cwd)?,
        });
    }
    Ok(InProgress::None)
}

/// Aborts whatever merge or rebase is currently in progress. No-op if
/// nothing is in progress (returns Ok so the UI can call this without
/// branching).
pub fn abort(cwd: &Path) -> Result<(), GitError> {
    match in_progress(cwd)? {
        InProgress::Merge { .. } => {
            run_git(cwd, &["merge", "--abort"])?;
        }
        InProgress::Rebase { .. } => {
            run_git(cwd, &["rebase", "--abort"])?;
        }
        InProgress::None => {}
    }
    Ok(())
}

/// Finalises a paused merge or rebase. For merges this commits the
/// already-staged resolution; for rebases it advances to the next
/// commit (which may produce fresh conflicts — returns Conflicts in
/// that case).
pub fn continue_after_resolution(cwd: &Path) -> Result<MergeOutcome, GitError> {
    match in_progress(cwd)? {
        InProgress::Merge { conflicts } => {
            if !conflicts.is_empty() {
                return Ok(MergeOutcome::Conflicts { files: conflicts });
            }
            let stdout = run_git(cwd, &["commit", "--no-edit"])?;
            Ok(MergeOutcome::Clean {
                message: stdout.trim().to_string(),
            })
        }
        InProgress::Rebase { conflicts } => {
            if !conflicts.is_empty() {
                return Ok(MergeOutcome::Conflicts { files: conflicts });
            }
            // `rebase --continue` may stop on the next commit. Re-check.
            let output = std::process::Command::new("git")
                .args(["rebase", "--continue"])
                .current_dir(cwd)
                .env("GIT_EDITOR", "true")
                .output()
                .map_err(GitError::Io)?;
            if output.status.success() {
                let progress = in_progress(cwd)?;
                if let InProgress::Rebase { conflicts } = progress {
                    return Ok(MergeOutcome::Conflicts { files: conflicts });
                }
                let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Ok(MergeOutcome::Clean { message });
            }
            // Non-zero — likely fresh conflicts. Check in_progress.
            let progress = in_progress(cwd)?;
            if let InProgress::Rebase { conflicts } = progress {
                return Ok(MergeOutcome::Conflicts { files: conflicts });
            }
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(GitError::CommandFailed(stderr))
        }
        InProgress::None => Err(GitError::CommandFailed("no merge in progress".into())),
    }
}

/// Stages one side of a conflicting file and marks it resolved
/// (`git checkout --ours/--theirs <path>` then `git add <path>`).
///
/// NOTE: git INVERTS `--ours`/`--theirs` between merge and rebase.
/// In a MERGE, `--ours` = HEAD (the current branch), `--theirs` = the
/// incoming branch. In a REBASE, HEAD is the branch being replayed onto,
/// so `--ours` = that base/onto branch and `--theirs` = your own commit.
/// The raw flag is handed straight to git, so it's correct in both cases;
/// callers (the UI) must LABEL the sides accordingly per operation.
pub fn set_resolution(cwd: &Path, path: &str, side: ConflictSide) -> Result<(), GitError> {
    let flag = match side {
        ConflictSide::Ours => "--ours",
        ConflictSide::Theirs => "--theirs",
    };
    run_git(cwd, &["checkout", flag, "--", path])?;
    run_git(cwd, &["add", "--", path])?;
    Ok(())
}

fn conflict_files(cwd: &Path) -> Result<Vec<String>, GitError> {
    let stdout = run_git(cwd, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(stdout
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect())
}

fn resolve_target(repo_path: &Path, requested: &str) -> Result<String, GitError> {
    if run_git(
        repo_path,
        &["rev-parse", "--verify", &format!("refs/heads/{requested}")],
    )
    .is_ok()
    {
        return Ok(requested.to_string());
    }
    super::remote::get_default_branch(repo_path).ok_or_else(|| {
        GitError::CommandFailed(format!(
            "target branch `{requested}` doesn't exist and no default could be detected"
        ))
    })
}

fn resolve_git_dir(cwd: &Path) -> Result<std::path::PathBuf, GitError> {
    // Worktrees have a `.git` FILE pointing at the real gitdir under
    // the main repo's `.git/worktrees/<name>/`. `git rev-parse
    // --git-dir` resolves both cases.
    let stdout = run_git(cwd, &["rev-parse", "--git-dir"])?;
    let trimmed = stdout.trim();
    let p = std::path::PathBuf::from(trimmed);
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(cwd.join(p))
    }
}

fn require_clean_worktree(cwd: &Path) -> Result<(), GitError> {
    let stdout = run_git(cwd, &["status", "--porcelain"])?;
    if stdout.trim().is_empty() {
        Ok(())
    } else {
        Err(GitError::CommandFailed(
            "working tree has uncommitted changes — stash or commit first".into(),
        ))
    }
}

fn require_clean_index(cwd: &Path) -> Result<(), GitError> {
    // `--cached` checks only the index. We allow unstaged changes here
    // because the merge will refuse on its own if they'd be clobbered.
    let stdout = run_git(cwd, &["diff", "--cached", "--name-only"])?;
    if stdout.trim().is_empty() {
        Ok(())
    } else {
        Err(GitError::CommandFailed(
            "index has staged changes — commit or unstage first".into(),
        ))
    }
}

/// True when every commit of `branch` is reachable from `into` — the branch
/// carries no work that isn't already merged. Used by the worktree GC's safety
/// predicate. CONSERVATIVE on failure: an unknown ref / any git error reads as
/// "not merged" (kept), never as permission to delete.
pub fn branch_fully_merged(repo_path: &Path, branch: &str, into: &str) -> bool {
    std::process::Command::new("git")
        .args(["merge-base", "--is-ancestor", branch, into])
        .current_dir(repo_path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn init_repo(path: &Path) {
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t@example.com"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "tester"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(path)
            .status()
            .unwrap();
        std::fs::write(path.join("README.md"), "hi\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(path)
            .status()
            .unwrap();
    }

    fn add_commit(path: &Path, file: &str, contents: &str, msg: &str) {
        std::fs::write(path.join(file), contents).unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", msg])
            .current_dir(path)
            .status()
            .unwrap();
    }

    fn checkout(path: &Path, branch: &str, create: bool) {
        let mut args = vec!["checkout", "-q"];
        if create {
            args.push("-b");
        }
        args.push(branch);
        Command::new("git")
            .args(&args)
            .current_dir(path)
            .status()
            .unwrap();
    }

    #[test]
    fn merge_into_clean() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "f.txt", "f\n", "feature commit");
        checkout(dir.path(), "main", false);
        add_commit(dir.path(), "m.txt", "m\n", "main commit");
        // Merge feature into main.
        let outcome = merge_into(dir.path(), "feature", MergeStrategy::Merge).unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        assert!(dir.path().join("f.txt").exists());
        assert_eq!(in_progress(dir.path()).unwrap(), InProgress::None);
    }

    #[test]
    fn merge_into_with_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "README.md", "feature version\n", "feature edit");
        checkout(dir.path(), "main", false);
        add_commit(dir.path(), "README.md", "main version\n", "main edit");
        let outcome = merge_into(dir.path(), "feature", MergeStrategy::Merge).unwrap();
        match outcome {
            MergeOutcome::Conflicts { files } => {
                assert_eq!(files, vec!["README.md"]);
            }
            _ => panic!("expected conflicts"),
        }
        // in_progress should reflect the merge.
        let progress = in_progress(dir.path()).unwrap();
        assert!(matches!(progress, InProgress::Merge { .. }));
    }

    #[test]
    fn resolve_then_continue() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "README.md", "feature version\n", "feature edit");
        checkout(dir.path(), "main", false);
        add_commit(dir.path(), "README.md", "main version\n", "main edit");
        let outcome = merge_into(dir.path(), "feature", MergeStrategy::Merge).unwrap();
        assert!(matches!(outcome, MergeOutcome::Conflicts { .. }));

        // Resolve by picking ours.
        set_resolution(dir.path(), "README.md", ConflictSide::Ours).unwrap();
        let done = continue_after_resolution(dir.path()).unwrap();
        assert!(matches!(done, MergeOutcome::Clean { .. }));
        assert_eq!(in_progress(dir.path()).unwrap(), InProgress::None);

        let contents = std::fs::read_to_string(dir.path().join("README.md")).unwrap();
        assert_eq!(contents, "main version\n");
    }

    /// Sets up a repo mid-`git rebase main` with a conflict on README.md,
    /// left on the `feature` branch. feature's version is "feature version",
    /// main's is "main version".
    fn setup_rebase_conflict(dir: &Path) {
        init_repo(dir);
        checkout(dir, "feature", true);
        add_commit(dir, "README.md", "feature version\n", "feature edit");
        checkout(dir, "main", false);
        add_commit(dir, "README.md", "main version\n", "main edit");
        checkout(dir, "feature", false);
        // Replays feature's commit onto main → conflicts on README.md.
        // Non-zero exit (the conflict) is expected.
        let _ = Command::new("git")
            .args(["rebase", "main"])
            .current_dir(dir)
            .status()
            .unwrap();
    }

    #[test]
    fn rebase_conflict_inverts_ours_theirs() {
        // The whole point: during a rebase git INVERTS ours/theirs, so
        // `Ours` keeps the base (main) and `Theirs` keeps YOUR work
        // (feature) — the opposite of a merge. This is what the Changes
        // panel labels depend on.
        let a = tempfile::tempdir().unwrap();
        setup_rebase_conflict(a.path());
        assert!(matches!(
            in_progress(a.path()).unwrap(),
            InProgress::Rebase { .. }
        ));
        set_resolution(a.path(), "README.md", ConflictSide::Ours).unwrap();
        assert_eq!(
            std::fs::read_to_string(a.path().join("README.md")).unwrap(),
            "main version\n",
            "rebase --ours must keep the base (onto) branch's version",
        );

        let b = tempfile::tempdir().unwrap();
        setup_rebase_conflict(b.path());
        set_resolution(b.path(), "README.md", ConflictSide::Theirs).unwrap();
        assert_eq!(
            std::fs::read_to_string(b.path().join("README.md")).unwrap(),
            "feature version\n",
            "rebase --theirs must keep your own commit's version",
        );
    }

    #[test]
    fn abort_clears_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "README.md", "feature\n", "feature edit");
        checkout(dir.path(), "main", false);
        add_commit(dir.path(), "README.md", "main\n", "main edit");
        let _ = merge_into(dir.path(), "feature", MergeStrategy::Merge).unwrap();
        assert!(matches!(
            in_progress(dir.path()).unwrap(),
            InProgress::Merge { .. }
        ));

        abort(dir.path()).unwrap();
        assert_eq!(in_progress(dir.path()).unwrap(), InProgress::None);
        // Working tree is back to main's version.
        let contents = std::fs::read_to_string(dir.path().join("README.md")).unwrap();
        assert_eq!(contents, "main\n");
    }

    #[test]
    fn squash_collapses_commits() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "a.txt", "a\n", "feature 1");
        add_commit(dir.path(), "b.txt", "b\n", "feature 2");
        checkout(dir.path(), "main", false);
        let before = run_git(dir.path(), &["rev-list", "--count", "HEAD"]).unwrap();
        merge_into(dir.path(), "feature", MergeStrategy::Squash).unwrap();
        let after = run_git(dir.path(), &["rev-list", "--count", "HEAD"]).unwrap();
        assert_eq!(
            after.trim().parse::<u32>().unwrap(),
            before.trim().parse::<u32>().unwrap() + 1
        );
        assert!(dir.path().join("a.txt").exists());
        assert!(dir.path().join("b.txt").exists());
    }

    #[test]
    fn merge_to_runs_in_main_repo() {
        // Sketch of a worktree-style setup: main repo + feature branch
        // that we then merge into main using `merge_to`.
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        checkout(dir.path(), "feature", true);
        add_commit(dir.path(), "feat.txt", "feat\n", "feature work");
        checkout(dir.path(), "main", false);
        let outcome = merge_to(dir.path(), "main", "feature", MergeStrategy::FastForward).unwrap();
        assert!(matches!(outcome, MergeOutcome::Clean { .. }));
        assert!(dir.path().join("feat.txt").exists());
    }

    #[test]
    fn merge_to_refuses_dirty_worktree() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("dirty.txt"), "uncommitted").unwrap();
        let err = merge_to(dir.path(), "main", "main", MergeStrategy::FastForward).unwrap_err();
        match err {
            GitError::CommandFailed(msg) => assert!(msg.contains("uncommitted")),
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
