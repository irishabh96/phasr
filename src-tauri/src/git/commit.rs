use std::path::Path;

use serde::Serialize;

use super::error::{
    ensure_branch_name, run_git, run_git_with_stdin, run_git_with_timeout, GitError,
};

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
        run_git(
            cwd,
            &["restore", "--staged", "--worktree", "--source=HEAD", ":/"],
        )?;
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
    let stdout = run_git_with_stdin(cwd, &["commit", "--cleanup=verbatim", "-F", "-"], message)?;

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

/// `git push` has no bound of its own; past this a hung credential helper
/// or network is reported instead of blocking Approve forever.
const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Push the LOCAL branch `branch` to `remote` under the same name and set
/// it as upstream.
///
/// `branch` comes from a synced column: it is validated, then handed over
/// only after `--` and as an explicit `refs/heads/<b>:refs/heads/<b>`
/// refspec — so `--mirror` can't be an option and `main:victim` /
/// `+x:other` can't name a different source or destination.
pub fn push(cwd: &Path, remote: &str, branch: &str) -> Result<(), GitError> {
    ensure_branch_name(branch)?;
    if remote.is_empty() || remote.starts_with('-') {
        return Err(GitError::CommandFailed(format!(
            "`{remote}` isn't a remote name"
        )));
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    run_git_with_timeout(
        cwd,
        &["push", "--set-upstream", "--", remote, &refspec],
        PUSH_TIMEOUT,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A bare `origin` holding `main` + `keep`, and a clone with a local
    /// `feature` branch.
    fn remote_and_clone() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin.git");
        let work = dir.path().join("work");
        git(
            dir.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                origin.to_str().unwrap(),
            ],
        );
        git(
            dir.path(),
            &["init", "-q", "-b", "main", work.to_str().unwrap()],
        );
        git(&work, &["config", "user.email", "t@example.com"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("a.txt"), "a\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "init"]);
        git(
            &work,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&work, &["push", "-q", "origin", "main", "main:keep"]);
        git(&work, &["checkout", "-qb", "feature"]);
        std::fs::write(work.join("f.txt"), "f\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "feature"]);
        (dir, origin, work)
    }

    fn remote_branches(origin: &Path) -> String {
        git(
            origin,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
    }

    #[test]
    fn push_sends_the_branch_and_sets_its_upstream() {
        let (_dir, origin, work) = remote_and_clone();
        push(&work, "origin", "feature").unwrap();
        assert!(remote_branches(&origin).contains("refs/heads/feature"));
        assert_eq!(
            git(&work, &["rev-parse", "--abbrev-ref", "feature@{upstream}"]).trim(),
            "origin/feature"
        );
    }

    /// The reviewer's probe: a synced `branch` of `--mirror` turned the
    /// push into a mirror push that deleted the remote's `main` (`git push
    /// --set-upstream origin --mirror`). Refused before git runs.
    #[test]
    fn a_branch_named_like_an_option_is_never_pushed_as_one() {
        let (_dir, origin, work) = remote_and_clone();
        let before = remote_branches(&origin);
        for evil in ["--mirror", "--delete", "-f"] {
            assert!(push(&work, "origin", evil).is_err(), "{evil}");
        }
        assert_eq!(remote_branches(&origin), before, "the remote is untouched");
        assert!(push(&work, "--receive-pack=touch /tmp/x", "feature").is_err());
    }

    /// A refspec-shaped branch can't push into another remote branch.
    #[test]
    fn a_refspec_shaped_branch_cant_overwrite_another_remote_branch() {
        let (_dir, origin, work) = remote_and_clone();
        let keep = git(&origin, &["rev-parse", "refs/heads/keep"]);
        for evil in ["feature:keep", "+feature:keep", "+feature:refs/heads/keep"] {
            assert!(push(&work, "origin", evil).is_err(), "{evil}");
        }
        assert_eq!(git(&origin, &["rev-parse", "refs/heads/keep"]), keep);
    }
}
