//! The Files tab: a worktree's file tree with git badges, and confined,
//! conflict-checked reads and writes of single files.
//!
//! Every path goes through `fs_guard::resolve_in_worktree` first. Blocking
//! (git processes + file IO): call from `spawn_blocking`.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::error::{run_git, GitError};
use super::fs_guard::{resolve_in_worktree, FsGuardError};
use super::status::{parse_porcelain, FileStatus};

/// Past this many paths the tree is cut (shallowest kept) and flagged.
pub const MAX_TREE_FILES: usize = 50_000;
/// Same ceiling as the preview tab (`commands::files`).
pub const MAX_READ_BYTES: u64 = 1_048_576;
/// Generous for hand-edited text, small enough that a runaway paste can't
/// balloon the IPC payload.
pub const MAX_WRITE_BYTES: usize = 8 * 1_048_576;

#[derive(Debug, Error)]
pub enum WorkspaceFileError {
    #[error(transparent)]
    Guard(#[from] FsGuardError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("file does not exist")]
    Missing,
    #[error("path is not a regular file")]
    NotAFile,
    #[error("file is too large to open ({0} bytes; limit is 1 MB)")]
    TooLarge(u64),
    #[error("file is too large to save ({0} bytes)")]
    TooLargeToSave(usize),
    #[error("file is not text (invalid UTF-8)")]
    NotText,
    /// The frontend matches this exact string to offer reload / overwrite.
    #[error("file changed on disk")]
    Conflict,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for WorkspaceFileError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    pub path: String,
    /// `None` = clean (tracked and unchanged).
    pub status: Option<FileStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub files: Vec<TreeFile>,
    /// More than `MAX_TREE_FILES` paths; the deepest were dropped.
    pub truncated: bool,
}

/// One file's contents for the editor. `hash` (sha256 hex of the bytes) is
/// handed back on save as `expected_hash`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: String,
    pub contents: String,
    pub hash: String,
    pub size_bytes: u64,
}

pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Tracked + untracked-but-not-ignored files (`ls-files -co
/// --exclude-standard`, so `.gitignore`d build output never floods the
/// tree), each with one badge from `git status`. A tracked file deleted in
/// the worktree is still listed (badge `deleted`) so the tree shows it.
pub fn list_tree(worktree: &Path) -> Result<WorkspaceTree, GitError> {
    let listed = run_git(
        worktree,
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    )?;
    let porcelain = run_git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    )?;
    let badges: HashMap<String, FileStatus> = parse_porcelain(&porcelain)
        .into_iter()
        .filter_map(|c| badge(c.staged, c.unstaged).map(|b| (c.path, b)))
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut paths: Vec<&str> = Vec::new();
    for p in listed.split('\0') {
        // `ls-files -c` repeats a conflicted path once per stage; a nested
        // repository shows as `dir/`, which isn't a file.
        if p.is_empty() || p.ends_with('/') || !seen.insert(p) {
            continue;
        }
        paths.push(p);
    }
    let truncated = paths.len() > MAX_TREE_FILES;
    if truncated {
        // Keep the shallowest so the top of the tree is complete.
        paths.sort_by_key(|p| p.matches('/').count());
        paths.truncate(MAX_TREE_FILES);
        paths.sort_unstable();
    }
    let files = paths
        .into_iter()
        .map(|p| TreeFile {
            path: p.to_string(),
            status: badges.get(p).copied(),
        })
        .collect();
    Ok(WorkspaceTree { files, truncated })
}

/// The one badge a tree row shows: conflicts and untracked first, then the
/// working-tree change (what the editor shows), then the staged one.
fn badge(staged: FileStatus, unstaged: FileStatus) -> Option<FileStatus> {
    if staged == FileStatus::Conflicted || unstaged == FileStatus::Conflicted {
        return Some(FileStatus::Conflicted);
    }
    [unstaged, staged]
        .into_iter()
        .find(|s| *s != FileStatus::Other)
}

