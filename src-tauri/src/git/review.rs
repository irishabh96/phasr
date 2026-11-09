//! Git for the review flow: the task's diff measured from where its branch
//! forked (committed + uncommitted + untracked), and a fingerprint of the
//! worktree's exact state so a check result can be tied to the code it ran
//! against.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::diff::{count_lines_capped, open_regular_untracked, synthesise_new_file_diff};
use super::error::{run_git, GitError};
use super::status::{parse_porcelain, FileChange, FileStatus};

/// Untracked files folded into a whole-task diff (each synthesised as a
/// new-file diff). Past this, an unignored build dir would flood the view.
const UNTRACKED_DIFF_CAP: usize = 200;
/// Untracked file contents hashed into the fingerprint, per file / count.
const FINGERPRINT_READ_CAP: u64 = 2 * 1024 * 1024;
const FINGERPRINT_FILE_CAP: usize = 2000;

/// The commit the task's branch forked from `base`.
///
/// With an `origin/<base>` around, this is the best common ancestor of
/// HEAD and *either* `<base>` or `origin/<base>` (`git merge-base HEAD A B`
/// merges A and B hypothetically) — i.e. whichever the branch actually
/// forked from. That matters since tasks can start from a freshly fetched
/// `origin/<base>` that the local `<base>` hasn't caught up with: measured
/// against the stale local branch alone, the task would "contain" every
/// upstream commit it was cut on top of. When the local branch is the
/// newer one the result is the same as before. A base that only exists on
/// the remote (never checked out locally) uses the remote alone.
pub fn merge_base(worktree: &Path, base: &str) -> Result<String, GitError> {
    let remote = format!("origin/{base}");
    let has_remote = !base.starts_with("origin/")
        && run_git(
            worktree,
            &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}")],
        )
        .is_ok();
    if has_remote {
        if let Ok(sha) = run_git(worktree, &["merge-base", "--", "HEAD", base, &remote]) {
            return Ok(sha.trim().to_string());
        }
    }
    match run_git(worktree, &["merge-base", "--", "HEAD", base]) {
        Ok(sha) => Ok(sha.trim().to_string()),
        Err(local_err) => run_git(worktree, &["merge-base", "--", "HEAD", &remote])
            .map(|sha| sha.trim().to_string())
            .map_err(|_| local_err),
    }
}

/// Unified diff of everything the task changed vs its merge-base with
/// `base`: `git diff <merge-base>` compares that commit with the WORKING
/// TREE, so committed, staged and unstaged edits come in one pass; untracked
/// files are appended as synthesised new-file diffs (a single untracked
/// `path` is returned as one).
pub fn diff_vs_base(worktree: &Path, base: &str, path: Option<&str>) -> Result<String, GitError> {
    let mb = merge_base(worktree, base)?;
    if let Some(p) = path {
        let porcelain = run_git(worktree, &["status", "--porcelain=v1", "--", p])?;
        if porcelain.starts_with("??") {
            return synthesise_new_file_diff(worktree, p);
        }
        return run_git(worktree, &["diff", "--no-color", "--no-ext-diff", &mb, "--", p]);
    }
    let mut out = run_git(worktree, &["diff", "--no-color", "--no-ext-diff", &mb])?;
    for rel in untracked(worktree)?.into_iter().take(UNTRACKED_DIFF_CAP) {
        // Binary / unreadable files have no text diff; the file list still
        // shows them.
        if let Ok(diff) = synthesise_new_file_diff(worktree, &rel) {
            out.push_str(&diff);
        }
    }
    Ok(out)
}

