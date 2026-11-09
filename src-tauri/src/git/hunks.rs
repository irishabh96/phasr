//! "Revert hunk" from the editor's inline agent hint and the review diff.
//!
//! The client names the hunk by its `@@ … @@` header, but never sends the
//! hunk body: the diff is recomputed here and the hunk with that exact
//! header is reverse-applied to the working tree. If the agent (or the user)
//! has edited the file since the client rendered the diff, the header no
//! longer exists and nothing is touched — reverting stale lines could undo
//! work the user never saw.

use std::path::Path;

use thiserror::Error;

use super::diff::{diff, DiffScope};
use super::error::{run_git_with_stdin, GitError};
use super::review::diff_vs_base;

#[derive(Debug, Error)]
pub enum RevertHunkError {
    /// The frontend matches this exact string to refresh the diff.
    #[error("hunk no longer matches")]
    NoLongerMatches,
    #[error("only Base and Head diffs can be reverted by hunk")]
    UnsupportedScope,
    #[error(transparent)]
    Git(#[from] GitError),
}

impl serde::Serialize for RevertHunkError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Undo one hunk of `path` in `worktree`'s working tree.
///
/// - `Head`: the hunk of `git diff HEAD -- path` (uncommitted work).
/// - `Base`: the hunk of the task's whole diff vs its merge-base with
///   `base` (committed work too). Reverting a committed hunk leaves an
///   uncommitted change that undoes it — history is never rewritten.
///
/// Either way the diff's new side IS the working tree, so `git apply -R`
/// (working tree only, no `--index`) is exactly "put these lines back".
/// The index is left alone: a staged copy of the hunk stays staged.
///
/// Blocking: call from `spawn_blocking`.
pub fn revert_hunk(
    worktree: &Path,
    path: &str,
    hunk_header: &str,
    scope: DiffScope,
    base: Option<&str>,
) -> Result<(), RevertHunkError> {
    let full = match (scope, base) {
        (DiffScope::Head, _) => diff(worktree, DiffScope::Head, Some(path))?,
        (DiffScope::Base, Some(base)) => diff_vs_base(worktree, base, Some(path))?,
        _ => return Err(RevertHunkError::UnsupportedScope),
    };
    let patch = single_hunk_patch(&full, hunk_header).ok_or(RevertHunkError::NoLongerMatches)?;
    run_git_with_stdin(
        worktree,
        &["apply", "-R", "--whitespace=nowarn", "-"],
        &patch,
    )?;
    Ok(())
}

/// The file header of a one-file unified diff plus the single hunk whose
/// header line equals `header` (whole line, or just its `@@ -a,b +c,d @@`
/// range when the caller sent only that). `None` if no hunk matches, or if
/// the diff holds more than one file (a path-limited diff never should).
pub fn single_hunk_patch(diff: &str, header: &str) -> Option<String> {
    let wanted = header.trim_end_matches(['\r', '\n']).trim_end();
    if wanted.is_empty() {
        return None;
    }
    let lines: Vec<&str> = diff.split_inclusive('\n').collect();
    let first_hunk = lines.iter().position(|l| l.starts_with("@@"))?;
    if lines
        .iter()
        .filter(|l| l.starts_with("diff --git "))
        .count()
        > 1
    {
        return None;
    }
    let mut out: String = lines[..first_hunk].concat();
    let mut i = first_hunk;
    while i < lines.len() {
        let line = lines[i];
        if !line.starts_with("@@") {
            i += 1;
            continue;
        }
        let end = lines[i + 1..]
            .iter()
            .position(|l| l.starts_with("@@"))
            .map(|n| i + 1 + n)
            .unwrap_or(lines.len());
        let this = line.trim_end_matches(['\r', '\n']).trim_end();
        if this == wanted || range_part(this) == Some(wanted) {
            for l in &lines[i..end] {
                out.push_str(l);
            }
            if !out.ends_with('\n') {
                out.push('\n');
            }
            return Some(out);
        }
        i = end;
    }
    None
}

/// `@@ -1,3 +1,4 @@` out of `@@ -1,3 +1,4 @@ fn main() {`.
fn range_part(header: &str) -> Option<&str> {
    let rest = header.strip_prefix("@@")?;
    let close = rest.find("@@")?;
    Some(&header[..2 + close + 2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    /// main: f.txt with 20 lines. Task branch commits an edit near the top
    /// (committed hunk) then leaves an uncommitted edit near the bottom.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::write(p.join("f.txt"), lines(20)).unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        git(p, &["checkout", "-qb", "task"]);
        let committed = lines(20).replace("line 2\n", "line 2 COMMITTED\n");
        std::fs::write(p.join("f.txt"), &committed).unwrap();
        git(p, &["commit", "-qam", "task work"]);
        let dirty = committed.replace("line 18\n", "line 18 DIRTY\n");
        std::fs::write(p.join("f.txt"), dirty).unwrap();
        dir
    }

    fn headers(diff: &str) -> Vec<String> {
        diff.lines().filter(|l| l.starts_with("@@")).map(str::to_string).collect()
    }

    #[test]
    fn reverts_an_uncommitted_hunk_against_head() {
        let dir = repo();
        let p = dir.path();
        let d = diff(p, DiffScope::Head, Some("f.txt")).unwrap();
        let h = headers(&d);
        assert_eq!(h.len(), 1, "{d}");
        revert_hunk(p, "f.txt", &h[0], DiffScope::Head, None).unwrap();
        let now = std::fs::read_to_string(p.join("f.txt")).unwrap();
        assert!(!now.contains("DIRTY"));
        assert!(now.contains("line 2 COMMITTED"), "committed work untouched");
    }

    #[test]
    fn reverts_a_committed_hunk_against_the_base_leaving_the_other() {
        let dir = repo();
        let p = dir.path();
        let d = diff_vs_base(p, "main", Some("f.txt")).unwrap();
        let h = headers(&d);
        assert_eq!(h.len(), 2, "{d}");
        // The first hunk is the committed edit near the top.
        revert_hunk(p, "f.txt", &h[0], DiffScope::Base, Some("main")).unwrap();
        let now = std::fs::read_to_string(p.join("f.txt")).unwrap();
        assert!(!now.contains("COMMITTED"));
        assert!(now.contains("line 18 DIRTY"), "the other hunk stays");
        // History isn't rewritten: the revert is an uncommitted change.
        assert!(git(p, &["show", "HEAD:f.txt"]).contains("COMMITTED"));
    }

    #[test]
    fn a_stale_header_touches_nothing() {
        let dir = repo();
        let p = dir.path();
        let d = diff(p, DiffScope::Head, Some("f.txt")).unwrap();
        let h = headers(&d);
        // The agent edits the file again, shifting the hunk.
        let moved = std::fs::read_to_string(p.join("f.txt")).unwrap().replace("line 1\n", "line 0\nline 1\n");
        std::fs::write(p.join("f.txt"), &moved).unwrap();
        let err = revert_hunk(p, "f.txt", &h[0], DiffScope::Head, None).unwrap_err();
        assert!(matches!(err, RevertHunkError::NoLongerMatches));
        assert_eq!(serde_json::to_value(&err).unwrap(), "hunk no longer matches");
        assert_eq!(std::fs::read_to_string(p.join("f.txt")).unwrap(), moved);
        assert!(matches!(
            revert_hunk(p, "f.txt", &h[0], DiffScope::Unstaged, None),
            Err(RevertHunkError::UnsupportedScope)
        ));
    }

    #[test]
    fn reverting_an_untracked_files_only_hunk_removes_the_file() {
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("new.rs"), "fn a() {}\n").unwrap();
        let d = diff(p, DiffScope::Head, Some("new.rs")).unwrap();
        let h = headers(&d);
        revert_hunk(p, "new.rs", &h[0], DiffScope::Head, None).unwrap();
        assert!(!p.join("new.rs").exists());
    }

    #[test]
    fn single_hunk_patch_matches_whole_line_or_range() {
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn main() {\n-a\n+b\n c\n@@ -9,1 +9,1 @@\n-y\n+z\n";
        let one = single_hunk_patch(diff, "@@ -1,2 +1,2 @@ fn main() {").unwrap();
        assert!(one.contains("+b") && !one.contains("+z") && one.starts_with("diff --git"));
        let by_range = single_hunk_patch(diff, "@@ -1,2 +1,2 @@").unwrap();
        assert_eq!(one, by_range);
        let last = single_hunk_patch(diff, "@@ -9,1 +9,1 @@\n").unwrap();
        assert!(last.contains("+z") && !last.contains("+b"));
        assert!(single_hunk_patch(diff, "@@ -5,1 +5,1 @@").is_none());
        assert!(single_hunk_patch(diff, "").is_none());
        assert!(single_hunk_patch("", "@@ -1 +1 @@").is_none());
    }
}
