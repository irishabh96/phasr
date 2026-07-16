use std::path::Path;

use serde::Deserialize;

use super::error::{run_git, GitError};

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum DiffScope {
    /// Working-tree changes that have not been `git add`-ed.
    Unstaged,
    /// Changes already in the index.
    Staged,
    /// Combined diff against HEAD (staged + unstaged).
    Head,
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
    }
    if let Some(p) = path {
        args.push("--");
        args.push(p);
    }
    run_git(cwd, &args)
}

fn synthesise_new_file_diff(cwd: &Path, rel_path: &str) -> Result<String, GitError> {
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