/// Read `rel` for the editor: confined, ≤ 1 MB, UTF-8.
pub fn read_file(worktree: &Path, rel: &str) -> Result<FileContents, WorkspaceFileError> {
    let real = resolve_in_worktree(worktree, rel)?;
    let meta = match std::fs::metadata(&real) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(WorkspaceFileError::Missing)
        }
        Err(err) => return Err(err.into()),
    };
    if !meta.is_file() {
        return Err(WorkspaceFileError::NotAFile);
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(WorkspaceFileError::TooLarge(meta.len()));
    }
    let bytes = std::fs::read(&real)?;
    let hash = content_hash(&bytes);
    let size_bytes = bytes.len() as u64;
    let contents = String::from_utf8(bytes).map_err(|_| WorkspaceFileError::NotText)?;
    Ok(FileContents {
        path: rel.trim().to_string(),
        contents,
        hash,
        size_bytes,
    })
}

/// Save `contents` to `rel` atomically and return the new hash.
///
/// `expected_hash` is the hash the editor loaded; if the file on disk no
/// longer matches it (the agent edited it meanwhile) nothing is written and
/// the error is `"file changed on disk"`. `None` writes unconditionally —
/// a brand-new file, or "overwrite anyway" after the user saw the conflict.
///
/// Temp file in the same directory + `rename`, so a reader (the agent, a
/// dev server's watcher) sees the old or the new file, never a torn one.
/// The original's permission bits are carried over (an executable script
/// stays executable).
pub fn write_file(
    worktree: &Path,
    rel: &str,
    contents: &str,
    expected_hash: Option<&str>,
) -> Result<String, WorkspaceFileError> {
    if contents.len() > MAX_WRITE_BYTES {
        return Err(WorkspaceFileError::TooLargeToSave(contents.len()));
    }
    let real = resolve_in_worktree(worktree, rel)?;
    let existing = match std::fs::metadata(&real) {
        Ok(meta) if !meta.is_file() => return Err(WorkspaceFileError::NotAFile),
        Ok(meta) => Some(meta),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    if let Some(expected) = expected_hash {
        let current = match existing {
            Some(_) => Some(content_hash(&std::fs::read(&real)?)),
            None => None,
        };
        if current.as_deref() != Some(expected) {
            return Err(WorkspaceFileError::Conflict);
        }
    }

    let dir = real.parent().ok_or(FsGuardError::Escapes)?;
    std::fs::create_dir_all(dir)?;
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.phasr-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        if let Some(meta) = &existing {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, &real)
    })();
    if let Err(err) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(content_hash(contents.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join("src/a.rs"), "a\n").unwrap();
        std::fs::write(p.join("src/b.rs"), "b\n").unwrap();
        std::fs::write(p.join("gone.txt"), "g\n").unwrap();
        std::fs::write(p.join(".gitignore"), "target/\n*.log\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn tree_lists_tracked_and_untracked_but_not_ignored_with_badges() {
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("src/a.rs"), "a2\n").unwrap(); // modified
        std::fs::write(p.join("src/new.rs"), "n\n").unwrap(); // untracked
        std::fs::write(p.join("staged.rs"), "s\n").unwrap();
        git(p, &["add", "staged.rs"]); // added
        std::fs::remove_file(p.join("gone.txt")).unwrap(); // deleted
        std::fs::create_dir_all(p.join("target")).unwrap();
        std::fs::write(p.join("target/out.bin"), "x").unwrap(); // ignored
        std::fs::write(p.join("debug.log"), "x").unwrap(); // ignored

        let tree = list_tree(p).unwrap();
        assert!(!tree.truncated);
        let by: HashMap<&str, Option<FileStatus>> =
            tree.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
        assert_eq!(by.get("src/a.rs"), Some(&Some(FileStatus::Modified)));
        assert_eq!(by.get("src/b.rs"), Some(&None), "clean file has no badge");
        assert_eq!(by.get("src/new.rs"), Some(&Some(FileStatus::Untracked)));
        assert_eq!(by.get("staged.rs"), Some(&Some(FileStatus::Added)));
        assert_eq!(by.get("gone.txt"), Some(&Some(FileStatus::Deleted)));
        assert_eq!(by.get(".gitignore"), Some(&None));
        assert!(!by.contains_key("target/out.bin"), "{by:?}");
        assert!(!by.contains_key("debug.log"), "{by:?}");
        assert!(!tree.files.iter().any(|f| f.path.starts_with(".git/")));
    }

    #[test]
    fn badge_prefers_conflict_then_worktree_change() {
        use FileStatus::*;
        assert_eq!(badge(Conflicted, Other), Some(Conflicted));
        assert_eq!(badge(Added, Modified), Some(Modified));
        assert_eq!(badge(Added, Other), Some(Added));
        assert_eq!(badge(Other, Other), None);
    }

    #[test]
    fn read_returns_contents_and_hash_and_enforces_limits() {
        let dir = repo();
        let p = dir.path();
        let file = read_file(p, "src/a.rs").unwrap();
        assert_eq!(file.contents, "a\n");
        assert_eq!(file.hash, content_hash(b"a\n"));
        assert_eq!(file.size_bytes, 2);
        assert!(matches!(read_file(p, "nope.rs"), Err(WorkspaceFileError::Missing)));
        assert!(matches!(read_file(p, "src"), Err(WorkspaceFileError::NotAFile)));
        std::fs::write(p.join("bin.dat"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(read_file(p, "bin.dat"), Err(WorkspaceFileError::NotText)));
        std::fs::write(p.join("big.txt"), vec![b'a'; MAX_READ_BYTES as usize + 1]).unwrap();
        assert!(matches!(read_file(p, "big.txt"), Err(WorkspaceFileError::TooLarge(_))));
        assert!(matches!(
            read_file(p, ".git/config"),
            Err(WorkspaceFileError::Guard(FsGuardError::GitDir))
        ));
    }

    #[test]
    fn write_checks_the_expected_hash_and_reports_a_conflict() {
        let dir = repo();
        let p = dir.path();
        let loaded = read_file(p, "src/a.rs").unwrap();
        // The agent edits the file after the editor loaded it…
        std::fs::write(p.join("src/a.rs"), "agent was here\n").unwrap();
        // …so the editor's save is refused and nothing is written.
        let err = write_file(p, "src/a.rs", "mine\n", Some(&loaded.hash)).unwrap_err();
        assert!(matches!(err, WorkspaceFileError::Conflict));
        assert_eq!(serde_json::to_value(&err).unwrap(), "file changed on disk");
        assert_eq!(std::fs::read_to_string(p.join("src/a.rs")).unwrap(), "agent was here\n");

        // With the current hash it saves, and returns the new hash.
        let current = read_file(p, "src/a.rs").unwrap();
        let hash = write_file(p, "src/a.rs", "mine\n", Some(&current.hash)).unwrap();
        assert_eq!(hash, content_hash(b"mine\n"));
        assert_eq!(std::fs::read_to_string(p.join("src/a.rs")).unwrap(), "mine\n");
        // An expected hash for a file that doesn't exist is a conflict too.
        assert!(matches!(
            write_file(p, "src/vanished.rs", "x", Some(&hash)),
            Err(WorkspaceFileError::Conflict)
        ));
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(p.join("src"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("phasr-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_creates_new_files_and_refuses_guarded_paths() {
        let dir = repo();
        let p = dir.path();
        write_file(p, "docs/new/readme.md", "# hi\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(p.join("docs/new/readme.md")).unwrap(), "# hi\n");
        assert!(matches!(
            write_file(p, ".git/hooks/pre-commit", "evil", None),
            Err(WorkspaceFileError::Guard(FsGuardError::GitDir))
        ));
        assert!(matches!(
            write_file(p, "../escape.txt", "evil", None),
            Err(WorkspaceFileError::Guard(FsGuardError::ParentTraversal))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_the_files_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("run.sh"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        write_file(p, "run.sh", "#!/bin/sh\necho hi\n", None).unwrap();
        let mode = std::fs::metadata(p.join("run.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}
