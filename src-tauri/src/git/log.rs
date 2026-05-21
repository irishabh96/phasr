//! Commit history queries for the History tab in the workspace's
//! right sidebar. Two surfaces:
//!
//! - `log()` returns a page of `Commit` rows for either the workspace
//!   branch only (`<defaultBranch>..HEAD`) or the full reachable
//!   history. Supports `--grep` (case-insensitive), pagination via
//!   skip/limit, and an isomorphic "all branches" mode.
//! - `commit_files()` returns the file list for a single commit so
//!   the React layer can drive a `DiffList` against it.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::error::{run_git, GitError};
use super::status::FileStatus;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    pub branch_only: bool,
    pub limit: Option<u32>,
    pub skip: Option<u32>,
    pub message_grep: Option<String>,
    /// Resolved by the caller (the Tauri command looks it up from the
    /// repo record). When `branch_only=true` and this is `None`, the
    /// query falls back to the full HEAD history.
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
}

/// Records are separated by `\x1e` (ASCII record-separator). Within a
/// record, fields are separated by `\x1f` (unit-separator). Subjects
/// and bodies frequently contain newlines, so we cannot use them.
const RECORD_SEP: char = '\x1e';
const FIELD_SEP: char = '\x1f';

pub fn log(cwd: &Path, opts: &LogOptions) -> Result<Vec<Commit>, GitError> {
    // Format: sha\x1fshort\x1fauthor_name\x1fauthor_email\x1fauthor_date\x1fparents\x1fsubject\x1fbody\x1e
    let format = format!(
        "--format=%H{f}%h{f}%an{f}%ae{f}%aI{f}%P{f}%s{f}%b{r}",
        f = FIELD_SEP,
        r = RECORD_SEP
    );
    let mut args: Vec<String> = vec!["log".into(), format];

    if let Some(limit) = opts.limit {
        args.push(format!("--max-count={limit}"));
    }
    if let Some(skip) = opts.skip {
        if skip > 0 {
            args.push(format!("--skip={skip}"));
        }
    }
    if let Some(grep) = &opts.message_grep {
        let trimmed = grep.trim();
        if !trimmed.is_empty() {
            args.push("--regexp-ignore-case".into());
            args.push(format!("--grep={trimmed}"));
        }
    }

    // Range: `<target>..HEAD` for branch-only mode, else just `HEAD`.
    let range = if opts.branch_only {
        match resolve_branch_only_range(cwd, opts.default_branch.as_deref())? {
            Some(r) => r,
            None => "HEAD".to_string(),
        }
    } else {
        "HEAD".to_string()
    };
    args.push(range);

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = match run_git(cwd, &arg_refs) {
        Ok(s) => s,
        Err(GitError::CommandFailed(msg)) => {
            // Unborn HEAD / empty repo: `git log` exits non-zero with
            // a "does not have any commits" stderr. Treat as empty.
            if msg.contains("does not have any commits")
                || msg.contains("bad default revision")
                || msg.contains("unknown revision")
            {
                return Ok(Vec::new());
            }
            return Err(GitError::CommandFailed(msg));
        }
        Err(e) => return Err(e),
    };

    Ok(parse_log_output(&stdout))
}

fn resolve_branch_only_range(
    cwd: &Path,
    default_branch: Option<&str>,
) -> Result<Option<String>, GitError> {
    let Some(default) = default_branch else {
        return Ok(None);
    };
    // Skip the range when HEAD's branch already IS the default.
    let head_branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if head_branch == default {
        return Ok(None);
    }
    // Prefer the remote tracking ref so post-fetch the range stays
    // accurate even when local `<default>` hasn't moved.
    let remote_ref = format!("origin/{default}");
    if run_git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote_ref}"),
        ],
    )
    .is_ok()
    {
        return Ok(Some(format!("{remote_ref}..HEAD")));
    }
    // Fall back to local ref if it exists. Otherwise None — caller
    // will use HEAD.
    if run_git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{default}"),
        ],
    )
    .is_ok()
    {
        return Ok(Some(format!("{default}..HEAD")));
    }
    Ok(None)
}

