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

use super::error::{ensure_branch_name, git_command, run_git, GitError};

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

/// Whether `branch` has commits that would be LOST if it (and its
/// worktree) went away: reachable from nowhere else that keeps them —
/// not `origin/<branch>`, and not any of `kept_in` (e.g. the branch it was
/// merged into, its base; local or `origin/`). A branch fully merged into
/// its target (a local merge, which never pushes) has nothing to lose,
/// unlike what `has_unpushed_commits` would say for it. Refs that don't
/// exist are skipped. `false` when the branch itself doesn't exist.
pub fn has_unsaved_commits(repo_path: &Path, branch: &str, kept_in: &[&str]) -> Result<bool, GitError> {
    let exists = |r: &str| run_git(repo_path, &["rev-parse", "--verify", "--quiet", r]).is_ok();
    let head = format!("refs/heads/{branch}");
    if !exists(&head) {
        return Ok(false);
    }
    let mut keepers = vec![format!("refs/remotes/origin/{branch}")];
    for other in kept_in {
        keepers.push(format!("refs/heads/{other}"));
        keepers.push(format!("refs/remotes/origin/{other}"));
    }
    let mut args: Vec<String> = vec!["rev-list".into(), "--count".into(), head, "--not".into()];
    args.extend(keepers.into_iter().filter(|r| exists(r)));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = run_git(repo_path, &args)?;
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
    // `origin/<base>` / `<base>`, from a synced base: never an option or a
    // refspec (`rebase` takes no `--` before its upstream).
    ensure_branch_name(source_ref)?;
    require_clean_index(worktree)?;
    let args = match strategy {
        MergeStrategy::Merge => vec!["merge", "--no-ff", "--", source_ref],
        MergeStrategy::Squash => vec!["merge", "--squash", "--", source_ref],
        MergeStrategy::FastForward => vec!["merge", "--ff-only", "--", source_ref],
        MergeStrategy::Rebase => vec!["rebase", source_ref],
    };
    run_or_conflict(worktree, &args, strategy)
}

/// What `merge_to` did: the outcome, and the branch it ACTUALLY merged
/// into — the one checked out when the merge ran, which is what a
/// `merged_into` record must name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMerge {
    pub outcome: MergeOutcome,
    pub into: String,
}

/// Merges `source_branch` into `target_branch` in the repository's main
/// checkout. Used by "Merge locally".
///
/// The merge lands on `target_branch` or nowhere — never on whatever the
/// checkout happens to have checked out:
/// - `target_branch` must exist locally, or as `origin/<target>` (then a
///   local branch tracking it is created, as `git switch <target>` would);
///   otherwise this refuses. (It used to fall back to the checkout's
///   CURRENT branch, then record the requested base as `merged_into`.)
/// - The checkout must be clean, and not mid-merge/rebase: switching
///   branches under someone's uncommitted work, or committing it into the
///   merge (a squash commits the whole index), is never safe.
/// - It is switched to `target_branch` when it's on another branch; if the
///   merge then fails outright (not conflicts) it's switched back.
///
/// Both names come from synced rows: validated, and passed after `--` /
/// as `refs/heads/…` so neither can be an option or a refspec.
pub fn merge_to(
    main_repo: &Path,
    target_branch: &str,
    source_branch: &str,
    strategy: MergeStrategy,
) -> Result<LocalMerge, GitError> {
    ensure_branch_name(target_branch)?;
    ensure_branch_name(source_branch)?;
    if matches!(strategy, MergeStrategy::Rebase) {
        return Err(GitError::CommandFailed(
            "rebase is not a valid strategy for merge-to-main".into(),
        ));
    }
    let exists = |r: &str| run_git(main_repo, &["rev-parse", "--verify", "--quiet", r]).is_ok();
    let local_target = format!("refs/heads/{target_branch}");
    let remote_target = format!("refs/remotes/origin/{target_branch}");
    let target_exists = exists(&local_target);
    if !target_exists && !exists(&remote_target) {
        return Err(GitError::CommandFailed(format!(
            "the base branch `{target_branch}` doesn't exist in this repository"
        )));
    }
    if !exists(&format!("refs/heads/{source_branch}")) {
        return Err(GitError::CommandFailed(format!(
            "the task's branch `{source_branch}` doesn't exist in this repository"
        )));
    }
    if !matches!(in_progress(main_repo)?, InProgress::None) {
        return Err(GitError::CommandFailed(
            "a merge or rebase is already in progress in the repository's checkout — finish or abort it first".into(),
        ));
    }
    let original = current_branch(main_repo)?;
    if !is_clean(main_repo)? {
        return Err(GitError::CommandFailed(match original.as_deref() {
            Some(current) if current != target_branch => format!(
                "the repository's checkout is on `{current}` with uncommitted changes — commit or stash them before merging into `{target_branch}`"
            ),
            _ => format!(
                "the repository's checkout has uncommitted changes — commit or stash them before merging into `{target_branch}`"
            ),
        }));
    }
    let switched = original.as_deref() != Some(target_branch);
    if !target_exists {
        run_git(main_repo, &["branch", "--track", "--", target_branch, &remote_target])?;
    }
    if switched {
        // `<branch> --`: a branch, never a path; validated, so never an
        // option either.
        run_git(main_repo, &["checkout", "-q", target_branch, "--"])?;
    }
    if current_branch(main_repo)?.as_deref() != Some(target_branch) {
        return Err(GitError::CommandFailed(format!(
            "couldn't switch the repository's checkout to `{target_branch}`"
        )));
    }
    let source_ref = format!("refs/heads/{source_branch}");
    let flag = match strategy {
        MergeStrategy::Merge => "--no-ff",
        MergeStrategy::Squash => "--squash",
        MergeStrategy::FastForward => "--ff-only",
        MergeStrategy::Rebase => unreachable!("refused above"),
    };
    match run_or_conflict(main_repo, &["merge", flag, "--", &source_ref], strategy) {
        Ok(outcome) => Ok(LocalMerge {
            outcome,
            into: target_branch.to_string(),
        }),
        Err(err) => {
            // Nothing was merged (a failed ff-only, a refused merge, an
            // aborted squash): put the checkout back where the user left it.
            if let (true, Some(original)) = (switched, original.as_deref()) {
                if matches!(in_progress(main_repo), Ok(InProgress::None)) {
                    let _ = run_git(main_repo, &["checkout", "-q", original, "--"]);
                }
            }
            Err(err)
        }
    }
}

