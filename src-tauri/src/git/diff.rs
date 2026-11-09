use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;

use crate::domain::board::DiffStats;

use super::error::{run_git, GitError};

/// Untracked files are read for a line count up to this many bytes each…
const UNTRACKED_READ_CAP: u64 = 2 * 1024 * 1024;
/// …and only this many of them: past it (an unignored `node_modules`),
/// further files still count as files, just without lines.
const UNTRACKED_COUNT_CAP: usize = 2000;

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum DiffScope {
    /// Working-tree changes that have not been `git add`-ed.
    Unstaged,
    /// Changes already in the index.
    Staged,
    /// Combined diff against HEAD (staged + unstaged).
    Head,
    /// Everything the task changed vs the merge-base with its base branch:
    /// committed + staged + unstaged + untracked. Needs the base, so
    /// `diff()` rejects it — use `review::diff_vs_base`.
    Base,
}

/// Unified diff for a single commit (whole-commit when `path` is None,
/// otherwise scoped to that one path). For merge commits, `-m
/// --first-parent` produces a diff against the first parent rather
/// than the default empty output.
pub fn diff_for_commit(cwd: &Path, sha: &str, path: Option<&str>) -> Result<String, GitError> {
    let mut args: Vec<&str> = vec!["show", "--no-color", "-m", "--first-parent", "--format="];
    args.push(sha);
    if let Some(p) = path {
        args.push("--");
        args.push(p);
    }
    run_git(cwd, &args)
}

pub fn diff(cwd: &Path, scope: DiffScope, path: Option<&str>) -> Result<String, GitError> {
    // Untracked files don't show up in `git diff` at all — the diff
    // tools only know about indexed paths. Detect them and synthesise
    // an "everything is new" diff from the file contents so the user
    // can see what the agent created.
    if let Some(p) = path {
        let porcelain = run_git(cwd, &["status", "--porcelain=v1", "--", p])?;
        if porcelain.starts_with("??") {
            return synthesise_new_file_diff(cwd, p);
        }
    }

    let mut args: Vec<&str> = vec!["diff"];
    match scope {
        DiffScope::Unstaged => {}
        DiffScope::Staged => args.push("--cached"),
        DiffScope::Head => args.push("HEAD"),
        DiffScope::Base => {
            return Err(GitError::CommandFailed(
                "a base diff needs the task's base branch".into(),
            ))
        }
    }
    if let Some(p) = path {
        args.push("--");
        args.push(p);
    }
    run_git(cwd, &args)
}