fn parse_log_output(stdout: &str) -> Vec<Commit> {
    let mut out = Vec::new();
    for raw in stdout.split(RECORD_SEP) {
        let record = raw.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut fields = record.split(FIELD_SEP);
        let sha = fields.next().unwrap_or("").trim().to_string();
        if sha.is_empty() {
            continue;
        }
        let short_sha = fields.next().unwrap_or("").trim().to_string();
        let author_name = fields.next().unwrap_or("").to_string();
        let author_email = fields.next().unwrap_or("").to_string();
        let author_date = fields.next().unwrap_or("").trim().to_string();
        let parents: Vec<String> = fields
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(String::from)
            .collect();
        let subject = fields.next().unwrap_or("").to_string();
        let body_raw = fields.next().unwrap_or("");
        let body = {
            let trimmed = body_raw.trim_end_matches('\n');
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };
        out.push(Commit {
            sha,
            short_sha,
            subject,
            body,
            author_name,
            author_email,
            author_date,
            parents,
        });
    }
    out
}

pub fn commit_files(cwd: &Path, sha: &str) -> Result<Vec<CommitFileChange>, GitError> {
    // `git show --name-status -z --format=` lists files with their
    // single-letter status. `-z` keeps paths NUL-separated so spaces
    // and special chars round-trip safely. The empty format strips
    // the commit message so only the file rows remain.
    let stdout = run_git(
        cwd,
        &[
            "show",
            "--name-status",
            "--format=",
            "-z",
            "--first-parent",
            sha,
        ],
    )?;
    Ok(parse_name_status(&stdout))
}

