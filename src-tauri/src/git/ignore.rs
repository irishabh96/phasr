//! The repository's own ignore rules (`.gitignore`, `info/exclude`, the
//! global excludes file), asked of git rather than re-implemented.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use super::error::GitError;

/// Which of `paths` (worktree-relative) git ignores in `worktree`.
///
/// One `git check-ignore --stdin` for the whole batch. Paths go in and come
/// out NUL-separated (`-z`), so any file name survives. stdin is written
/// from a second thread: git answers as it reads, and a large batch would
/// otherwise fill the stdout pipe while we're still writing and deadlock.
/// Blocking: call off the async runtime.
pub fn check_ignored(worktree: &Path, paths: &[&str]) -> Result<HashSet<String>, GitError> {
    if paths.is_empty() {
        return Ok(HashSet::new());
    }
    let mut child = Command::new("git")
        .args(["check-ignore", "-z", "--stdin"])
        .current_dir(worktree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take();
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let mut out = Vec::new();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            if let Some(stdin) = stdin.as_mut() {
                // A write error means git exited early; its status says why.
                let _ = stdin.write_all(&input);
            }
            // Dropping stdin closes it: git sees EOF and exits.
        });
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_end(&mut out);
        }
    });
    let output = child.wait_with_output()?;
    // 0 = some are ignored, 1 = none are; anything else is a failure
    // (not a repository, …).
    match output.status.code() {
        Some(0) | Some(1) => Ok(out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect()),
        _ => Err(GitError::CommandFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
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
    }

    #[test]
    fn reports_exactly_the_ignored_paths() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        std::fs::write(p.join(".gitignore"), "out/\n*.log\n!keep.log\n").unwrap();
        std::fs::create_dir_all(p.join("out/deep")).unwrap();
        let ignored = check_ignored(
            p,
            &[
                "out/deep/a.js",
                "x.log",
                "keep.log",
                "src/a.rs",
                "out",
                "weird name\nwith newline.log",
            ],
        )
        .unwrap();
        let expected: HashSet<String> = [
            "out/deep/a.js",
            "x.log",
            "out",
            "weird name\nwith newline.log",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(ignored, expected);
        assert!(
            check_ignored(p, &["src/a.rs"]).unwrap().is_empty(),
            "exit 1 is not an error"
        );
        assert!(check_ignored(p, &[]).unwrap().is_empty());
    }

    /// Enough paths to overflow a pipe in both directions at once.
    #[test]
    fn a_large_batch_does_not_deadlock() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        std::fs::write(p.join(".gitignore"), "gen/\n").unwrap();
        let paths: Vec<String> = (0..20_000)
            .map(|i| format!("gen/some/long/directory/name/file-{i}.js"))
            .collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        assert_eq!(check_ignored(p, &refs).unwrap().len(), 20_000);
    }

    #[test]
    fn outside_a_repository_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_ignored(dir.path(), &["a"]).is_err());
    }
}
