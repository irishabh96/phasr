use std::path::Path;

use super::error::{run_git, GitError};

const MAX_FILES: usize = 5000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "out",
    ".turbo",
    ".vercel",
    "vendor",
];

/// List files in a repository for the file-search modal.
///
/// If `<path>/.git` exists we ask git itself (`ls-files --cached --others
/// --exclude-standard`), so `.gitignore` is honoured for free and the
/// list matches what shows in any other git tool. Otherwise we fall
/// back to a manual walk that skips well-known heavy folders.
///
/// Returns relative paths, capped at 5000 (closest-to-root files win
/// when truncated).
pub fn list_files(repo_path: &Path) -> Result<Vec<String>, GitError> {
    if !repo_path.exists() {
        return Err(GitError::InvalidPath);
    }

    if repo_path.join(".git").exists() {
        let stdout = run_git(
            repo_path,
            &["ls-files", "--cached", "--others", "--exclude-standard"],
        )?;
        let mut files: Vec<String> =
            stdout.lines().map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
        if files.len() > MAX_FILES {
            files.sort_by_key(|p| p.matches('/').count());
            files.truncate(MAX_FILES);
        }
        return Ok(files);
    }

    Ok(walk_dir(repo_path))
}

fn walk_dir(root: &Path) -> Vec<String> {
    let mut out: Vec<(usize, String)> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if SKIP_DIRS.iter().any(|s| name_str == *s) {
                continue;
            }
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    let rel_str = rel.to_string_lossy().into_owned();
                    let depth = rel_str.matches('/').count();
                    out.push((depth, rel_str));
                }
            }
        }
    }

    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    if out.len() > MAX_FILES {
        out.truncate(MAX_FILES);
    }
    out.into_iter().map(|(_, p)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walks_a_plain_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "hi").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.txt"), "hi").unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/skip.js"), "x").unwrap();

        let files = list_files(dir.path()).unwrap();
        assert!(files.iter().any(|p| p == "a.txt"));
        assert!(files.iter().any(|p| p == "sub/b.txt" || p == "sub\\b.txt"));
        assert!(!files.iter().any(|p| p.contains("node_modules")));
    }
}