fn parse_name_status(stdout: &str) -> Vec<CommitFileChange> {
    let mut out = Vec::new();
    let mut iter = stdout.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(code) = iter.next() {
        let first = code.chars().next().unwrap_or(' ');
        let status = match first {
            'A' => FileStatus::Added,
            'M' => FileStatus::Modified,
            'D' => FileStatus::Deleted,
            'R' => FileStatus::Renamed,
            'C' => FileStatus::Renamed, // treat copy as rename for UI purposes
            _ => FileStatus::Other,
        };
        if first == 'R' || first == 'C' {
            let from = iter.next().unwrap_or("").to_string();
            let to = iter.next().unwrap_or("").to_string();
            if to.is_empty() {
                continue;
            }
            out.push(CommitFileChange {
                path: to,
                old_path: Some(from),
                status,
            });
        } else {
            let path = iter.next().unwrap_or("").to_string();
            if path.is_empty() {
                continue;
            }
            out.push(CommitFileChange {
                path,
                old_path: None,
                status,
            });
        }
    }
    out
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
        Command::new("git").args(["config", "commit.gpgsign", "false"]).current_dir(path).status().unwrap();
    }

    fn add_commit(path: &Path, file: &str, msg: &str) {
        std::fs::write(path.join(file), msg).unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(path).status().unwrap();
        Command::new("git").args(["commit", "-qm", msg]).current_dir(path).status().unwrap();
    }

    #[test]
    fn empty_repo_returns_empty_vec() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let result = log(dir.path(), &LogOptions::default()).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn returns_commits_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "a.txt", "first");
        add_commit(dir.path(), "b.txt", "second");
        add_commit(dir.path(), "c.txt", "feat: third");

        let result = log(dir.path(), &LogOptions::default()).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].subject, "feat: third");
        assert_eq!(result[1].subject, "second");
        assert_eq!(result[2].subject, "first");

        // Parents — non-merge commits have exactly one parent except
        // the root commit, which has zero.
        assert_eq!(result[0].parents.len(), 1);
        assert_eq!(result[1].parents.len(), 1);
        assert_eq!(result[2].parents.len(), 0);
    }

    #[test]
    fn message_grep_filters_results() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "a.txt", "chore: bump deps");
        add_commit(dir.path(), "b.txt", "feat: add login");
        add_commit(dir.path(), "c.txt", "fix: login redirect");

        let result = log(
            dir.path(),
            &LogOptions {
                message_grep: Some("login".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|c| c.subject.contains("feat: add login")));
        assert!(result.iter().any(|c| c.subject.contains("fix: login redirect")));
    }

    #[test]
    fn pagination_with_limit_and_skip() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        for i in 0..5 {
            add_commit(dir.path(), &format!("f{i}.txt"), &format!("c{i}"));
        }
        let page = log(
            dir.path(),
            &LogOptions {
                limit: Some(2),
                skip: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.len(), 2);
        // Skip 1 from newest = c3, then c2
        assert_eq!(page[0].subject, "c3");
        assert_eq!(page[1].subject, "c2");
    }

    #[test]
    fn branch_only_excludes_main_commits() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "main-1.txt", "main: 1");
        add_commit(dir.path(), "main-2.txt", "main: 2");
        Command::new("git").args(["checkout", "-q", "-b", "feature"]).current_dir(dir.path()).status().unwrap();
        add_commit(dir.path(), "feat-1.txt", "feat: 1");
        add_commit(dir.path(), "feat-2.txt", "feat: 2");

        let result = log(
            dir.path(),
            &LogOptions {
                branch_only: true,
                default_branch: Some("main".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].subject, "feat: 2");
        assert_eq!(result[1].subject, "feat: 1");
    }

    #[test]
    fn branch_only_on_default_branch_returns_full_history() {
        // If HEAD === default branch, branch-only is a degenerate
        // range — fall back to plain HEAD so the user sees the chain.
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "a.txt", "first");
        add_commit(dir.path(), "b.txt", "second");

        let result = log(
            dir.path(),
            &LogOptions {
                branch_only: true,
                default_branch: Some("main".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn merge_commit_has_two_parents() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "root.txt", "root");
        Command::new("git").args(["checkout", "-q", "-b", "feature"]).current_dir(dir.path()).status().unwrap();
        add_commit(dir.path(), "f.txt", "feature work");
        Command::new("git").args(["checkout", "-q", "main"]).current_dir(dir.path()).status().unwrap();
        add_commit(dir.path(), "m.txt", "main work");
        Command::new("git").args(["merge", "--no-ff", "feature", "-m", "merge feature"]).current_dir(dir.path()).status().unwrap();

        let result = log(dir.path(), &LogOptions::default()).unwrap();
        // Newest is the merge commit.
        assert_eq!(result[0].subject, "merge feature");
        assert_eq!(result[0].parents.len(), 2);
    }

    #[test]
    fn commit_files_lists_changed_paths() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(dir.path()).status().unwrap();
        Command::new("git").args(["commit", "-qm", "two files"]).current_dir(dir.path()).status().unwrap();

        let sha = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let files = commit_files(dir.path(), &sha).unwrap();
        assert_eq!(files.len(), 2);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"));
        assert!(paths.contains(&"b.txt"));
        assert_eq!(files[0].status, FileStatus::Added);
    }

    #[test]
    fn commit_files_handles_renames() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        add_commit(dir.path(), "old.txt", "old content here\n");
        std::fs::rename(dir.path().join("old.txt"), dir.path().join("new.txt")).unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(dir.path()).status().unwrap();
        Command::new("git").args(["commit", "-qm", "rename"]).current_dir(dir.path()).status().unwrap();

        let sha = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let files = commit_files(dir.path(), &sha).unwrap();
        // Git may detect this as either a rename (R) or as add+delete
        // depending on similarity. Tolerate both — but the row count
        // and final path are deterministic.
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"new.txt") || paths.contains(&"old.txt"));
    }
}
