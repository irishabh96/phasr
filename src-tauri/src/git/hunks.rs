//! "Revert hunk" from the editor's inline agent hint and the review diff.
//!
//! The client names the hunk by its `@@ … @@` header AND sends the hunk as
//! it rendered it; the diff is recomputed here and the hunk with that
//! header is reverse-applied to the working tree only if its lines are
//! exactly the ones the user saw. If the agent (or the user) has edited the
//! file since the client rendered the diff, nothing is touched — reverting
//! stale lines could undo work the user never saw. (Matching the header
//! alone missed an edit INSIDE the hunk that kept its line counts.)

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
    hunk_body: &str,
    scope: DiffScope,
    base: Option<&str>,
) -> Result<(), RevertHunkError> {
    let full = match (scope, base) {
        (DiffScope::Head, _) => diff(worktree, DiffScope::Head, Some(path))?,
        (DiffScope::Base, Some(base)) => diff_vs_base(worktree, base, Some(path))?,
        _ => return Err(RevertHunkError::UnsupportedScope),
    };
    let patch =
        single_hunk_patch(&full, hunk_header, hunk_body).ok_or(RevertHunkError::NoLongerMatches)?;
    run_git_with_stdin(
        worktree,
        &["apply", "-R", "--whitespace=nowarn", "-"],
        &patch,
    )?;
    Ok(())
}

/// The file header of a one-file unified diff plus the single hunk whose
/// header line equals `header` (whole line, or just its `@@ -a,b +c,d @@`
/// range when the caller sent only that) and whose lines equal `body`.
/// `None` if no hunk matches, if the matching hunk's lines differ from
/// `body`, or if the diff holds more than one file (a path-limited diff
/// never should).
///
/// `body` is the hunk as the client rendered it: its `-`/`+`/` ` lines
/// (and any `\ No newline at end of file`), with or without the `@@`
/// header line in front. Line endings and trailing blank lines don't
/// count; every other byte does.
pub fn single_hunk_patch(diff: &str, header: &str, body: &str) -> Option<String> {
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
            if hunk_lines(lines[i + 1..end].iter().copied())
                != hunk_lines(body_without_header(body).lines())
            {
                return None;
            }
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

/// `body` minus a leading `@@ … @@` header line, if it has one.
fn body_without_header(body: &str) -> &str {
    if body.starts_with("@@") {
        body.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        body
    }
}

/// A hunk's lines for comparison: line endings stripped, trailing empty
/// lines dropped (a client may or may not end with a newline).
fn hunk_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = lines.map(|l| l.trim_end_matches(['\n', '\r'])).collect();
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
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
        diff.lines()
            .filter(|l| l.starts_with("@@"))
            .map(str::to_string)
            .collect()
    }

    /// Hunk `n` of `diff` as the client renders it: header + lines.
    fn hunk(diff: &str, n: usize) -> String {
        let mut out = Vec::new();
        let mut seen = None;
        for line in diff.lines() {
            if line.starts_with("@@") {
                seen = Some(seen.map_or(0, |s: usize| s + 1));
            }
            if seen == Some(n) {
                out.push(line);
            }
        }
        out.join("\n")
    }

    /// The case the header alone missed: an edit INSIDE the hunk that keeps
    /// its line counts (same `@@` header) must not be reverted unseen.
    #[test]
    fn an_edit_inside_the_hunk_with_the_same_header_touches_nothing() {
        let dir = repo();
        let p = dir.path();
        let d = diff(p, DiffScope::Head, Some("f.txt")).unwrap();
        let (h, seen) = (headers(&d), hunk(&d, 0));
        let edited = std::fs::read_to_string(p.join("f.txt"))
            .unwrap()
            .replace("line 18 DIRTY\n", "line 18 SOMETHING ELSE\n");
        std::fs::write(p.join("f.txt"), &edited).unwrap();
        assert_eq!(
            headers(&diff(p, DiffScope::Head, Some("f.txt")).unwrap()),
            h,
            "header unchanged"
        );
        let err = revert_hunk(p, "f.txt", &h[0], &seen, DiffScope::Head, None).unwrap_err();
        assert!(matches!(err, RevertHunkError::NoLongerMatches));
        assert_eq!(std::fs::read_to_string(p.join("f.txt")).unwrap(), edited);
        // The body without its header line, CRLF endings, a trailing
        // newline: all the same hunk.
        let d = diff(p, DiffScope::Head, Some("f.txt")).unwrap();
        let body = hunk(&d, 0);
        let without_header = body.split_once('\n').unwrap().1.replace('\n', "\r\n") + "\r\n";
        revert_hunk(p, "f.txt", &h[0], &without_header, DiffScope::Head, None).unwrap();
        assert!(!std::fs::read_to_string(p.join("f.txt"))
            .unwrap()
            .contains("SOMETHING ELSE"));
    }

    #[test]
    fn reverts_an_uncommitted_hunk_against_head() {
        let dir = repo();
        let p = dir.path();
        let d = diff(p, DiffScope::Head, Some("f.txt")).unwrap();
        let h = headers(&d);
        assert_eq!(h.len(), 1, "{d}");
        revert_hunk(p, "f.txt", &h[0], &hunk(&d, 0), DiffScope::Head, None).unwrap();
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
        revert_hunk(
            p,
            "f.txt",
            &h[0],
            &hunk(&d, 0),
            DiffScope::Base,
            Some("main"),
        )
        .unwrap();
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
        let moved = std::fs::read_to_string(p.join("f.txt"))
            .unwrap()
            .replace("line 1\n", "line 0\nline 1\n");
        std::fs::write(p.join("f.txt"), &moved).unwrap();
        let err = revert_hunk(p, "f.txt", &h[0], &hunk(&d, 0), DiffScope::Head, None).unwrap_err();
        assert!(matches!(err, RevertHunkError::NoLongerMatches));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            "hunk no longer matches"
        );
        assert_eq!(std::fs::read_to_string(p.join("f.txt")).unwrap(), moved);
        assert!(matches!(
            revert_hunk(p, "f.txt", &h[0], &hunk(&d, 0), DiffScope::Unstaged, None),
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
        revert_hunk(p, "new.rs", &h[0], &hunk(&d, 0), DiffScope::Head, None).unwrap();
        assert!(!p.join("new.rs").exists());
    }

    #[test]
    fn single_hunk_patch_matches_whole_line_or_range() {
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn main() {\n-a\n+b\n c\n@@ -9,1 +9,1 @@\n-y\n+z\n";
        let first = "-a\n+b\n c\n";
        let one = single_hunk_patch(diff, "@@ -1,2 +1,2 @@ fn main() {", first).unwrap();
        assert!(one.contains("+b") && !one.contains("+z") && one.starts_with("diff --git"));
        let by_range = single_hunk_patch(diff, "@@ -1,2 +1,2 @@", first).unwrap();
        assert_eq!(one, by_range);
        let last = single_hunk_patch(diff, "@@ -9,1 +9,1 @@\n", "@@ -9,1 +9,1 @@\n-y\n+z").unwrap();
        assert!(last.contains("+z") && !last.contains("+b"));
        // Right header, different lines: refused.
        assert!(single_hunk_patch(diff, "@@ -9,1 +9,1 @@", "-y\n+Z\n").is_none());
        assert!(single_hunk_patch(diff, "@@ -9,1 +9,1 @@", "").is_none());
        assert!(single_hunk_patch(diff, "@@ -5,1 +5,1 @@", first).is_none());
        assert!(single_hunk_patch(diff, "", first).is_none());
        assert!(single_hunk_patch("", "@@ -1 +1 @@", first).is_none());
    }
}