/// What the task changed on its branch relative to `base`: everything
/// committed since the branch forked, plus uncommitted (staged and not)
/// edits, plus untracked files.
///
/// Measured from `merge-base HEAD base`, not `base` itself, so commits that
/// landed on `base` after the fork don't show up as this task "removing"
/// them. `git diff --numstat <merge-base>` compares that commit with the
/// WORKING TREE, which covers committed and uncommitted tracked changes in
/// one pass; untracked files come from `ls-files -o --exclude-standard`
/// (each counted as one file, lines = its line count, read up to 2 MiB).
/// Binary files count as a file with no lines.
pub fn diff_stats_vs_base(worktree: &Path, base: &str) -> Result<DiffStats, GitError> {
    // Same fork point as the review diff (local or fetched `origin/<base>`,
    // whichever the branch was cut from).
    let merge_base = super::review::merge_base(worktree, base)?;
    let merge_base = merge_base.as_str();
    let numstat = run_git(
        worktree,
        &["diff", "--numstat", "--no-renames", "--no-ext-diff", merge_base],
    )?;
    let mut stats = DiffStats::default();
    for line in numstat.lines() {
        let mut cols = line.splitn(3, '\t');
        let (Some(adds), Some(removes), Some(_path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        stats.files += 1;
        // Binary files report `-` for both.
        stats.adds += adds.parse::<u64>().unwrap_or(0);
        stats.removes += removes.parse::<u64>().unwrap_or(0);
    }
    let untracked = run_git(worktree, &["ls-files", "-o", "--exclude-standard", "-z"])?;
    for (i, rel) in untracked.split('\0').filter(|p| !p.is_empty()).enumerate() {
        // A nested repository is listed as `dir/`; it isn't a file.
        if rel.ends_with('/') {
            continue;
        }
        stats.files += 1;
        if i < UNTRACKED_COUNT_CAP {
            stats.adds += count_lines_capped(&worktree.join(rel));
        }
    }
    Ok(stats)
}

/// Line count of the first `UNTRACKED_READ_CAP` bytes; 0 for binary
/// content (a NUL byte, git's own heuristic) or an unreadable file.
pub(super) fn count_lines_capped(path: &Path) -> u64 {
    let Ok(file) = std::fs::File::open(path) else {
        return 0;
    };
    let mut buf = Vec::new();
    if file.take(UNTRACKED_READ_CAP).read_to_end(&mut buf).is_err() || buf.contains(&0) {
        return 0;
    }
    let newlines = buf.iter().filter(|b| **b == b'\n').count() as u64;
    // A last line without a trailing newline still counts.
    newlines + u64::from(buf.last().is_some_and(|b| *b != b'\n'))
}

/// The commit `worktree` has checked out.
pub fn head_sha(worktree: &Path) -> Result<String, GitError> {
    Ok(run_git(worktree, &["rev-parse", "HEAD"])?.trim().to_string())
}

/// Recent `diff_stats_vs_base` results per task. An entry is used only for
/// the same HEAD (a new commit is a different diff) and within the TTL
/// (uncommitted edits don't move HEAD). File-change and tool-use signals
/// invalidate a task outright, so the TTL only bounds what slips past them.
pub struct DiffStatCache {
    ttl: Duration,
    entries: Mutex<HashMap<String, CachedStats>>,
}

struct CachedStats {
    head: String,
    stats: DiffStats,
    at: Instant,
}

impl DiffStatCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, task_id: &str, head: &str) -> Option<DiffStats> {
        let entries = self.entries.lock();
        let entry = entries.get(task_id)?;
        (entry.head == head && entry.at.elapsed() < self.ttl).then_some(entry.stats)
    }

    pub fn put(&self, task_id: &str, head: String, stats: DiffStats) {
        self.entries.lock().insert(
            task_id.to_string(),
            CachedStats {
                head,
                stats,
                at: Instant::now(),
            },
        );
    }

    /// Drop `task_id`'s entry. Returns whether there was one.
    pub fn invalidate(&self, task_id: &str) -> bool {
        self.entries.lock().remove(task_id).is_some()
    }

    /// `diff_stats_vs_base`, served from the cache when HEAD hasn't moved.
    /// Blocking (shells out to git): call from `spawn_blocking`.
    pub fn stats(&self, task_id: &str, worktree: &Path, base: &str) -> Result<DiffStats, GitError> {
        let head = head_sha(worktree)?;
        if let Some(stats) = self.get(task_id, &head) {
            return Ok(stats);
        }
        let stats = diff_stats_vs_base(worktree, base)?;
        self.put(task_id, head, stats);
        Ok(stats)
    }
}