fn run_or_conflict(
    cwd: &Path,
    args: &[&str],
    strategy: MergeStrategy,
) -> Result<MergeOutcome, GitError> {
    let output = git_command(cwd).args(args).output().map_err(GitError::Io)?;

    if output.status.success() {
        // Squash leaves the changes staged but not committed; finish
        // the job here so the caller sees one clean outcome.
        if matches!(strategy, MergeStrategy::Squash) {
            run_git(cwd, &["commit", "--no-edit"])?;
        }
        let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(MergeOutcome::Clean { message });
    }

    // A conflicted `--squash` writes no MERGE_HEAD, so it never shows up
    // as a merge in progress: the conflict UI wouldn't appear, and the
    // checkout would be left half-merged (`UU`) and dirty, blocking the
    // next merge. There's nothing to "continue" either — so undo it.
    if matches!(strategy, MergeStrategy::Squash) {
        let conflicts = conflict_files(cwd).unwrap_or_default();
        run_git(cwd, &["reset", "--merge"])?;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitError::CommandFailed(if conflicts.is_empty() {
            stderr
        } else {
            format!(
                "squash merge stopped on conflicts in {} — nothing was changed; merge with the Merge strategy to resolve them",
                conflicts.join(", ")
            )
        }));
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
            let output = git_command(cwd)
                .args(["rebase", "--continue"])
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

/// Local branches whose tip is the in-progress merge's `MERGE_HEAD` — i.e.
/// what is being merged into the current branch. Empty when no merge is in
/// progress. Read BEFORE `continue_after_resolution` (which consumes
/// MERGE_HEAD) to learn whether the merge being finished was a task's
/// branch going into the checkout's branch.
pub fn merge_head_branches(cwd: &Path) -> Result<Vec<String>, GitError> {
    let Ok(sha) = run_git(cwd, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]) else {
        return Ok(Vec::new());
    };
    let out = run_git(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "--points-at", sha.trim(), "refs/heads/"],
    )?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// The branch `cwd` has checked out; `None` when detached.
