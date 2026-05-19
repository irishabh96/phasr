use std::path::Path;

use serde::Serialize;

use super::error::{run_git, GitError};

/// Combined index + working-tree status for one file. Mirrors what
/// `git status --porcelain=v1` produces (two letters indicating
/// staged/unstaged state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Optional rename source (only for `Renamed`).
    pub old_path: Option<String>,
    pub staged: FileStatus,
    pub unstaged: FileStatus,
}

/// Lists the working-tree changes in `cwd` (which should be either a
/// worktree directory or a regular repo path).
pub fn status(cwd: &Path) -> Result<Vec<FileChange>, GitError> {
    // `-z` produces NUL-delimited records, with paths NUL-terminated,
    // and (for renames) old\0new pairs. We parse defensively.
    let stdout = run_git(cwd, &["status", "--porcelain=v1", "-z"])?;
    Ok(parse_porcelain(&stdout))
}

fn parse_porcelain(input: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut iter = input.split('\0').peekable();
    while let Some(entry) = iter.next() {
        if entry.is_empty() {
            continue;
        }
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let staged_code = bytes[0] as char;
        let unstaged_code = bytes[1] as char;
        let path = &entry[3..];

        // Renames pair the entry with its source path in the next slot.
        let old_path = if staged_code == 'R' || unstaged_code == 'R' {
            iter.next().map(|s| s.to_string())
        } else {
            None
        };

        out.push(FileChange {
            path: path.to_string(),
            old_path,
            staged: status_from_code(staged_code, false),
            unstaged: status_from_code(unstaged_code, true),
        });
    }
    out
}

fn status_from_code(code: char, is_unstaged: bool) -> FileStatus {
    match code {
        ' ' => FileStatus::Other,
        'A' => FileStatus::Added,
        'M' => FileStatus::Modified,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        '?' if is_unstaged => FileStatus::Untracked,
        'U' => FileStatus::Conflicted,
        _ => FileStatus::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_changes() {
        // Two modified + one untracked + one staged-added.
        let input = " M src/a.rs\0M  src/b.rs\0?? new.txt\0A  added.rs\0";
        let parsed = parse_porcelain(input);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[0].path, "src/a.rs");
        assert_eq!(parsed[0].unstaged, FileStatus::Modified);
        assert_eq!(parsed[1].path, "src/b.rs");
        assert_eq!(parsed[1].staged, FileStatus::Modified);
        assert_eq!(parsed[2].path, "new.txt");
        assert_eq!(parsed[2].unstaged, FileStatus::Untracked);
        assert_eq!(parsed[3].path, "added.rs");
        assert_eq!(parsed[3].staged, FileStatus::Added);
    }

    #[test]
    fn parses_rename_with_old_path() {
        let input = "R  new/path.rs\0old/path.rs\0";
        let parsed = parse_porcelain(input);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "new/path.rs");
        assert_eq!(parsed[0].old_path.as_deref(), Some("old/path.rs"));
        assert_eq!(parsed[0].staged, FileStatus::Renamed);
    }
}