pub(super) fn synthesise_new_file_diff(cwd: &Path, rel_path: &str) -> Result<String, GitError> {
    let full = cwd.join(rel_path);
    if full.is_dir() {
        // An untracked directory git didn't expand (e.g. a nested git repo /
        // submodule, which `-uall` won't descend into). There's no single-file
        // diff to show — return empty so the UI renders a clean "no preview"
        // state instead of an "Is a directory" IO error.
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&full).map_err(GitError::Io)?;
    let lines: Vec<&str> = content.lines().collect();
    let line_count = lines.len();

    let mut out = String::new();
    out.push_str(&format!("diff --git a/{rel_path} b/{rel_path}\n"));
    out.push_str("new file mode 100644\n");
    out.push_str(&format!("--- /dev/null\n+++ b/{rel_path}\n"));

    if line_count > 0 {
        // Real `git diff` emits `@@ -0,0 +1,N @@` for a fully new file
        // with N lines. Parsers (including ours) expect that exact form.
        out.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
        for line in &lines {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
        if !content.ends_with('\n') {
            out.push_str("\\ No newline at end of file\n");
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// main: a.txt (3 lines), gone.txt. Task branch `task` forks, commits
    /// an edit + a deletion, then main moves on (must NOT count). Then
    /// uncommitted: a staged new file, an unstaged edit, an untracked
    /// file, an untracked binary, an ignored file (must NOT count).
    fn repo_with_task_branch() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::write(p.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(p.join("gone.txt"), "x\ny\n").unwrap();
        std::fs::write(p.join(".gitignore"), "ignored.log\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);

        git(p, &["checkout", "-qb", "task"]);
        std::fs::write(p.join("a.txt"), "1\nTWO\n3\n4\n").unwrap(); // +2 -1
        git(p, &["rm", "-q", "gone.txt"]); // -2
        git(p, &["commit", "-qam", "task work"]);

        // Base moves on after the fork.
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("later.txt"), "a\nb\nc\nd\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "main moves"]);
        git(p, &["checkout", "-q", "task"]);

        std::fs::write(p.join("staged.txt"), "s\n").unwrap(); // +1
        git(p, &["add", "staged.txt"]);
        std::fs::write(p.join("a.txt"), "1\nTWO\n3\n4\n5").unwrap(); // +1 more (no trailing newline)
        std::fs::write(p.join("new.rs"), "fn a() {}\nfn b() {}").unwrap(); // untracked, +2
        std::fs::write(p.join("blob.bin"), [0u8, 1, 2, 3]).unwrap(); // untracked binary
        std::fs::write(p.join("ignored.log"), "noise\n").unwrap();
        dir
    }

    #[test]
    fn diff_stats_count_committed_uncommitted_and_untracked_vs_the_merge_base() {
        let dir = repo_with_task_branch();
        let stats = diff_stats_vs_base(dir.path(), "main").unwrap();
        // a.txt, gone.txt, staged.txt (tracked) + new.rs, blob.bin (untracked).
        assert_eq!(stats.files, 5, "{stats:?}");
        // a.txt +3 -1 (vs merge-base: "2" → "TWO", "4", "5"), staged +1, new.rs +2.
        assert_eq!(stats.adds, 3 + 1 + 2, "{stats:?}");
        // a.txt -1, gone.txt -2. later.txt on main is NOT a removal.
        assert_eq!(stats.removes, 1 + 2, "{stats:?}");
    }

    #[test]
    fn diff_stats_are_empty_for_an_untouched_branch_and_err_for_a_missing_base() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::write(p.join(".gitignore"), "ignored.log\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        git(p, &["checkout", "-qb", "task"]);
        std::fs::write(p.join("ignored.log"), "noise\n").unwrap();
        assert!(diff_stats_vs_base(p, "main").unwrap().is_empty());
        assert!(diff_stats_vs_base(p, "no-such-branch").is_err());
    }

    #[test]
    fn cache_is_keyed_by_head_and_expires_and_invalidates() {
        let dir = repo_with_task_branch();
        let cache = DiffStatCache::new(Duration::from_secs(60));
        let first = cache.stats("t", dir.path(), "main").unwrap();
        // A new uncommitted file isn't seen while the entry is fresh…
        std::fs::write(dir.path().join("more.txt"), "m\n").unwrap();
        assert_eq!(cache.stats("t", dir.path(), "main").unwrap(), first);
        // …until invalidated.
        assert!(cache.invalidate("t"));
        assert_eq!(cache.stats("t", dir.path(), "main").unwrap().files, first.files + 1);
        // A commit moves HEAD: a different key.
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-qm", "more"]);
        let head = head_sha(dir.path()).unwrap();
        assert!(cache.get("t", &head).is_none());
        // TTL.
        let short = DiffStatCache::new(Duration::from_millis(0));
        short.put("t", head.clone(), DiffStats::default());
        assert!(short.get("t", &head).is_none());
    }

    #[test]
    fn synthesise_returns_empty_for_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        // A directory path must not crash with "Is a directory".
        let out = synthesise_new_file_diff(dir.path(), "sub").unwrap();
        assert_eq!(out, "");
    }

    #[test]
    fn synthesise_builds_new_file_diff_for_a_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x\ny\n").unwrap();
        let out = synthesise_new_file_diff(dir.path(), "a.txt").unwrap();
        assert!(out.contains("new file mode 100644"));
        assert!(out.contains("@@ -0,0 +1,2 @@"));
        assert!(out.contains("+x"));
        assert!(out.contains("+y"));
    }
}
