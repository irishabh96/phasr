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