pub fn current_branch(cwd: &Path) -> Result<Option<String>, GitError> {
    let out = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let name = out.trim();
    Ok((name != "HEAD" && !name.is_empty()).then(|| name.to_string()))
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

/// No staged, unstaged or untracked (non-ignored) changes.
fn is_clean(cwd: &Path) -> Result<bool, GitError> {
    Ok(run_git(cwd, &["status", "--porcelain"])?.trim().is_empty())
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
        let outcome = merge_to(dir.path(), "main", "feature", MergeStrategy::FastForward).unwrap().outcome;
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

    /// The M7 gap: a merge-to-main that stopped on conflicts and is then
    /// continued must still be recognisable as "task branch → main".
    #[test]
    fn merge_head_branches_names_the_branch_being_merged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(p).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(p.join("f.txt"), "base\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        git(&["checkout", "-qb", "phasr/task"]);
        std::fs::write(p.join("f.txt"), "task\n").unwrap();
        git(&["commit", "-qam", "task"]);
        git(&["checkout", "-q", "main"]);
        std::fs::write(p.join("f.txt"), "main\n").unwrap();
        git(&["commit", "-qam", "main"]);

        assert!(merge_head_branches(p).unwrap().is_empty(), "no merge yet");
        let outcome = merge_to(p, "main", "phasr/task", MergeStrategy::Merge).unwrap().outcome;
        assert!(matches!(outcome, MergeOutcome::Conflicts { .. }));
        assert_eq!(merge_head_branches(p).unwrap(), vec!["phasr/task".to_string()]);
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("main"));
        set_resolution(p, "f.txt", ConflictSide::Theirs).unwrap();
        assert!(matches!(continue_after_resolution(p).unwrap(), MergeOutcome::Clean { .. }));
        assert!(merge_head_branches(p).unwrap().is_empty());
    }

    /// A branch merged into its target loses nothing; a commit only on the
    /// branch (not pushed, not merged) would be lost.
    #[test]
    fn unsaved_commits_are_ones_kept_nowhere_else() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let git = |args: &[&str]| {
            assert!(Command::new("git").args(args).current_dir(dir.path()).status().unwrap().success());
        };
        git(&["checkout", "-qb", "phasr/t"]);
        add_commit(dir.path(), "t.txt", "t\n", "work");
        assert!(has_unsaved_commits(dir.path(), "phasr/t", &["main"]).unwrap(), "only on the branch");
        git(&["checkout", "-q", "main"]);
        git(&["merge", "-q", "--no-ff", "-m", "merge", "phasr/t"]);
        assert!(!has_unsaved_commits(dir.path(), "phasr/t", &["main"]).unwrap(), "merged into main");
        // …though it was never pushed.
        assert!(has_unpushed_commits(dir.path(), "phasr/t").unwrap());
        // A missing branch / missing keeper refs are fine.
        assert!(!has_unsaved_commits(dir.path(), "nope", &["main"]).unwrap());
        assert!(!has_unsaved_commits(dir.path(), "phasr/t", &["main", "no-such-base"]).unwrap());
    }

    fn git_out(path: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(path).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn on_branch(path: &Path, rev: &str, file: &str) -> bool {
        Command::new("git")
            .args(["cat-file", "-e", &format!("{rev}:{file}")])
            .current_dir(path)
            .status()
            .unwrap()
            .success()
    }

    /// main, a `develop` branch, and a task branch `phasr/t` off develop
    /// with t.txt; the checkout is left on `other`.
    fn checkout_on_another_branch(dir: &Path) {
        init_repo(dir);
        checkout(dir, "develop", true);
        checkout(dir, "phasr/t", true);
        add_commit(dir, "t.txt", "t\n", "task work");
        checkout(dir, "main", false);
        checkout(dir, "other", true);
    }

    /// The second review's #1: the checkout is on another branch. The merge
    /// must land on the TASK's base (switching to it), and report it.
    #[test]
    fn merge_to_switches_to_the_target_and_reports_where_it_merged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        checkout_on_another_branch(p);
        let merged = merge_to(p, "develop", "phasr/t", MergeStrategy::Merge).unwrap();
        assert!(matches!(merged.outcome, MergeOutcome::Clean { .. }));
        assert_eq!(merged.into, "develop");
        assert!(on_branch(p, "develop", "t.txt"), "merged into develop");
        assert!(!on_branch(p, "other", "t.txt"), "the previously checked-out branch is untouched");
        assert!(!on_branch(p, "main", "t.txt"));
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("develop"));
    }

    /// On another branch with uncommitted work: refused, nothing switched.
    #[test]
    fn merge_to_refuses_to_switch_away_from_uncommitted_work() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        checkout_on_another_branch(p);
        std::fs::write(p.join("wip.txt"), "wip\n").unwrap();
        let err = merge_to(p, "develop", "phasr/t", MergeStrategy::Merge).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("`other`") && msg.contains("uncommitted"), "{msg}");
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("other"));
        assert!(!on_branch(p, "develop", "t.txt"));
        assert!(p.join("wip.txt").exists());
    }

    /// The probe: a base that doesn't exist locally used to resolve to the
    /// checkout's CURRENT branch and merge there. Now it refuses.
    #[test]
    fn merge_to_never_falls_back_to_the_current_branch() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        checkout_on_another_branch(p);
        let err = merge_to(p, "release", "phasr/t", MergeStrategy::Merge).unwrap_err();
        assert!(err.to_string().contains("`release` doesn't exist"), "{err}");
        assert!(!on_branch(p, "other", "t.txt"), "nothing merged into the current branch");
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("other"));
    }

    /// A base that only exists as `origin/<base>` gets a local branch
    /// tracking it, and the merge lands there.
    #[test]
    fn merge_to_creates_a_local_base_from_origin() {
        let upstream = tempfile::tempdir().unwrap();
        init_repo(upstream.path());
        checkout(upstream.path(), "develop", true);
        add_commit(upstream.path(), "d.txt", "d\n", "develop work");
        checkout(upstream.path(), "main", false);
        let clone_dir = tempfile::tempdir().unwrap();
        git_out(clone_dir.path(), &["clone", "-q", &upstream.path().to_string_lossy(), "c"]);
        let c = clone_dir.path().join("c");
        git_out(&c, &["config", "user.email", "t@example.com"]);
        git_out(&c, &["config", "user.name", "t"]);
        git_out(&c, &["checkout", "-qb", "phasr/t", "origin/develop"]);
        add_commit(&c, "t.txt", "t\n", "task");
        git_out(&c, &["checkout", "-q", "main"]);

        let merged = merge_to(&c, "develop", "phasr/t", MergeStrategy::Merge).unwrap();
        assert_eq!(merged.into, "develop");
        assert!(on_branch(&c, "develop", "t.txt") && on_branch(&c, "develop", "d.txt"));
        assert_eq!(git_out(&c, &["rev-parse", "--abbrev-ref", "develop@{upstream}"]), "origin/develop");
    }

    /// A ff-only merge that can't fast-forward changes nothing — and the
    /// checkout goes back to the branch it was on.
    #[test]
    fn a_failed_merge_switches_the_checkout_back() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        checkout_on_another_branch(p);
        checkout(p, "develop", false);
        add_commit(p, "dev.txt", "x\n", "develop moves");
        checkout(p, "other", false);
        assert!(merge_to(p, "develop", "phasr/t", MergeStrategy::FastForward).is_err());
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("other"));
        assert_eq!(in_progress(p).unwrap(), InProgress::None);
    }

    /// The should-fix probe: `--squash` with conflicts writes no
    /// MERGE_HEAD, so it left `UU f` in the main checkout with no conflict
    /// UI and every later merge blocked as dirty. Now it's undone.
    #[test]
    fn a_conflicted_squash_is_undone_with_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        checkout(p, "phasr/t", true);
        add_commit(p, "README.md", "task\n", "task edit");
        checkout(p, "main", false);
        add_commit(p, "README.md", "main\n", "main edit");
        let head = git_out(p, &["rev-parse", "HEAD"]);

        let err = merge_to(p, "main", "phasr/t", MergeStrategy::Squash).unwrap_err();
        assert!(err.to_string().contains("conflicts in README.md"), "{err}");
        assert_eq!(git_out(p, &["status", "--porcelain"]), "", "nothing half-merged");
        assert_eq!(git_out(p, &["rev-parse", "HEAD"]), head);
        assert_eq!(std::fs::read_to_string(p.join("README.md")).unwrap(), "main\n");
        // The next merge isn't blocked.
        assert!(matches!(
            merge_to(p, "main", "phasr/t", MergeStrategy::Merge).unwrap().outcome,
            MergeOutcome::Conflicts { .. }
        ));
        // Same for a squash sync inside a worktree.
        abort(p).unwrap();
        checkout(p, "phasr/t", false);
        assert!(merge_into(p, "main", MergeStrategy::Squash).is_err());
        assert_eq!(git_out(p, &["status", "--porcelain"]), "");
    }

    #[test]
    fn option_and_refspec_shaped_names_never_reach_merge() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        checkout_on_another_branch(p);
        for (target, source) in [("--no-verify", "phasr/t"), ("develop", "--squash"), ("develop", "phasr/t:develop")] {
            assert!(merge_to(p, target, source, MergeStrategy::Merge).is_err(), "{target} {source}");
        }
        assert!(merge_into(p, "--abort", MergeStrategy::Merge).is_err());
        assert_eq!(current_branch(p).unwrap().as_deref(), Some("other"));
    }
}