/// The files the task changed vs its merge-base with `base` — the review's
/// file list, committed work included.
///
/// Field meaning differs from `status()` (same type, so the UI reuses its
/// file rows): `staged` is the change vs the merge-base (`added`,
/// `modified`, `deleted`, or `untracked` for a new untracked file);
/// `unstaged` is `modified`/`untracked` when the file ALSO has uncommitted
/// edits in the worktree, else `other`. `adds`/`removes` are vs the
/// merge-base (an untracked file counts its lines as adds; binary → null).
/// Renames show as a delete + an add (`--no-renames`), matching the diff
/// stats on the board.
pub fn review_files(worktree: &Path, base: &str) -> Result<Vec<FileChange>, GitError> {
    let mb = merge_base(worktree, base)?;
    let name_status = run_git(
        worktree,
        &["diff", "--name-status", "--no-renames", "--no-ext-diff", "-z", &mb],
    )?;
    let numstat = run_git(
        worktree,
        &["diff", "--numstat", "--no-renames", "--no-ext-diff", "-z", &mb],
    )?;
    let counts = parse_numstat_z(&numstat);
    let dirty: HashMap<String, FileStatus> = parse_porcelain(&run_git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    )?)
    .into_iter()
    .map(|c| {
        let kind = if c.unstaged == FileStatus::Untracked {
            FileStatus::Untracked
        } else {
            FileStatus::Modified
        };
        (c.path, kind)
    })
    .collect();

    let mut out = Vec::new();
    let mut fields = name_status.split('\0').filter(|f| !f.is_empty());
    while let (Some(code), Some(path)) = (fields.next(), fields.next()) {
        let staged = match code.chars().next() {
            Some('A') => FileStatus::Added,
            Some('M') | Some('T') => FileStatus::Modified,
            Some('D') => FileStatus::Deleted,
            Some('U') => FileStatus::Conflicted,
            _ => FileStatus::Other,
        };
        let (adds, removes) = counts.get(path).copied().unwrap_or((None, None));
        out.push(FileChange {
            path: path.to_string(),
            old_path: None,
            staged,
            unstaged: dirty.get(path).copied().unwrap_or(FileStatus::Other),
            adds,
            removes,
        });
    }
    for rel in untracked(worktree)? {
        let lines = count_lines_capped(&worktree.join(&rel));
        out.push(FileChange {
            path: rel,
            old_path: None,
            staged: FileStatus::Untracked,
            unstaged: FileStatus::Untracked,
            adds: Some(lines as u32),
            removes: Some(0),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// `adds\tremoves\tpath\0` records (`--no-renames -z`); binary = `-`.
fn parse_numstat_z(out: &str) -> HashMap<&str, (Option<u32>, Option<u32>)> {
    let mut map = HashMap::new();
    for rec in out.split('\0').filter(|r| !r.is_empty()) {
        let mut cols = rec.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        map.insert(path, (a.parse().ok(), r.parse().ok()));
    }
    map
}

/// Untracked, non-ignored files (nested repositories excluded).
fn untracked(worktree: &Path) -> Result<Vec<String>, GitError> {
    Ok(run_git(worktree, &["ls-files", "-o", "--exclude-standard", "-z"])?
        .split('\0')
        .filter(|p| !p.is_empty() && !p.ends_with('/'))
        .map(str::to_string)
        .collect())
}

/// A CHEAP key for `worktree_fingerprint`'s cache: HEAD, the status
/// listing, and each listed path's mtime/size — so an edit to an
/// already-modified file, whose status line doesn't change, still changes
/// the key. Two git calls and some `stat`s, versus the full fingerprint's
/// `git diff HEAD` plus reading every untracked file, which
/// `list_check_runs` used to pay on every call. (The index isn't part of
/// it: the fingerprint's diff is worktree-vs-HEAD, and staging shows up in
/// the status letters. Its mtime would also move on every `git status`
/// refresh, making the cache useless.)
///
/// Blocking: call from `spawn_blocking`.
pub fn fingerprint_key(worktree: &Path) -> Result<String, GitError> {
    let mut hasher = Sha256::new();
    let head = run_git(worktree, &["rev-parse", "HEAD"]).unwrap_or_default();
    hasher.update(head.trim().as_bytes());
    hasher.update([0]);
    let status = run_git(
        worktree,
        &["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    hasher.update(status.as_bytes());
    for change in parse_porcelain(&status) {
        hasher.update([0]);
        match std::fs::symlink_metadata(worktree.join(&change.path)) {
            Ok(meta) => {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                hasher.update(format!("{mtime}:{}", meta.len()).as_bytes());
            }
            Err(_) => hasher.update(b"-"),
        }
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// sha256 over the worktree's exact state: HEAD, `git status --porcelain=v1
/// -z`, `git diff HEAD`, and the contents of untracked files.
///
/// Two equal fingerprints mean the checks would see the same code, so a
/// check's result stays valid exactly as long as the fingerprint does
/// (`domain::review::unsatisfied_required`). The untracked contents are
/// beyond the plan's HEAD + status + diff: without them an agent editing a
/// NEW file (still untracked — its status line doesn't change) would leave
/// a stale pass looking current. Capped like the board's diff stats.
///
/// Blocking (several git processes): call from `spawn_blocking`.
pub fn worktree_fingerprint(worktree: &Path) -> Result<String, GitError> {
    let mut hasher = Sha256::new();
    // An unborn branch (no commits yet) has no HEAD; that's still a state.
    let head = run_git(worktree, &["rev-parse", "HEAD"]).unwrap_or_default();
    hasher.update(head.trim().as_bytes());
    hasher.update([0]);
    hasher.update(
        run_git(worktree, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?.as_bytes(),
    );
    hasher.update([0]);
    if !head.trim().is_empty() {
        hasher.update(run_git(worktree, &["diff", "--no-color", "--no-ext-diff", "HEAD"])?.as_bytes());
    }
    for rel in untracked(worktree)?.into_iter().take(FINGERPRINT_FILE_CAP) {
        hasher.update([0]);
        hasher.update(rel.as_bytes());
        hasher.update([0]);
        let path = worktree.join(&rel);
        // Only regular files are read (capped). A symlink contributes its
        // TARGET (what git would commit), anything else (FIFO, device) just
        // its type — following them could block forever or never end.
        match open_regular_untracked(&path) {
            Some(file) => {
                let mut buf = Vec::new();
                if file.take(FINGERPRINT_READ_CAP).read_to_end(&mut buf).is_ok() {
                    hasher.update(&buf);
                }
            }
            None => match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    hasher.update(b"symlink:");
                    if let Ok(target) = std::fs::read_link(&path) {
                        hasher.update(target.to_string_lossy().as_bytes());
                    }
                }
                Ok(meta) => hasher.update(format!("special:{:?}", meta.file_type()).as_bytes()),
                Err(_) => hasher.update(b"missing"),
            },
        }
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// main: a.txt, gone.txt. Task branch commits an edit to a.txt and
    /// deletes gone.txt; main then moves on (later.txt — must not show).
    /// Uncommitted: staged new file, unstaged edit to a.txt, untracked file.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::write(p.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(p.join("gone.txt"), "x\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        git(p, &["checkout", "-qb", "task"]);
        std::fs::write(p.join("a.txt"), "1\nTWO\n3\n").unwrap();
        git(p, &["rm", "-q", "gone.txt"]);
        git(p, &["commit", "-qam", "task work"]);
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("later.txt"), "later\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "main moves"]);
        git(p, &["checkout", "-q", "task"]);
        std::fs::write(p.join("staged.txt"), "s\n").unwrap();
        git(p, &["add", "staged.txt"]);
        std::fs::write(p.join("a.txt"), "1\nTWO\n3\n4\n").unwrap();
        std::fs::write(p.join("new.rs"), "fn a() {}\n").unwrap();
        dir
    }

    #[test]
    fn base_diff_covers_committed_and_uncommitted_but_not_base_moves() {
        let dir = repo();
        let diff = diff_vs_base(dir.path(), "main", None).unwrap();
        assert!(diff.contains("+TWO"), "committed edit: {diff}");
        assert!(diff.contains("+4"), "unstaged edit: {diff}");
        assert!(diff.contains("b/staged.txt"), "staged file: {diff}");
        assert!(diff.contains("deleted file mode"), "committed delete: {diff}");
        assert!(diff.contains("+++ b/new.rs"), "untracked file: {diff}");
        assert!(!diff.contains("later.txt"), "base's own later commit: {diff}");

        let one = diff_vs_base(dir.path(), "main", Some("a.txt")).unwrap();
        assert!(one.contains("+TWO") && one.contains("+4") && !one.contains("staged.txt"));
        assert!(diff_vs_base(dir.path(), "main", Some("new.rs")).unwrap().contains("+fn a() {}"));
        assert!(diff_vs_base(dir.path(), "no-such-base", None).is_err());
    }

    #[test]
    fn review_files_list_committed_uncommitted_and_untracked() {
        let dir = repo();
        let files = review_files(dir.path(), "main").unwrap();
        let by = |p: &str| files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} missing: {files:?}"));
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "gone.txt", "new.rs", "staged.txt"]);
        let a = by("a.txt");
        assert_eq!((a.staged, a.unstaged, a.adds, a.removes), (FileStatus::Modified, FileStatus::Modified, Some(2), Some(1)));
        let gone = by("gone.txt");
        assert_eq!((gone.staged, gone.unstaged), (FileStatus::Deleted, FileStatus::Other), "committed only");
        assert_eq!(by("staged.txt").staged, FileStatus::Added);
        let new = by("new.rs");
        assert_eq!((new.staged, new.adds), (FileStatus::Untracked, Some(1)));
    }

    #[test]
    fn merge_base_uses_a_fresher_origin_base_the_task_was_cut_from() {
        // upstream: main moves on; the clone's local main stays behind, and
        // the task is cut from the fetched origin/main.
        let upstream = tempfile::tempdir().unwrap();
        git(upstream.path(), &["init", "-q", "-b", "main"]);
        git(upstream.path(), &["config", "user.email", "t@example.com"]);
        git(upstream.path(), &["config", "user.name", "t"]);
        std::fs::write(upstream.path().join("a.txt"), "a\n").unwrap();
        git(upstream.path(), &["add", "-A"]);
        git(upstream.path(), &["commit", "-qm", "init"]);
        let clone_dir = tempfile::tempdir().unwrap();
        git(clone_dir.path(), &["clone", "-q", &upstream.path().to_string_lossy(), "c"]);
        let c = clone_dir.path().join("c");
        git(&c, &["config", "user.email", "t@example.com"]);
        git(&c, &["config", "user.name", "t"]);
        std::fs::write(upstream.path().join("upstream.txt"), "u\n").unwrap();
        git(upstream.path(), &["add", "-A"]);
        git(upstream.path(), &["commit", "-qm", "upstream moves"]);
        git(&c, &["fetch", "-q", "origin", "main"]);
        git(&c, &["checkout", "-qb", "task", "origin/main"]);
        std::fs::write(c.join("mine.txt"), "m\n").unwrap();

        let files = review_files(&c, "main").unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, vec!["mine.txt"], "upstream's commit is not the task's");
        let stats = super::super::diff::diff_stats_vs_base(&c, "main").unwrap();
        assert_eq!(stats.files, 1, "{stats:?}");
    }

    #[test]
    fn fingerprint_changes_with_any_edit_and_is_stable_otherwise() {
        let dir = repo();
        let p = dir.path();
        let first = worktree_fingerprint(p).unwrap();
        assert_eq!(first, worktree_fingerprint(p).unwrap(), "stable for the same state");
        assert_eq!(first.len(), 64);

        // An edit to a tracked file.
        std::fs::write(p.join("a.txt"), "1\nTWO\n3\n4\n5\n").unwrap();
        let edited = worktree_fingerprint(p).unwrap();
        assert_ne!(first, edited);
        // An edit inside an untracked file (status line unchanged).
        std::fs::write(p.join("new.rs"), "fn a() { panic!() }\n").unwrap();
        let untracked_edit = worktree_fingerprint(p).unwrap();
        assert_ne!(edited, untracked_edit);
        // Committing the same content still moves HEAD → new state.
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "wip"]);
        assert_ne!(untracked_edit, worktree_fingerprint(p).unwrap());
    }

    /// Untracked symlinks are never followed: a link to /dev/zero must not
    /// be read to the end (OOM) and a link to a FIFO must not block (hung
    /// `list_check_runs` / Approve). Both count 0 lines; the fingerprint
    /// hashes the link target, so retargeting a link still changes it.
    #[cfg(unix)]
    #[test]
    fn untracked_symlinks_to_devices_and_fifos_are_not_followed() {
        let dir = repo();
        let p = dir.path().to_path_buf();
        git(&p, &["checkout", "-q", "task"]);
        let fifo = p.join("pipe-target");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        std::os::unix::fs::symlink("/dev/zero", p.join("zero-link")).unwrap();
        std::os::unix::fs::symlink(&fifo, p.join("fifo-link")).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let worker = p.clone();
        std::thread::spawn(move || {
            let files = review_files(&worker, "main").unwrap();
            let diff = diff_vs_base(&worker, "main", None).unwrap();
            let one = diff_vs_base(&worker, "main", Some("zero-link")).unwrap();
            let fifo_one = diff_vs_base(&worker, "main", Some("fifo-link")).unwrap();
            let fp = worktree_fingerprint(&worker).unwrap();
            let stats = super::super::diff::diff_stats_vs_base(&worker, "main").unwrap();
            let fifo_lines = count_lines_capped(&worker.join("pipe-target"));
            let _ = tx.send((files, diff, one, fifo_one, fp, stats, fifo_lines));
        });
        let (files, diff, one, fifo_one, fp, _stats, fifo_lines) = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("reading untracked links hung (followed a FIFO?)");
        for link in ["zero-link", "fifo-link"] {
            let f = files.iter().find(|f| f.path == link).unwrap_or_else(|| panic!("{link} listed"));
            assert_eq!(f.adds, Some(0), "{link} counts 0 lines");
        }
        assert_eq!(fifo_lines, 0, "a raw FIFO is never opened for reading");
        assert!(diff.len() < 64 * 1024, "no /dev/zero contents in the diff");
        assert!(one.contains("new file mode 120000") && one.contains("+/dev/zero"), "{one}");
        assert!(fifo_one.contains("new file mode 120000"), "{fifo_one}");

        std::fs::remove_file(p.join("zero-link")).unwrap();
        std::os::unix::fs::symlink("/dev/null", p.join("zero-link")).unwrap();
        assert_ne!(worktree_fingerprint(&p).unwrap(), fp, "retargeting a link changes the fingerprint");
    }

    /// The cache key moves whenever the fingerprint would: HEAD, the
    /// status, AND an edit to a file that was already modified.
    #[test]
    fn fingerprint_key_tracks_edits_to_already_dirty_files() {
        let dir = repo();
        let p = dir.path();
        git(p, &["checkout", "-q", "task"]);
        std::fs::write(p.join("a.txt"), "dirty 1\n").unwrap();
        let k1 = fingerprint_key(p).unwrap();
        assert_eq!(fingerprint_key(p).unwrap(), k1, "stable while nothing changes");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(p.join("a.txt"), "dirty 22\n").unwrap();
        let k2 = fingerprint_key(p).unwrap();
        assert_ne!(k1, k2, "same status line, new contents");
        git(p, &["commit", "-qam", "c"]);
        assert_ne!(fingerprint_key(p).unwrap(), k2, "HEAD moved");
    }
}
