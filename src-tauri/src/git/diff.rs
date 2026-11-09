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
    // `--no-optional-locks`: a plain `git diff` refreshes the index and
    // rewrites it when it can. That fights the agent's own git commands
    // for `index.lock`, and it moves the index mtime that `WorktreeKey`
    // watches, so the next board refetch would recompute for nothing.
    let numstat = run_git(
        worktree,
        &[
            "--no-optional-locks",
            "diff",
            "--numstat",
            "--no-renames",
            "--no-ext-diff",
            merge_base,
        ],
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

/// Open an untracked path for reading ONLY if it is a regular file — never
/// through a symlink, never a FIFO / device / socket.
///
/// Untracked paths are agent- or repo-controlled. `File::open` follows a
/// symlink, so `x -> /dev/zero` read to the end exhausts memory, and
/// opening a FIFO (directly or via a link) blocks until a writer appears —
/// which hung `list_check_runs` and Approve. So: `symlink_metadata` first,
/// then open with `O_NOFOLLOW | O_NONBLOCK` and re-check the opened file's
/// type, which also closes the swap-between-check-and-open race. Callers
/// still cap every read with `.take()`.
pub(super) fn open_regular_untracked(path: &Path) -> Option<std::fs::File> {
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    file.metadata().ok()?.file_type().is_file().then_some(file)
}

/// Line count of the first `UNTRACKED_READ_CAP` bytes; 0 for binary
/// content (a NUL byte, git's own heuristic), an unreadable file, or
/// anything that isn't a regular file (symlinks, FIFOs, devices — see
/// `open_regular_untracked`).
pub(super) fn count_lines_capped(path: &Path) -> u64 {
    let Some(file) = open_regular_untracked(path) else {
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

/// What a cached diff was computed against: the checked-out commit and
/// the index file's (mtime, size). A commit moves `head`; `git add` (or
/// anything else that rewrites the index) moves `index`. Edits to the
/// working tree move neither: those arrive as invalidations (fs watcher,
/// a finished tool call) or age out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeKey {
    head: String,
    index: Option<(std::time::SystemTime, u64)>,
}

/// `WorktreeKey` for `worktree`, read straight from its git dir: no git
/// process for the common layouts (`.git` dir or a linked worktree's
/// `.git` file; HEAD on a loose or packed branch, or detached). Anything
/// else (reftable, a symref chain, an unborn branch) falls back to
/// `git rev-parse HEAD`.
pub fn worktree_key(worktree: &Path) -> Result<WorktreeKey, GitError> {
    let dirs = git_dirs(worktree);
    let head = match dirs.as_ref().and_then(|(gitdir, common)| read_head(gitdir, common)) {
        Some(head) => head,
        None => head_sha(worktree)?,
    };
    let index = dirs
        .and_then(|(gitdir, _)| std::fs::metadata(gitdir.join("index")).ok())
        .and_then(|m| Some((m.modified().ok()?, m.len())));
    Ok(WorktreeKey { head, index })
}

/// Largest git bookkeeping file read for `worktree_key`. HEAD and a loose
/// ref are a line; `packed-refs` can be big but is rarely consulted.
const GIT_META_READ_CAP: u64 = 8 * 1024 * 1024;

/// A bookkeeping file's text, read the way untracked files are: regular
/// files only, capped. The worktree (and its `.git` file) is agent-
/// writable, so a FIFO here must not hang the board.
fn read_git_meta(path: &Path) -> Option<String> {
    let file = open_regular_untracked(path)?;
    let mut text = String::new();
    file.take(GIT_META_READ_CAP).read_to_string(&mut text).ok()?;
    Some(text)
}

/// `(git dir, common dir)`: the same dir for a plain checkout; for a linked
/// worktree, `.git` is a `gitdir: …` file and branches live in the common dir.
fn git_dirs(worktree: &Path) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let dot_git = worktree.join(".git");
    if std::fs::symlink_metadata(&dot_git).ok()?.is_dir() {
        return Some((dot_git.clone(), dot_git));
    }
    let text = read_git_meta(&dot_git)?;
    let gitdir = worktree.join(text.trim().strip_prefix("gitdir:")?.trim());
    let common = match read_git_meta(&gitdir.join("commondir")) {
        Some(rel) => gitdir.join(rel.trim()),
        None => gitdir.clone(),
    };
    Some((gitdir, common))
}

fn is_object_id(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// HEAD's commit from the files, or `None` to let git answer.
fn read_head(gitdir: &Path, common: &Path) -> Option<String> {
    let head = read_git_meta(&gitdir.join("HEAD"))?;
    let head = head.trim();
    let Some(name) = head.strip_prefix("ref:").map(str::trim) else {
        return is_object_id(head).then(|| head.to_string());
    };
    // Branch names only: nothing that could walk out of the git dir.
    let safe = name.starts_with("refs/heads/")
        && !name.split('/').any(|part| part.is_empty() || part == "." || part == "..");
    if !safe {
        return None;
    }
    if let Some(loose) = read_git_meta(&common.join(name)) {
        let id = loose.trim();
        return is_object_id(id).then(|| id.to_string());
    }
    // Not loose: `git pack-refs` (or gc) moved it into packed-refs.
    let packed = read_git_meta(&common.join("packed-refs"))?;
    packed.lines().find_map(|line| {
        let (id, refname) = line.split_once(' ')?;
        (refname == name && is_object_id(id)).then(|| id.to_string())
    })
}

/// Recent `diff_stats_vs_base` results per task, reused while the
/// worktree's `WorktreeKey` is unchanged, no invalidation arrived, and the
/// entry is younger than the caller's `max_age`. A hit costs a few `stat`s
/// and small file reads, with no git process.
///
/// Each task's computation is single-flight: concurrent board refetches
/// wait for the one in progress and share its result instead of each
/// running the same git commands.
#[derive(Default)]
pub struct DiffStatCache {
    slots: Mutex<HashMap<String, Slot>>,
}

#[derive(Default)]
struct Slot {
    cached: Option<CachedStats>,
    /// Bumped by `invalidate`. An entry computed under an older epoch
    /// is stale: an invalidation landed while (or after) it was computed.
    epoch: u64,
    /// Held while computing; see `get_or_compute`.
    flight: std::sync::Arc<Mutex<()>>,
}

struct CachedStats {
    key: WorktreeKey,
    /// `None`: the diff failed (missing base, …). Cached too, so a broken
    /// task isn't retried on every refetch.
    stats: Option<DiffStats>,
    at: Instant,
    epoch: u64,
}

impl DiffStatCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The last stats computed for `task_id`, fresh or not, with no git
    /// work at all: for tasks whose diff can no longer move their lane
    /// (merged, closed).
    pub fn peek(&self, task_id: &str) -> Option<DiffStats> {
        self.slots.lock().get(task_id)?.cached.as_ref()?.stats
    }

    /// Mark `task_id`'s entry stale; `peek` still serves it. Returns
    /// whether there was one.
    pub fn invalidate(&self, task_id: &str) -> bool {
        let mut slots = self.slots.lock();
        let slot = slots.entry(task_id.to_string()).or_default();
        slot.epoch += 1;
        slot.cached.is_some()
    }

    /// Drop every task not in `keep` (deleted tasks).
    pub fn retain(&self, keep: &std::collections::HashSet<&str>) {
        self.slots.lock().retain(|id, _| keep.contains(id.as_str()));
    }

    fn fresh(&self, task_id: &str, key: &WorktreeKey, max_age: Duration) -> Option<Option<DiffStats>> {
        let slots = self.slots.lock();
        let slot = slots.get(task_id)?;
        let c = slot.cached.as_ref()?;
        (c.epoch == slot.epoch && c.key == *key && c.at.elapsed() < max_age).then_some(c.stats)
    }

    /// The cached stats for `task_id`, or `compute()`'s. Blocking (reads
    /// the git dir, and `compute` shells out): call from `spawn_blocking`.
    pub fn get_or_compute(
        &self,
        task_id: &str,
        worktree: &Path,
        max_age: Duration,
        compute: impl FnOnce() -> Option<DiffStats>,
    ) -> Option<DiffStats> {
        let flight = self
            .slots
            .lock()
            .entry(task_id.to_string())
            .or_default()
            .flight
            .clone();
        // A second caller blocks here, then finds the first one's result.
        let _computing = flight.lock();
        // Read before computing: a commit landing mid-diff then leaves an
        // old key behind and the next call recomputes, never the reverse.
        let key = worktree_key(worktree).ok()?;
        if let Some(stats) = self.fresh(task_id, &key, max_age) {
            return stats;
        }
        let epoch = self.slots.lock().get(task_id).map_or(0, |s| s.epoch);
        let stats = compute();
        if let Some(slot) = self.slots.lock().get_mut(task_id) {
            slot.cached = Some(CachedStats {
                key,
                stats,
                at: Instant::now(),
                epoch,
            });
        }
        stats
    }
}

/// Largest untracked file synthesised as a new-file diff; past it the file
/// gets the "no preview" state instead of a multi-megabyte diff.
const SYNTH_READ_CAP: u64 = 4 * 1024 * 1024;

pub(super) fn synthesise_new_file_diff(cwd: &Path, rel_path: &str) -> Result<String, GitError> {
    let full = cwd.join(rel_path);
    let meta = std::fs::symlink_metadata(&full).map_err(GitError::Io)?;
    if meta.file_type().is_symlink() {
        // What git itself stores for a symlink: the link target as the
        // blob, mode 120000. Never what it points at.
        let target = std::fs::read_link(&full).map_err(GitError::Io)?;
        let target = target.to_string_lossy();
        return Ok(format!(
            "diff --git a/{rel_path} b/{rel_path}\nnew file mode 120000\n--- /dev/null\n+++ b/{rel_path}\n\
             @@ -0,0 +1 @@\n+{target}\n\\ No newline at end of file\n"
        ));
    }
    // A directory git didn't expand (a nested repo / submodule, which
    // `-uall` won't descend into), a FIFO, a device: there's no single-file
    // diff to show — empty, so the UI renders a clean "no preview" state
    // instead of an IO error (or, for a FIFO, a read that never returns).
    let Some(file) = open_regular_untracked(&full) else {
        return Ok(String::new());
    };
    let mut bytes = Vec::new();
    file.take(SYNTH_READ_CAP + 1).read_to_end(&mut bytes).map_err(GitError::Io)?;
    if bytes.len() as u64 > SYNTH_READ_CAP {
        return Ok(String::new());
    }
    let content = String::from_utf8(bytes)
        .map_err(|e| GitError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
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

    const LONG: Duration = Duration::from_secs(600);

    #[test]
    fn cache_is_keyed_by_head_and_index_and_expires_and_invalidates() {
        let dir = repo_with_task_branch();
        let p = dir.path();
        let cache = DiffStatCache::new();
        let computed = std::cell::Cell::new(0);
        let stats = |max_age| {
            cache.get_or_compute("t", p, max_age, || {
                computed.set(computed.get() + 1);
                diff_stats_vs_base(p, "main").ok()
            })
        };
        let first = stats(LONG).unwrap();
        assert_eq!(computed.get(), 1);
        // A new uncommitted file isn't seen while the entry is fresh…
        std::fs::write(p.join("more.txt"), "m\n").unwrap();
        assert_eq!(stats(LONG).unwrap(), first);
        assert_eq!(computed.get(), 1, "a hit runs nothing");
        // …until invalidated (and `peek` keeps serving the old value).
        assert!(cache.invalidate("t"));
        assert_eq!(cache.peek("t"), Some(first));
        assert_eq!(stats(LONG).unwrap().files, first.files + 1);
        assert_eq!(computed.get(), 2);
        // Staging rewrites the index: a different key.
        git(p, &["add", "more.txt"]);
        stats(LONG);
        assert_eq!(computed.get(), 3);
        // A commit moves HEAD: a different key.
        git(p, &["commit", "-qm", "more"]);
        stats(LONG);
        assert_eq!(computed.get(), 4);
        stats(LONG);
        assert_eq!(computed.get(), 4, "our own diff must not move the index");
        // max_age.
        stats(Duration::ZERO);
        assert_eq!(computed.get(), 5);
    }

    /// An invalidation that lands while a diff is being computed leaves the
    /// result stale: it may predate the change.
    #[test]
    fn invalidation_during_a_compute_is_not_lost() {
        let dir = repo_with_task_branch();
        let cache = DiffStatCache::new();
        cache.get_or_compute("t", dir.path(), LONG, || {
            cache.invalidate("t");
            Some(DiffStats::default())
        });
        let again = cache.get_or_compute("t", dir.path(), LONG, || Some(DiffStats { adds: 1, removes: 0, files: 1 }));
        assert_eq!(again.unwrap().files, 1);
    }

    /// Concurrent callers for one task share one computation.
    #[test]
    fn concurrent_callers_share_one_compute() {
        let dir = repo_with_task_branch();
        let cache = std::sync::Arc::new(DiffStatCache::new());
        let computed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..6)
            .map(|_| {
                let (cache, computed, path) = (cache.clone(), computed.clone(), dir.path().to_path_buf());
                std::thread::spawn(move || {
                    cache.get_or_compute("t", &path, LONG, || {
                        computed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        Some(DiffStats::default())
                    })
                })
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap(), Some(DiffStats::default()));
        }
        assert_eq!(computed.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// The file-read HEAD agrees with git's for a plain checkout, a linked
    /// worktree, a packed branch and a detached HEAD.
    #[test]
    fn worktree_key_reads_head_like_git_does() {
        let dir = repo_with_task_branch();
        let p = dir.path();
        let agrees = |wt: &Path| {
            let (gitdir, common) = git_dirs(wt).expect("git dirs");
            assert_eq!(read_head(&gitdir, &common), Some(head_sha(wt).unwrap()), "{}", wt.display());
            assert_eq!(worktree_key(wt).unwrap().head, head_sha(wt).unwrap());
        };
        agrees(p);
        let linked = p.join("linked");
        git(p, &["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap(), "main"]);
        agrees(&linked);
        assert!(worktree_key(&linked).unwrap().index.is_some(), "a linked worktree's own index");
        git(p, &["pack-refs", "--all"]);
        assert!(!p.join(".git/refs/heads/side").exists());
        agrees(&linked);
        agrees(p);
        git(&linked, &["checkout", "-q", "--detach"]);
        agrees(&linked);
    }

    /// A `.git` file pointing at a FIFO, or a ref that walks out of the git
    /// dir, falls back to git instead of hanging or reading elsewhere.
    #[cfg(unix)]
    #[test]
    fn worktree_key_never_reads_through_hostile_git_files() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        let gitdir = dir.path().join("gitdir");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&gitdir).unwrap();
        let fifo = gitdir.join("HEAD");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert_eq!(git_dirs(&wt), Some((gitdir.clone(), gitdir.clone())));
        // Returns at once (no writer will ever appear) instead of blocking.
        assert_eq!(read_head(&gitdir, &gitdir), None);

        let gd = dir.path().join("gd");
        std::fs::create_dir_all(&gd).unwrap();
        std::fs::write(gd.join("HEAD"), "ref: refs/heads/../../../etc/passwd\n").unwrap();
        assert_eq!(read_head(&gd, &gd), None);
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
